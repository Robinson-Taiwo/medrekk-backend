import type { Repositories } from "../../database/repositories.js";
import type { ClinicalClaim, EmergencyProfile, Evidence, Patient } from "../../shared/types.js";
import type { EmergencyProfileInput, PatientEvidenceInput, SelfClaimInput } from "../../shared/validation.js";
import { AppError } from "../../utils/errors.js";
import { generateMedRekkCode, newId } from "../../utils/ids.js";
import type { Gender, PatientProfile, ProfileUpdateInput } from "../../shared/profile.js";

const MAX_CODE_ATTEMPTS = 10;

type PublicClaim = Omit<ClinicalClaim, "patientId">;
type PublicEmergencyProfile = Omit<EmergencyProfile, "patientId">;

const publicClaim = ({ patientId: _patientId, ...rest }: ClinicalClaim): PublicClaim => rest;
const publicProfile = ({ patientId: _patientId, ...rest }: EmergencyProfile): PublicEmergencyProfile => rest;

export class PatientService {
  constructor(
    private readonly repos: Pick<Repositories, "patients" | "emergency" | "records" | "profiles" | "audit" | "evidence">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  /** Creates a real patient row, a unique MedRekk Code and an empty emergency profile. */
  async provision(fullName: string): Promise<Patient> {
    let code: string | undefined;
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const candidate = generateMedRekkCode();
      if (!(await this.repos.patients.findByCode(candidate))) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new AppError(500, "CODE_GENERATION_FAILED", "Could not allocate a MedRekk Code. Try again.");

    const patient: Patient = {
      id: newId("pat"),
      medrekkCode: code,
      fullName,
      createdAt: this.now().toISOString(),
    };
    await this.repos.patients.create(patient);
    await this.repos.emergency.save({
      patientId: patient.id,
      criticalAllergies: [],
      criticalConditions: [],
      criticalMedications: [],
      implantedDevices: [],
      importantWarnings: [],
      verificationStatus: "UNVERIFIED",
    });
    return patient;
  }

  async me(patientId: string): Promise<{ fullName: string; medrekkCode: string; createdAt: string }> {
    const p = await this.repos.patients.findById(patientId);
    if (!p) throw new AppError(404, "PATIENT_NOT_FOUND", "Patient record not found.");
    return { fullName: p.fullName, medrekkCode: p.medrekkCode, createdAt: p.createdAt };
  }

  /**
   * The patient owns their record, so they can always remove an item. What differs is how:
   * something they entered themselves is deleted outright, since nobody else relied on it.
   * Something a worker or clinician recorded is marked removed instead: it leaves the record and
   * everything shared from it, while the audit keeps that an item existed and was removed. The
   * value itself is never written to the audit.
   */
  async removeClaim(patientId: string, claimId: string): Promise<{ removed: "DELETED" | "HIDDEN" }> {
    const claim = await this.repos.records.findById(claimId);
    if (!claim || claim.patientId !== patientId || claim.removedAt) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "Claim not found.");
    }

    const selfEntered = claim.status === "SELF_REPORTED" || claim.status === "UNVERIFIED";
    const at = this.iso();

    await this.repos.records.update({ ...claim, removedAt: at });

    // An allergy the patient put on their emergency card comes off with it. Leaving it there
    // would show a stranger something the record no longer holds.
    if (claim.category === "ALLERGIES" && claim.emergencyDecision === "ADDED") {
      const profile = await this.repos.emergency.profileFor(patientId);
      if (profile) {
        await this.repos.emergency.save({
          ...profile,
          criticalAllergies: profile.criticalAllergies.filter((entry: string) => entry !== claim.value),
          lastConfirmedAt: at,
        });
      }
    }

    await this.repos.audit.append({
      id: newId("aud"),
      patientId,
      type: "CLAIM_REMOVED",
      accessType: "NORMAL",
      occurredAt: at,
      requesterIdentifier: "You",
      informationViewed: [claim.category],
    });

