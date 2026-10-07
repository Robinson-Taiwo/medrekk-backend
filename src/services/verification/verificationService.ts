import type { User, UserRepository } from "../../auth/userRepository.js";
import type { Repositories } from "../../database/repositories.js";
import type {
  AccessSession, ClinicalClaim, EmergencyProfile, Evidence, VerificationEvent, VerificationStatus,
} from "../../shared/types.js";
import type {
  AddEvidenceInput, VerifyClaimInput, VerifyProfileInput,
} from "../../shared/verificationValidation.js";
import { AppError } from "../../utils/errors.js";
import { newId } from "../../utils/ids.js";
import type { AccessService } from "../access/accessService.js";

export interface VerificationDeps {
  repos: Repositories;
  users: UserRepository;
  access: AccessService;
  now: () => Date;
}

type PublicClaim = Omit<ClinicalClaim, "patientId">;
type PublicEvent = Omit<VerificationEvent, "patientId">;
type PublicEvidence = Omit<Evidence, "patientId">;
type PublicProfile = Omit<EmergencyProfile, "patientId">;

const publicClaim = ({ patientId: _patientId, ...rest }: ClinicalClaim): PublicClaim => rest;
const publicEvent = ({ patientId: _patientId, ...rest }: VerificationEvent): PublicEvent => rest;
const publicEvidence = ({ patientId: _patientId, ...rest }: Evidence): PublicEvidence => rest;
const publicProfile = ({ patientId: _patientId, ...rest }: EmergencyProfile): PublicProfile => rest;

export class VerificationService {
  constructor(private readonly deps: VerificationDeps) {}

  private get repos() { return this.deps.repos; }
  private iso(): string { return this.deps.now().toISOString(); }

  private async worker(workerUserId: string): Promise<User> {
    const worker = await this.deps.users.findById(workerUserId);
    if (!worker || worker.role !== "HEALTH_WORKER") {
      throw new AppError(403, "FORBIDDEN", "No health worker account found.");
    }
    return worker;
  }

  /** Session must be approved and requested by this worker; the claim must sit inside the approved scopes. */
  private async context(
    workerUserId: string, sessionToken: string, claimId: string,
  ): Promise<{ session: AccessSession; claim: ClinicalClaim; worker: User }> {
    const session = await this.deps.access.authorizeVerifier(sessionToken, workerUserId);
    const worker = await this.worker(workerUserId);
    const claim = await this.repos.records.findById(claimId);
    if (!claim || claim.patientId !== session.patientId || !session.approvedScopes.includes(claim.category)) {
      throw new AppError(404, "CLAIM_NOT_FOUND", "Claim not found in the approved scopes.");
    }
    return { session, claim, worker };
  }

  private async recordChange(
    worker: User, session: AccessSession, claim: ClinicalClaim, resulting: VerificationStatus, method: string, at: string,
  ): Promise<VerificationEvent> {
    const event: VerificationEvent = {
      id: newId("ver"),
      patientId: claim.patientId,
      claimId: claim.id,
      subject: "CLAIM",
      verifierUserId: worker.id,
      verifierName: worker.fullName,
      verifierFacility: worker.facility,
      method,
      previousStatus: claim.status,
      resultingStatus: resulting,
      credentialApproved: worker.credentialStatus === "APPROVED",
      verifiedAt: at,
    };
    await this.repos.verifications.append(event);
    void session;
    return event;
  }

  /** Any health worker in an approved session can attach evidence. It can lift a claim to EVIDENCE_BACKED, never higher. */
  async addEvidence(workerUserId: string, sessionToken: string, claimId: string, input: AddEvidenceInput) {
    const { session, claim, worker } = await this.context(workerUserId, sessionToken, claimId);
    const at = this.iso();
    const evidence: Evidence = {
      id: newId("evd"),
      patientId: claim.patientId,
      claimId: claim.id,
      kind: input.kind,
      description: input.description,
      addedByUserId: worker.id,
      addedByName: worker.fullName,
      createdAt: at,
    };
    await this.repos.evidence.add(evidence);

    const upgrade = claim.status === "UNVERIFIED" || claim.status === "SELF_REPORTED";
    const updated: ClinicalClaim = { ...claim, evidenceId: evidence.id };
    let event: VerificationEvent | undefined;
    if (upgrade) {
      updated.status = "EVIDENCE_BACKED";
      updated.verificationMethod = `Evidence attached: ${input.kind}`;
      updated.verifiedAt = at;
      event = await this.recordChange(worker, session, claim, "EVIDENCE_BACKED", updated.verificationMethod, at);
    }
    await this.repos.records.update(updated);
    await this.repos.audit.append({
      id: newId("aud"),
      patientId: claim.patientId,
      type: "EVIDENCE_ADDED",
      accessType: "NORMAL",
      occurredAt: at,
      sessionId: session.id,
      requesterIdentifier: `${worker.fullName} (HEALTH_WORKER)`,
      informationViewed: [claim.category],
      reason: `Evidence: ${input.kind}`,
    });
    return {
      claim: publicClaim(updated),
      evidence: publicEvidence(evidence),
      ...(event ? { event: publicEvent(event) } : {}),
    };
  }

