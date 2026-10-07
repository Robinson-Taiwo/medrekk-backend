import { Router } from "express";
import { z } from "zod";
import { requireActor } from "../middleware/auth.js";
import type { VerificationService } from "../services/verification/verificationService.js";
import {
  addEvidenceSchema, verifyClaimSchema, verifyProfileSchema,
} from "../shared/verificationValidation.js";

const sessionParam = z.object({ session: z.string().min(20).max(100) });
const params = sessionParam.extend({ claimId: z.string().min(1).max(100) });

export function verificationRoutes(verification: VerificationService): Router {
  const r = Router();

  // ---- health worker (authenticated, inside a patient-approved session they requested) ----
  r.post("/access/:session/claims/:claimId/evidence", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const p = params.parse(req.params);
    res.status(201).json(await verification.addEvidence(actor.id, p.session, p.claimId, addEvidenceSchema.parse(req.body)));
  });
  r.post("/access/:session/claims/:claimId/verify", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const p = params.parse(req.params);
    res.json(await verification.verifyClaim(actor.id, p.session, p.claimId, verifyClaimSchema.parse(req.body)));
  });

  r.get("/access/:session/emergency-profile", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const p = sessionParam.parse(req.params);
    res.json(await verification.getProfileForReview(actor.id, p.session));
  });
  r.post("/access/:session/emergency-profile/verify", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const p = sessionParam.parse(req.params);
    res.json(await verification.verifyEmergencyProfile(actor.id, p.session, verifyProfileSchema.parse(req.body)));
  });

  // ---- patient (authenticated) ----
  r.get("/patients/me/verifications", async (req, res) => {
    res.json(await verification.listForPatient(requireActor(req, "PATIENT").id));
  });

  return r;
}
