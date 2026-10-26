import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AUDIT_GROUPS, AUDIT_GROUP_NAMES, type AuditGroup } from "../shared/types.js";
import { accessDecisionSchema, accessLookupSchema, accessRequestSchema } from "../shared/validation.js";
import type { AccessService } from "../services/access/accessService.js";
import { requireActor } from "../middleware/auth.js";

const tokenParams = z.object({ session: z.string().min(20).max(100) });
const idParams = z.object({ id: z.string().min(1).max(100) });

/**
 * A sane default and a hard ceiling, so no caller can ask for the whole trail at once.
 *
 * `group` rather than a list of event types: the grouping is defined once, on the server, and
 * a client that sent its own list would quietly drift out of step the moment a new event type
 * was added — the row would exist and appear under no filter.
 */
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(100).optional(),
  group: z.enum(AUDIT_GROUP_NAMES as [AuditGroup, ...AuditGroup[]]).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});

export function accessRoutes(access: AccessService): Router {
  const r = Router();
  const lookupLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  // ---- provider (browser, no account needed) ----
  r.post("/access/lookup", lookupLimiter, async (req, res) => {
    res.status(201).json(await access.startSession(accessLookupSchema.parse(req.body)));
  });
  r.post("/access/:session/request", async (req, res) => {
    const { session } = tokenParams.parse(req.params);
    // Optional: a signed-in health worker links the session to their account, which is what lets them verify later.
    const requesterUserId = req.auth?.role === "HEALTH_WORKER" ? req.auth.userId : undefined;
    res.status(202).json(await access.requestAccess(session, accessRequestSchema.parse(req.body), requesterUserId));
  });
  // No requireActor: whoever holds the token may hand it back, and giving up access is
  // never an escalation. A worker signing out calls this so the patient's list stays honest.
  r.post("/access/:session/release", async (req, res) => {
    const { session } = tokenParams.parse(req.params);
    res.json(await access.release(session));
  });

  r.get("/access/:session/status", async (req, res) => {
    res.json(await access.getStatus(tokenParams.parse(req.params).session));
  });
  r.get("/access/:session/record", async (req, res) => {
    res.json(await access.getRecord(tokenParams.parse(req.params).session));
  });

  // ---- health worker (authenticated) ----
  // Keyed on the account, not the handset, so a grant survives signing out, a reinstall or a
  // new phone. Both need a real worker token: requireActor is the whole guard here.
  r.get("/access/mine", async (req, res) => {
    res.json(await access.listActiveForWorker(requireActor(req, "HEALTH_WORKER").id));
  });
  r.post("/access/mine/:id/resume", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    res.json(await access.resume(actor.id, idParams.parse(req.params).id));
  });

  // ---- patient (authenticated) ----
  r.get("/patients/me/access-requests", async (req, res) => {
    res.json(await access.listForPatient(requireActor(req, "PATIENT").id));
  });
  r.post("/patients/me/access-requests/:id/decision", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    res.json(await access.decide(actor.id, idParams.parse(req.params).id, accessDecisionSchema.parse(req.body)));
  });
  r.get("/patients/me/access-sessions", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    const { status } = z.object({ status: z.enum(["active", "past"]).default("active") }).parse(req.query);
    res.json(await access.listSessions(actor.id, status));
  });
  r.post("/patients/me/access-sessions/:id/revoke", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    res.json(await access.revoke(actor.id, idParams.parse(req.params).id));
  });
  r.get("/patients/me/audit", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    const { group, ...rest } = auditQuery.parse(req.query);
    res.json(await access.auditTrail(actor.id, { ...rest, ...(group ? { types: AUDIT_GROUPS[group] } : {}) }));
  });
  return r;
}