    return { removed: selfEntered ? "DELETED" : "HIDDEN" };
  }

  /**
   * The emergency card is the one part of the record a stranger can read without being approved,
   * so nothing reaches it unless the patient puts it there. A worker recording an allergy creates
   * a claim; only this makes it visible on the card.
   */
  async decideEmergencyCard(patientId: string, claimId: string, add: boolean): Promise<PublicClaim> {
    const claim = await this.repos.records.findById(claimId);
    if (!claim || claim.patientId !== patientId || claim.removedAt) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "Claim not found.");
    }
    if (claim.category !== "ALLERGIES") {
      throw new AppError(400, "NOT_AN_ALLERGY", "Only an allergy can be added to the emergency card.");
    }

    const at = this.iso();
    const profile = await this.repos.emergency.profileFor(patientId);
    if (!profile) throw new AppError(404, "PROFILE_NOT_FOUND", "Emergency profile not found.");

    const without = profile.criticalAllergies.filter((entry: string) => entry !== claim.value);
    const criticalAllergies = add ? [...without, claim.value] : without;

    await this.repos.emergency.save({ ...profile, criticalAllergies, lastConfirmedAt: at });

    const updated = { ...claim, emergencyDecision: add ? ("ADDED" as const) : ("DECLINED" as const) };
    await this.repos.records.update(updated);

    await this.repos.audit.append({
      id: newId("aud"),
      patientId,
      type: "EMERGENCY_CARD_UPDATED",
      accessType: "NORMAL",
      occurredAt: at,
      requesterIdentifier: "You",
      informationViewed: ["ALLERGIES"],
    });

    return publicClaim(updated);
  }

  /**
   * The patient attaching a document to their own entry — a photograph of a prescription, a
   * lab printout, an old discharge note.
   *
   * This deliberately does NOT raise the claim's status. A worker attaching evidence lifts a
   * claim to EVIDENCE_BACKED because a second person has looked at the paper; a patient
   * attaching their own cannot, or every claim would corroborate itself and the whole
   * standing system would mean nothing. What it does do is put the document in front of the
   * next clinician, with where it says it came from and how the text was read, so the
   * confirmation they give is a real one rather than a guess.
   *
   * The image stays on the phone. Only its hash travels, which is enough to prove later that
   * the copy the patient still holds is the one that was reviewed.
   */
  async addSelfEvidence(patientId: string, claimId: string, input: PatientEvidenceInput): Promise<Evidence> {
    const claim = await this.repos.records.findById(claimId);
    if (!claim || claim.patientId !== patientId || claim.removedAt) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "That entry is not in your record.");
    }
    const patient = await this.repos.patients.findById(patientId);
    const at = this.iso();
    const evidence: Evidence = {
      id: newId("evd"),
      patientId,
      claimId: claim.id,
      kind: input.kind,
      description: input.description,
      addedByUserId: patientId,
      addedByName: patient?.fullName ?? "Patient",
      createdAt: at,
      captureMethod: input.captureMethod,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.imageHash ? { imageHash: input.imageHash } : {}),
    };
    await this.repos.evidence.add(evidence);

    // The link is recorded so the document is findable, but status and verificationMethod are
    // left exactly as they were.
    await this.repos.records.update({ ...claim, evidenceId: evidence.id });

    await this.repos.audit.append({
      id: newId("aud"),
      patientId,
      type: "EVIDENCE_ADDED",
      accessType: "NORMAL",
      occurredAt: at,
      requesterIdentifier: `${patient?.fullName ?? "Patient"} (PATIENT)`,
      informationViewed: [claim.category],
      reason: `Document attached by the patient: ${input.kind}`,
    });
    return evidence;
  }

  async listSelfEvidence(patientId: string, claimId: string): Promise<Evidence[]> {
    const claim = await this.repos.records.findById(claimId);
    if (!claim || claim.patientId !== patientId) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "That entry is not in your record.");
    }
    return this.repos.evidence.listForClaim(claimId);
  }

  async listClaims(patientId: string): Promise<PublicClaim[]> {
    return (await this.repos.records.allFor(patientId)).map(publicClaim);
  }

  /** Patient-entered information is always SELF_REPORTED; the client cannot choose a stronger status. */
  async addSelfClaim(patientId: string, input: SelfClaimInput): Promise<PublicClaim> {
    const claim: ClinicalClaim = {
      id: newId("clm"),
      patientId,
      category: input.category,
      value: input.value,
      status: "SELF_REPORTED",
      source: "Patient",
      lastConfirmedAt: this.now().toISOString(),
    };
    await this.repos.records.add(claim);
    return publicClaim(claim);
  }

  async getProfile(patientId: string): Promise<{ dateOfBirth: string | null; gender: Gender | null }> {
    const p = await this.repos.patients.findById(patientId);
    if (!p) throw new AppError(404, "PATIENT_NOT_FOUND", "Patient record not found.");
    const profile = await this.repos.profiles.get(patientId);
    return { dateOfBirth: profile?.dateOfBirth ?? null, gender: profile?.gender ?? null };
  }

  /** Patient-entered basics. Merges with what is stored. Neither field is clinical. */
  async updateProfile(
    patientId: string,
    input: ProfileUpdateInput,
  ): Promise<{ dateOfBirth: string | null; gender: Gender | null }> {
    const p = await this.repos.patients.findById(patientId);
    if (!p) throw new AppError(404, "PATIENT_NOT_FOUND", "Patient record not found.");
    if (input.dateOfBirth !== undefined) {
      const born = Date.parse(input.dateOfBirth + "T00:00:00Z");
      if (born > this.now().getTime() || input.dateOfBirth < "1900-01-01") {
        throw new AppError(400, "INVALID_DATE_OF_BIRTH", "Date of birth must be a past date.");
      }
    }
    const existing = await this.repos.profiles.get(patientId);
    const dateOfBirth = input.dateOfBirth ?? existing?.dateOfBirth;
    const gender = input.gender ?? existing?.gender;
    const profile: PatientProfile = {
      ...(dateOfBirth ? { dateOfBirth } : {}),
      ...(gender ? { gender } : {}),
      updatedAt: this.now().toISOString(),
    };
    await this.repos.profiles.save(patientId, profile);
    return { dateOfBirth: profile.dateOfBirth ?? null, gender: profile.gender ?? null };
  }

  async getEmergencyProfile(patientId: string): Promise<PublicEmergencyProfile> {
    const profile = await this.repos.emergency.profileFor(patientId);
    if (!profile) throw new AppError(404, "PROFILE_NOT_FOUND", "Emergency profile not found.");
    return publicProfile(profile);
  }

  async updateEmergencyProfile(patientId: string, input: EmergencyProfileInput): Promise<PublicEmergencyProfile> {
    const profile: EmergencyProfile = {
      patientId,
      criticalAllergies: input.criticalAllergies,
      criticalConditions: input.criticalConditions,
      criticalMedications: input.criticalMedications,
      implantedDevices: input.implantedDevices,
      importantWarnings: input.importantWarnings,
      verificationStatus: "SELF_REPORTED",
      lastConfirmedAt: this.now().toISOString(),
      ...(input.bloodGroup ? { bloodGroup: input.bloodGroup } : {}),
      ...(input.emergencyContact ? { emergencyContact: input.emergencyContact } : {}),
    };
    await this.repos.emergency.save(profile);
    return publicProfile(profile);
  }
}