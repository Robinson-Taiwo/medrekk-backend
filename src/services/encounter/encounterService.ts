import type { EncounterRepository } from "../../database/encounterRepository.js";
import type { Repositories } from "../../database/repositories.js";
import type { Encounter } from "../../shared/encounterTypes.js";
import type {
  CaptureEncounterInput, EncounterDraftInput, EncounterReviewInput, SelfEntryInput,
} from "../../shared/encounterValidation.js";
import type { AccessSession, AuditType, ClinicalClaim, Evidence } from "../../shared/types.js";
import { AppError } from "../../utils/errors.js";
import { hashToken, newId } from "../../utils/ids.js";

export interface EncounterDeps {
  repos: Repositories;
  encounters: EncounterRepository;
  now: () => Date;
}

export class EncounterService {
  constructor(private readonly deps: EncounterDeps) {}

  private iso(): string {
    return this.deps.now().toISOString();
  }

  /**
   * A worker may only record against a session this same worker requested and the patient approved,
   * with the RECENT_ENCOUNTERS scope. That approval is the patient's consent; no separate step is needed.
   */
  private async session(token: string, workerUserId: string): Promise<AccessSession> {
    const found = await this.deps.repos.sessions.findByTokenHash(hashToken(token));
    if (!found) throw new AppError(404, "SESSION_NOT_FOUND", "Access session not found.");
    const live =
      found.status === "APPROVED" &&
      found.grantedUntil !== undefined &&
      Date.parse(found.grantedUntil) > this.deps.now().getTime();
    if (!live) throw new AppError(403, "ACCESS_NOT_ACTIVE", "This access is not active.");
    if (!found.requesterUserId || found.requesterUserId !== workerUserId) {
      throw new AppError(403, "NOT_SESSION_REQUESTER", "This access belongs to another health worker.");
    }
    if (!found.approvedScopes.includes("RECENT_ENCOUNTERS")) {
      throw new AppError(403, "SCOPE_NOT_APPROVED", "The patient has not approved recording encounters.");
    }
    return found;
  }

  private async audit(e: Encounter, type: AuditType, categories: string[]): Promise<void> {
    await this.deps.repos.audit.append({
      id: newId("aud"),
      patientId: e.patientId,
      type,
      accessType: "NORMAL",
      occurredAt: this.iso(),
      sessionId: e.sessionId,
      requesterIdentifier: e.workerFacility ? `${e.workerName}, ${e.workerFacility}` : e.workerName,
      informationViewed: categories,
    });
  }

  private async load(token: string, workerUserId: string, encounterId: string): Promise<Encounter> {
    const session = await this.session(token, workerUserId);
    const found = await this.deps.encounters.findById(encounterId);
    if (!found || found.sessionId !== session.id) {
      throw new AppError(404, "ENCOUNTER_NOT_FOUND", "Encounter not found.");
    }
    return found;
  }

  async capture(token: string, workerUserId: string, input: CaptureEncounterInput) {
    const session = await this.session(token, workerUserId);
    const encounter: Encounter = {
      id: newId("enc"),
      patientId: session.patientId,
      sessionId: session.id,
      workerUserId,
      workerName: session.requester?.name ?? "Health worker",
      workerFacility: session.requester?.facility ?? null,
      captureMethod: input.captureMethod,
      rawInput: input.rawInput,
      draftSource: null,
      draft: [],
      status: "CAPTURED",
      createdAt: this.iso(),
      createdClaimIds: [],
    };
    await this.deps.encounters.create(encounter);
    await this.audit(encounter, "ENCOUNTER_RECORDED", []);
    return encounter;
  }

  /** Stores a draft for review. A draft is never a medical fact. */
  async saveDraft(token: string, workerUserId: string, encounterId: string, input: EncounterDraftInput) {
    const found = await this.load(token, workerUserId, encounterId);
    if (found.status === "REVIEWED") {
      throw new AppError(409, "ENCOUNTER_REVIEWED", "This encounter has already been reviewed.");
    }
    const updated: Encounter = {
      ...found,
      draft: input.items,
      draftSource: input.source,
      status: "STRUCTURED",
      structuredAt: this.iso(),
    };
    await this.deps.encounters.update(updated);
    return updated;
  }

  /**
   * The worker's corrected list becomes claims. Each claim keeps an ORIGINAL_CAPTURE evidence row
   * holding the words it came from, so the record can always be traced back to what was said.
   * That evidence is provenance, not corroboration: claims still start UNVERIFIED.
   */
  async review(token: string, workerUserId: string, encounterId: string, input: EncounterReviewInput) {
    const found = await this.load(token, workerUserId, encounterId);
    if (found.status === "REVIEWED") {
      throw new AppError(409, "ENCOUNTER_REVIEWED", "This encounter has already been reviewed.");
    }
    const source = found.workerFacility ? `${found.workerName}, ${found.workerFacility}` : found.workerName;
    const at = this.iso();
    const createdClaimIds: string[] = [];

    for (const item of input.items) {
      const claimId = newId("clm");
      const evidence: Evidence = {
        id: newId("evi"),
        patientId: found.patientId,
        claimId,
        kind: "ORIGINAL_CAPTURE",
        description: item.excerpt && item.excerpt.length > 0 ? item.excerpt : found.rawInput.slice(0, 500),
        addedByUserId: found.workerUserId,
        addedByName: source,
        createdAt: at,
      };
      const claim: ClinicalClaim = {
        id: claimId,
        patientId: found.patientId,
        category: item.category,
        value: item.value,
        status: "UNVERIFIED",
        source,
        lastConfirmedAt: at,
        evidenceId: evidence.id,
        encounterId: found.id,
      };
      await this.deps.repos.records.add(claim);
      await this.deps.repos.evidence.add(evidence);
      createdClaimIds.push(claimId);
    }

    const updated: Encounter = { ...found, status: "REVIEWED", reviewedAt: at, createdClaimIds };
    await this.deps.encounters.update(updated);
    await this.audit(updated, "ENCOUNTER_REVIEWED", [...new Set(input.items.map((i) => i.category))]);
    return updated;
  }

