import type {
  AccessScope, AccessSession, AccessStatus, AuditEvent, AuditType, ClinicalClaim,
} from "../../shared/types.js";
import type { AccessDecisionInput, AccessLookupInput, AccessRequestInput } from "../../shared/validation.js";
import type { Repositories } from "../../database/repositories.js";
import { AppError } from "../../utils/errors.js";
import type { UserRepository } from "../../auth/userRepository.js";
import type { PushMessage, PushSender } from "../notify/pushService.js";
import { hashToken, newAccessToken, newId, normalizeName } from "../../utils/ids.js";

const SESSION_LIFETIME_MS = 30 * 60 * 1000;

export interface AccessDeps {
  repos: Repositories;
  now: () => Date;
  /** Optional: without them, the flow works exactly as before and nobody is notified. */
  users?: UserRepository;
  push?: PushSender;
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

  /**
   * Reaching a person rather than a screen.
   *
   * Everything here is best effort and never awaited into the caller's outcome in a way that
   * could fail it: an access request that succeeded must not report failure because a
   * notification did not go out.
   */
  private async notify(userId: string | undefined, message: PushMessage): Promise<void> {
    if (!userId || !this.deps.users || !this.deps.push) return;
    try {
      const user = await this.deps.users.findById(userId);
      const tokens = user?.pushTokens ?? [];
      if (tokens.length > 0) await this.deps.push.send(tokens, message);
    } catch {
      // Logged by the sender. Not the caller's problem.
    }
  }