  /** CLINICALLY_VERIFIED requires an APPROVED credential. The claim's value is never edited here. */
  async verifyClaim(workerUserId: string, sessionToken: string, claimId: string, input: VerifyClaimInput) {
    const { session, claim, worker } = await this.context(workerUserId, sessionToken, claimId);
    if (worker.credentialStatus !== "APPROVED") {
      throw new AppError(403, "CREDENTIAL_NOT_APPROVED", "Your health worker credential has not been approved yet.");
    }
    if (claim.status === "CLINICALLY_VERIFIED") {
      throw new AppError(409, "ALREADY_VERIFIED", "This claim is already clinically verified.");
    }
    const at = this.iso();
    const updated: ClinicalClaim = {
      ...claim,
      status: "CLINICALLY_VERIFIED",
      verificationMethod: input.method,
      verifiedAt: at,
      lastConfirmedAt: at,
    };
    const event = await this.recordChange(worker, session, claim, "CLINICALLY_VERIFIED", input.method, at);
    await this.repos.records.update(updated);
    await this.repos.audit.append({
      id: newId("aud"),
      patientId: claim.patientId,
      type: "CLAIM_VERIFIED",
      accessType: "NORMAL",
      occurredAt: at,
      sessionId: session.id,
      requesterIdentifier: `${worker.fullName} (HEALTH_WORKER)`,
      informationViewed: [claim.category],
      reason: `Verified: ${input.method}`,
    });
    return { claim: publicClaim(updated), event: publicEvent(event) };
  }

  // ---- emergency profile ----

  /** The session must be approved, requested by this worker, and include EMERGENCY_INFORMATION. */
  private async profileContext(
    workerUserId: string, sessionToken: string,
  ): Promise<{ session: AccessSession; profile: EmergencyProfile; worker: User }> {
    const session = await this.deps.access.authorizeVerifier(sessionToken, workerUserId);
    if (!session.approvedScopes.includes("EMERGENCY_INFORMATION")) {
      throw new AppError(403, "SCOPE_NOT_APPROVED", "The patient did not approve emergency information for this session.");
    }
    const worker = await this.worker(workerUserId);
    const profile = await this.repos.emergency.profileFor(session.patientId);
    if (!profile) throw new AppError(404, "PROFILE_NOT_FOUND", "Emergency profile not found.");
    return { session, profile, worker };
  }

  /** Lets an approved worker review what they are about to verify. Each review is audited. */
  async getProfileForReview(workerUserId: string, sessionToken: string): Promise<PublicProfile> {
    const { session, profile, worker } = await this.profileContext(workerUserId, sessionToken);
    await this.repos.audit.append({
      id: newId("aud"),
      patientId: session.patientId,
      type: "RECORD_VIEWED",
      accessType: "NORMAL",
      occurredAt: this.iso(),
      sessionId: session.id,
      requesterIdentifier: `${worker.fullName} (HEALTH_WORKER)`,
      informationViewed: ["EMERGENCY_INFORMATION"],
      reason: "Emergency profile review",
    });
    return publicProfile(profile);
  }

  async verifyEmergencyProfile(workerUserId: string, sessionToken: string, input: VerifyProfileInput) {
    const { session, profile, worker } = await this.profileContext(workerUserId, sessionToken);
    const approved = worker.credentialStatus === "APPROVED";

    if (input.level === "CLINICALLY_VERIFIED") {
      if (!approved) {
        throw new AppError(403, "CREDENTIAL_NOT_APPROVED", "Your health worker credential has not been approved yet.");
      }
      if (profile.verificationStatus === "CLINICALLY_VERIFIED") {
        throw new AppError(409, "ALREADY_VERIFIED", "This profile is already clinically verified.");
      }
    } else if (profile.verificationStatus !== "UNVERIFIED" && profile.verificationStatus !== "SELF_REPORTED") {
      throw new AppError(409, "ALREADY_VERIFIED", "This profile already has a higher verification status.");
    }

    const at = this.iso();
    const updated: EmergencyProfile = {
      ...profile,
      verificationStatus: input.level,
      verificationMethod: input.method,
      verifiedAt: at,
      verifiedByName: worker.fullName,
      verifiedByFacility: worker.facility,
      lastConfirmedAt: at,
    };
    const event: VerificationEvent = {
      id: newId("ver"),
      patientId: profile.patientId,
      subject: "EMERGENCY_PROFILE",
      verifierUserId: worker.id,
      verifierName: worker.fullName,
      verifierFacility: worker.facility,
      method: input.method,
      previousStatus: profile.verificationStatus,
      resultingStatus: input.level,
      credentialApproved: approved,
      verifiedAt: at,
    };
    await this.repos.verifications.append(event);
    await this.repos.emergency.save(updated);
    await this.repos.audit.append({
      id: newId("aud"),
      patientId: profile.patientId,
      type: "EMERGENCY_PROFILE_VERIFIED",
      accessType: "NORMAL",
      occurredAt: at,
      sessionId: session.id,
      requesterIdentifier: `${worker.fullName} (HEALTH_WORKER)`,
      informationViewed: ["EMERGENCY_INFORMATION"],
      reason: `Verified: ${input.method}`,
    });
    return { profile: publicProfile(updated), event: publicEvent(event) };
  }

  /** Patient side: who verified what, how, and when. */
  async listForPatient(patientId: string): Promise<PublicEvent[]> {
    return (await this.repos.verifications.listForPatient(patientId)).map(publicEvent);
  }
}
