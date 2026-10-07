import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { accessDecisionSchema, accessLookupSchema, accessRequestSchema } from "../shared/validation.js";
import type { AccessService } from "../services/access/accessService.js";
import { requireActor } from "../middleware/auth.js";

const tokenParams = z.object({ session: z.string().min(20).max(100) });
const idParams = z.object({ id: z.string().min(1).max(100) });

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
  r.get("/access/:session/status", async (req, res) => {
    res.json(await access.getStatus(tokenParams.parse(req.params).session));
  });
  r.get("/access/:session/record", async (req, res) => {
    res.json(await access.getRecord(tokenParams.parse(req.params).session));
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
    res.json(await access.auditTrail(requireActor(req, "PATIENT").id));
  });
  return r;
}
