import type {
  AccessScope, AccessSession, AccessStatus, AuditEvent, AuditType, ClinicalClaim,
} from "../../shared/types.js";
import type { AccessDecisionInput, AccessLookupInput, AccessRequestInput } from "../../shared/validation.js";
import type { Repositories } from "../../database/repositories.js";
import { AppError } from "../../utils/errors.js";
import { hashToken, newAccessToken, newId, normalizeName } from "../../utils/ids.js";

const SESSION_LIFETIME_MS = 30 * 60 * 1000;

export interface AccessDeps {
  repos: Repositories;
  now: () => Date;
}

export class AccessService {
  constructor(private readonly deps: AccessDeps) { }

  private get repos() { return this.deps.repos; }
  private iso(offsetMs = 0): string { return new Date(this.deps.now().getTime() + offsetMs).toISOString(); }

  private async audit(session: AccessSession, type: AuditType, extra: Partial<AuditEvent> = {}): Promise<void> {
    await this.repos.audit.append({
      id: newId("aud"),
      patientId: session.patientId,
      type,
      accessType: "NORMAL",
      occurredAt: this.iso(),
      sessionId: session.id,
      requesterIdentifier: session.requester
        ? `${session.requester.name} (${session.requester.role})${session.requester.facility ? `, ${session.requester.facility}` : ""}`
        : undefined,
      reason: session.requester?.reason,
      ...extra,
    });
  }

  /** Code + name -> opaque session token. Same generic error for wrong code or wrong name (no enumeration). */
  async startSession(input: AccessLookupInput) {
    const patient = await this.repos.patients.findByCode(input.medrekkCode);
    if (!patient || normalizeName(patient.fullName) !== normalizeName(input.patientName)) {
      throw new AppError(404, "RECORD_NOT_FOUND", "No matching record found.");
    }
    const token = newAccessToken();
    const session: AccessSession = {
      id: newId("ses"),
      tokenHash: hashToken(token),
      patientId: patient.id,
      status: "AWAITING_REQUEST",
      requestedScopes: [],
      approvedScopes: [],
      createdAt: this.iso(),
      expiresAt: this.iso(SESSION_LIFETIME_MS),
    };
    await this.repos.sessions.create(session);
    await this.audit(session, "ACCESS_SESSION_STARTED");
    return { session: token, patientName: patient.fullName, medrekkCode: patient.medrekkCode };
  }

  private async load(token: string): Promise<AccessSession> {
    const found = await this.repos.sessions.findByTokenHash(hashToken(token));
    if (!found) throw new AppError(404, "SESSION_NOT_FOUND", "Access session not found.");
    const nowMs = this.deps.now().getTime();
    const lapsed =
      (found.status === "APPROVED" && found.grantedUntil !== undefined && Date.parse(found.grantedUntil) <= nowMs) ||
      ((found.status === "AWAITING_REQUEST" || found.status === "PENDING") && Date.parse(found.expiresAt) <= nowMs);
    if (!lapsed) return found;
    const expired: AccessSession = { ...found, status: "EXPIRED" };
    await this.repos.sessions.update(expired);
    return expired;
  }

  /** requesterUserId is set only when the request carried a valid health-worker token. */
  async requestAccess(token: string, input: AccessRequestInput, requesterUserId?: string) {
    const session = await this.load(token);
    this.assertUsable(session);
    if (session.status !== "AWAITING_REQUEST") {
      throw new AppError(409, "REQUEST_ALREADY_SUBMITTED", "An access request was already submitted for this session.");
    }
    const updated: AccessSession = {
      ...session,
      status: "PENDING",
      requester: {
        name: input.requesterName,
        role: input.requesterRole,
        reason: input.reason,
        ...(input.requesterFacility ? { facility: input.requesterFacility } : {}),
      },
      requestedScopes: [...new Set(input.scopes)],
      durationMinutes: input.durationMinutes,
      expiresAt: this.iso(SESSION_LIFETIME_MS), // patient gets a fresh window to respond
      ...(requesterUserId ? { requesterUserId } : {}),
    };
    await this.repos.sessions.update(updated);
    await this.audit(updated, "ACCESS_REQUESTED", { informationViewed: updated.requestedScopes });
    return { status: updated.status };
  }

  async getStatus(token: string): Promise<{ status: AccessStatus; grantedUntil?: string }> {
    const s = await this.load(token);
    return { status: s.status, grantedUntil: s.grantedUntil };
  }

  async getRecord(token: string) {
    const s = await this.load(token);
    this.assertUsable(s);
    if (s.status !== "APPROVED" || !s.grantedUntil) {
      throw new AppError(409, "ACCESS_NOT_GRANTED", "Access has not been approved yet.");
    }
    const data: Partial<Record<AccessScope, Omit<ClinicalClaim, "patientId">[]>> = {};
    for (const scope of s.approvedScopes) {
      const claims = await this.repos.records.claimsFor(s.patientId, scope);
      data[scope] = claims.map(({ patientId: _patientId, ...rest }) => rest);
    }
    const patient = await this.repos.patients.findById(s.patientId);
    await this.audit(s, "RECORD_VIEWED", { informationViewed: s.approvedScopes });
    return {
      patient: { name: patient?.fullName ?? "", medrekkCode: patient?.medrekkCode ?? "" },
      grantedUntil: s.grantedUntil,
      authorizedScopes: s.approvedScopes,
      data,
    };
  }