  private async notifyPatient(patientId: string, message: PushMessage): Promise<void> {
    if (!this.deps.users) return;
    try {
      const user = await this.deps.users.findByPatientId(patientId);
      await this.notify(user?.id, message);
    } catch {
      // As above.
    }
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

  /** True while the clock still allows this session to be used. */
  private isLive(s: AccessSession): boolean {
    const nowMs = this.deps.now().getTime();
    if (s.status === "APPROVED") return s.grantedUntil !== undefined && Date.parse(s.grantedUntil) > nowMs;
    if (s.status === "AWAITING_REQUEST" || s.status === "PENDING") return Date.parse(s.expiresAt) > nowMs;
    return false;
  }

  /**
   * Writes the lapse down rather than leaving a session sitting at APPROVED with a past
   * grantedUntil. Every read goes through here, by token or by id, so the stored status and
   * what the patient is shown cannot drift apart.
   */
  private async settle(found: AccessSession): Promise<AccessSession> {
    const stale =
      (found.status === "APPROVED" || found.status === "AWAITING_REQUEST" || found.status === "PENDING") &&
      !this.isLive(found);
    if (!stale) return found;
    const expired: AccessSession = { ...found, status: "EXPIRED" };
    await this.repos.sessions.update(expired);
    return expired;
  }

  private async load(token: string): Promise<AccessSession> {
    const found = await this.repos.sessions.findByTokenHash(hashToken(token));
    if (!found) throw new AppError(404, "SESSION_NOT_FOUND", "Access session not found.");
    return this.settle(found);
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

    // The one notification the consent model actually depends on: a request is only open for
    // a few minutes, and before this the patient found out by happening to open the app.
    await this.notifyPatient(updated.patientId, {
      title: "Someone wants to read your record",
      body: `${input.requesterName}${input.requesterFacility ? ` · ${input.requesterFacility}` : ""} — ${input.reason}`,
      data: { kind: "ACCESS_REQUEST", sessionId: updated.id },
    });
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

  // ---- worker side ----

  /**
   * The grants this worker account is still holding.
   *
   * A grant belongs to the worker's account, not to the handset it was approved on. It used
   * to live only in the phone's secure storage, so signing out — or reinstalling, or changing
   * phone — lost it for good, while the patient went on being shown an access that was still
   * running. The patient could end it; the worker could not see it. This is the missing half.
   */
  async listActiveForWorker(workerUserId: string) {
    const all = await this.repos.sessions.listForRequester(workerUserId);
    const live = all.filter((s) => (s.status === "APPROVED" || s.status === "PENDING") && this.isLive(s));
    const out = [];
    for (const s of live) {
      const patient = await this.repos.patients.findById(s.patientId);
      out.push({
        id: s.id,
        status: s.status,
        patientName: patient?.fullName ?? "",
        medrekkCode: patient?.medrekkCode ?? "",
        approvedScopes: s.approvedScopes,
        grantedUntil: s.grantedUntil,
      });
    }
    return out.sort((a, b) => (b.grantedUntil ?? "").localeCompare(a.grantedUntil ?? ""));
  }

  /**
   * Hands a still-running grant back to the account that was given it, as a fresh token.
   *
   * The raw token is never stored — only its hash — so the original cannot be returned. A new
   * one is minted and the old hash replaced, which also means a token left on a phone the
   * worker has signed out of stops working the moment they pick the grant up somewhere else.
   *
   * Only the account named on the session can do this, and only while the grant is live, so
   * this gives a worker nothing the patient has not already approved.
   */
  async resume(workerUserId: string, sessionId: string) {
    const raw = await this.repos.sessions.findById(sessionId);
    // Same 404 for "no such session" and "not yours", so this cannot be used to discover
    // which session ids exist.
    if (!raw || raw.requesterUserId !== workerUserId) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Access session not found.");
    }
    const found = await this.settle(raw);
    this.assertUsable(found);
    if (!this.isLive(found)) throw new AppError(409, "ACCESS_NOT_ACTIVE", "This access is no longer active.");

    const token = newAccessToken();
    const rotated: AccessSession = { ...found, tokenHash: hashToken(token) };
    await this.repos.sessions.update(rotated);
    await this.audit(rotated, "ACCESS_RESUMED", { informationViewed: rotated.approvedScopes });

    const patient = await this.repos.patients.findById(rotated.patientId);
    return {
      session: token,
      status: rotated.status,
      patientName: patient?.fullName ?? "",
      medrekkCode: patient?.medrekkCode ?? "",
      grantedUntil: rotated.grantedUntil,
    };
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
      await this.notify(denied.requesterUserId, {
        title: "Access declined",
        body: "The patient did not approve your request. Nothing was shared.",
        data: { kind: "ACCESS_DENIED", sessionId: denied.id },
      });
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
    await this.notify(approved.requesterUserId, {
      title: "Access approved",
      body: `You can read this record for ${minutes} minutes.`,
      data: { kind: "ACCESS_APPROVED", sessionId: approved.id },
    });
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
    // Told rather than left to discover it on the next tap, which would read as a fault.
    await this.notify(revoked.requesterUserId, {
      title: "Access ended",
      body: "The patient ended your access to their record.",
      data: { kind: "ACCESS_REVOKED", sessionId: revoked.id },
    });
    return { status: revoked.status, revokedAt: revoked.revokedAt };
  }

  /**
   * The worker handing the grant back — when they finish a visit, or sign out of the app.
   *
   * Holding the session token is authority enough, because releasing only ever reduces
   * access. Without this, signing out cleared the worker's copy of the token and left the
   * grant running on the server, so the patient went on being told somebody could see their
   * record when no device could actually open it.
   *
   * Recorded as its own audit type: a patient looking at the log should be able to tell the
   * difference between access they withdrew and access a worker gave back.
   */
  async release(token: string) {
    const session = await this.load(token);
    const live =
      session.status === "APPROVED" || session.status === "PENDING" || session.status === "AWAITING_REQUEST";
    if (!live) return { status: session.status };

    const ended: AccessSession = { ...session, status: "REVOKED", revokedAt: this.iso() };
    await this.repos.sessions.update(ended);
    await this.audit(ended, "ACCESS_RELEASED", { informationViewed: ended.approvedScopes });
    return { status: ended.status };
  }

  auditTrail(patientId: string) { return this.repos.audit.listForPatient(patientId); }
}
