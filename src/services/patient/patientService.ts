import type { Repositories } from "../../database/repositories.js";
import type { ClinicalClaim, EmergencyProfile, Patient } from "../../shared/types.js";
import type { EmergencyProfileInput, SelfClaimInput } from "../../shared/validation.js";
import { AppError } from "../../utils/errors.js";
import { generateMedRekkCode, newId } from "../../utils/ids.js";

const MAX_CODE_ATTEMPTS = 10;

type PublicClaim = Omit<ClinicalClaim, "patientId">;
type PublicEmergencyProfile = Omit<EmergencyProfile, "patientId">;

const publicClaim = ({ patientId: _patientId, ...rest }: ClinicalClaim): PublicClaim => rest;
const publicProfile = ({ patientId: _patientId, ...rest }: EmergencyProfile): PublicEmergencyProfile => rest;

export class PatientService {
  constructor(
    private readonly repos: Pick<Repositories, "patients" | "emergency" | "records">,
    private readonly now: () => Date = () => new Date(),
  ) {}

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