  /**
   * Abandoning a draft before review. The row stays so the access is still accounted for, and the
   * patient's history shows that a note was started and dropped. After review the claims exist and
   * belong to the patient, so this is refused: that would be deleting their record, not a draft.
   */
  async discard(token: string, workerUserId: string, encounterId: string) {
    const found = await this.load(token, workerUserId, encounterId);
    if (found.status === "REVIEWED") {
      throw new AppError(409, "ENCOUNTER_REVIEWED", "This encounter was already saved to the record.");
    }
    if (found.status === "DISCARDED") return found;

    const updated: Encounter = { ...found, status: "DISCARDED" };
    await this.deps.encounters.update(updated);
    await this.audit(updated, "ENCOUNTER_DISCARDED", []);
    return updated;
  }

  get(token: string, workerUserId: string, encounterId: string) {
    return this.load(token, workerUserId, encounterId);
  }

  /** The patient's own provenance view: what was originally said behind one of their claims. */
  /**
   * A patient recording a document they already hold: an old lab report, a prescription,
   * a discharge summary. Stored as an encounter so it lands in the visit view the app
   * already has, which means the capture needs no new reading screen and the note runs
   * through the same explanation templates a worker's note does.
   *
   * Three deliberate differences from a worker's encounter:
   *
   * - It is REVIEWED on arrival. A worker's draft needs review because a model wrote it
   *   and a second pair of eyes must confirm. A patient confirming their own entry on the
   *   device IS that step, and encounterForPatient only returns reviewed encounters.
   * - Claims are SELF_REPORTED, not UNVERIFIED. The patient is asserting these, which is
   *   a different thing from nobody having checked them.
   * - `source` stays "Patient". The facility printed on the paper goes on the evidence as
   *   `origin`, never into `source`, because a hospital named on a document the patient
   *   uploaded has not vouched for anything. Promotion to EVIDENCE_BACKED stays where it
   *   was: a health worker looking at the document and agreeing.
   */
  async selfRecord(patientId: string, userId: string, input: SelfEntryInput) {
    const patient = await this.deps.repos.patients.findById(patientId);
    if (!patient) throw new AppError(404, "PATIENT_NOT_FOUND", "Patient record not found.");

    const at = this.iso();
    const encounterId = newId("enc");
    const createdClaimIds: string[] = [];

    for (const item of input.items) {
      const claimId = newId("clm");
      const evidence: Evidence = {
        id: newId("evi"),
        patientId,
        claimId,
        kind: input.evidenceKind,
        description: item.excerpt && item.excerpt.length > 0 ? item.excerpt : input.note.slice(0, 500),
        addedByUserId: userId,
        addedByName: patient.fullName,
        createdAt: at,
        captureMethod: input.textSource,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.imageHash ? { imageHash: input.imageHash } : {}),
      };
      const claim: ClinicalClaim = {
        id: claimId,
        patientId,
        category: item.category,
        value: item.value,
        status: "SELF_REPORTED",
        source: "Patient",
        lastConfirmedAt: at,
        evidenceId: evidence.id,
        encounterId,
      };
      await this.deps.repos.records.add(claim);
      await this.deps.repos.evidence.add(evidence);
      createdClaimIds.push(claimId);
    }

    const encounter: Encounter = {
      id: encounterId,
      patientId,
      authoredBy: "PATIENT",
      // The worker* fields carry the patient's own identity here; authoredBy is the
      // discriminator, so one encounter shape serves both paths.
      workerUserId: userId,
      workerName: patient.fullName,
      workerFacility: null,
      captureMethod: input.captureMethod,
      rawInput: input.note,
      draftSource: null,
      draft: [],
      status: "REVIEWED",
      createdAt: at,
      reviewedAt: at,
      createdClaimIds,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.imageHash ? { imageHash: input.imageHash } : {}),
    };
    await this.deps.encounters.create(encounter);
    await this.audit(encounter, "ENCOUNTER_RECORDED", [...new Set(input.items.map((i) => i.category))]);
    return encounter;
  }

  async originFor(patientId: string, claimId: string) {
    const claim = await this.deps.repos.records.findById(claimId);
    if (!claim || claim.patientId !== patientId) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "Claim not found.");
    }
    const rows = await this.deps.repos.evidence.listForClaim(claimId);
    return rows.map(({ patientId: _omit, ...rest }) => rest);
  }

  /**
   * The patient's own view of a visit. Only reviewed encounters are returned: before review nothing
   * from the note is on their record, and a half-written note would mislead rather than inform.
   * The draft, the review decisions and the worker's user id stay out of the response.
   */
  async encounterForPatient(patientId: string, encounterId: string) {
    const found = await this.deps.encounters.findById(encounterId);
    if (!found || found.patientId !== patientId || found.status !== "REVIEWED") {
      throw new AppError(404, "ENCOUNTER_NOT_FOUND", "Visit not found.");
    }
    return {
      id: found.id,
      rawInput: found.rawInput,
      recordedByName: found.workerName,
      recordedByFacility: found.workerFacility,
      recordedAt: found.reviewedAt ?? found.createdAt,
      status: found.status,
      /** Lets the screen say "Added by you from a document" rather than naming a recorder. */
      authoredBy: found.authoredBy ?? "WORKER",
      captureMethod: found.captureMethod,
      ...(found.origin ? { origin: found.origin } : {}),
      ...(found.imageHash ? { imageHash: found.imageHash } : {}),
    };
  }
}
