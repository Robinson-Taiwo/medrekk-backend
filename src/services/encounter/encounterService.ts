import type { EncounterRepository } from "../../database/encounterRepository.js";
import type { Repositories } from "../../database/repositories.js";
import type { Encounter } from "../../shared/encounterTypes.js";
import type {
  CaptureEncounterInput, EncounterDraftInput, EncounterReviewInput,
} from "../../shared/encounterValidation.js";
import type { AccessSession, AuditType, ClinicalClaim } from "../../shared/types.js";
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

  /** The worker's corrected list becomes claims. Nothing reaches the record before this. */
  async review(token: string, workerUserId: string, encounterId: string, input: EncounterReviewInput) {
    const found = await this.load(token, workerUserId, encounterId);
    if (found.status === "REVIEWED") {
      throw new AppError(409, "ENCOUNTER_REVIEWED", "This encounter has already been reviewed.");
    }
    const source = found.workerFacility ? `${found.workerName}, ${found.workerFacility}` : found.workerName;
    const createdClaimIds: string[] = [];
    for (const item of input.items) {
      const claim: ClinicalClaim = {
        id: newId("clm"),
        patientId: found.patientId,
        category: item.category,
        value: item.value,
        status: "UNVERIFIED",
        source,
        lastConfirmedAt: this.iso(),
      };
      await this.deps.repos.records.add(claim);
      createdClaimIds.push(claim.id);
    }
    const updated: Encounter = {
      ...found,
      status: "REVIEWED",
      reviewedAt: this.iso(),
      createdClaimIds,
    };
    await this.deps.encounters.update(updated);
    await this.audit(updated, "ENCOUNTER_REVIEWED", [...new Set(input.items.map((i) => i.category))]);
    return updated;
  }

  get(token: string, workerUserId: string, encounterId: string) {
    return this.load(token, workerUserId, encounterId);
  }
}