  /**
   * Used by verification: the session must be approved, unexpired, and requested by this exact worker account.
   * An anonymous (browser-only) session can never be used to verify.
   */
  async authorizeVerifier(token: string, workerUserId: string): Promise<AccessSession> {
    const s = await this.load(token);
    this.assertUsable(s);
    if (s.status !== "APPROVED" || !s.grantedUntil) {
      throw new AppError(409, "ACCESS_NOT_GRANTED", "Access has not been approved yet.");
    }
    if (s.requesterUserId !== workerUserId) {
      throw new AppError(403, "NOT_SESSION_REQUESTER", "This session was not requested by your account.");
    }
    return s;
  }

  private assertUsable(s: AccessSession): void {
    if (s.status === "DENIED") throw new AppError(403, "ACCESS_DENIED", "Access denied by patient.");
    if (s.status === "EXPIRED") throw new AppError(410, "SESSION_EXPIRED", "This access session has expired.");
    if (s.status === "REVOKED") throw new AppError(403, "ACCESS_REVOKED", "The patient ended this access.");
  }

  // ---- patient side ----

  async listForPatient(patientId: string) {
    const all = await this.repos.sessions.listForPatient(patientId);
    const nowMs = this.deps.now().getTime();
    return all
      .filter((s) => s.status === "PENDING" && Date.parse(s.expiresAt) > nowMs)
      .map((s) => ({
        id: s.id, requester: s.requester, requestedScopes: s.requestedScopes,
        durationMinutes: s.durationMinutes, expiresAt: s.expiresAt,
      }));
  }

  async decide(patientId: string, sessionId: string, input: AccessDecisionInput) {
    const found = await this.repos.sessions.findById(sessionId);
    if (!found || found.patientId !== patientId) throw new AppError(404, "REQUEST_NOT_FOUND", "Access request not found.");
    if (found.status !== "PENDING" || Date.parse(found.expiresAt) <= this.deps.now().getTime()) {
      throw new AppError(409, "REQUEST_NOT_PENDING", "This request is no longer pending.");
    }
    if (input.decision === "DENY") {
      const denied: AccessSession = { ...found, status: "DENIED", decidedAt: this.iso() };
      await this.repos.sessions.update(denied);
      await this.audit(denied, "ACCESS_DENIED");
      return { status: denied.status };
    }
    const approvedScopes = input.approvedScopes ?? found.requestedScopes;
    if (!approvedScopes.every((sc) => found.requestedScopes.includes(sc))) {
      throw new AppError(400, "SCOPE_NOT_REQUESTED", "Approved scopes must be a subset of the requested scopes.");
    }
    const minutes = found.durationMinutes ?? 120;
    const approved: AccessSession = {
      ...found, status: "APPROVED", approvedScopes: [...new Set(approvedScopes)],
      grantedUntil: this.iso(minutes * 60_000), decidedAt: this.iso(),
    };
    await this.repos.sessions.update(approved);
    await this.audit(approved, "ACCESS_APPROVED", { informationViewed: approved.approvedScopes });
    return { status: approved.status, grantedUntil: approved.grantedUntil };
  }

  async listSessions(patientId: string, view: "active" | "past") {
    const all = await this.repos.sessions.listForPatient(patientId);
    const nowMs = this.deps.now().getTime();
    return all
      .filter((s) => s.requester !== undefined && s.status !== "AWAITING_REQUEST" && s.status !== "PENDING")
      .sort((a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt))
      .map((s) => {
        const lapsed = s.status === "APPROVED" && s.grantedUntil !== undefined && Date.parse(s.grantedUntil) <= nowMs;
        const status: AccessStatus = lapsed ? "EXPIRED" : s.status;
        return {
          id: s.id,
          status,
          requester: s.requester,
          requestedScopes: s.requestedScopes,
          approvedScopes: s.approvedScopes,
          grantedUntil: s.grantedUntil,
          decidedAt: s.decidedAt,
          revokedAt: s.revokedAt,
        };
      })
      .filter((x) => (view === "active" ? x.status === "APPROVED" : x.status !== "APPROVED"));
  }

  /** The patient ends an approved, still-running access early. The provider loses it immediately. */
  async revoke(patientId: string, sessionId: string) {
    const found = await this.repos.sessions.findById(sessionId);
    if (!found || found.patientId !== patientId) throw new AppError(404, "REQUEST_NOT_FOUND", "Access session not found.");
    const stillRunning =
      found.status === "APPROVED" && found.grantedUntil !== undefined && Date.parse(found.grantedUntil) > this.deps.now().getTime();
    if (!stillRunning) throw new AppError(409, "ACCESS_NOT_ACTIVE", "This access is not active.");
    const revoked: AccessSession = { ...found, status: "REVOKED", revokedAt: this.iso() };
    await this.repos.sessions.update(revoked);
    await this.audit(revoked, "ACCESS_REVOKED", { informationViewed: revoked.approvedScopes });
    return { status: revoked.status, revokedAt: revoked.revokedAt };
  }

  auditTrail(patientId: string) { return this.repos.audit.listForPatient(patientId); }
}
