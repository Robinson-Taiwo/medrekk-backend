import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireActor } from "../middleware/auth.js";
import type { ReferralService } from "../services/referral/referralService.js";
import { createReferralSchema } from "../shared/referralValidation.js";

const idParams = z.object({ id: z.string().min(1).max(100) });
const shareParams = z.object({ shareId: z.string().min(20).max(100) });

export function referralRoutes(referrals: ReferralService): Router {
  const r = Router();
  const viewLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  r.post("/patients/me/referrals", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    const userId = req.auth?.userId ?? actor.id;
    res.status(201).json(await referrals.create(actor.id, userId, createReferralSchema.parse(req.body)));
  });

  r.get("/patients/me/referrals", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    res.json(await referrals.listForPatient(actor.id));
  });

  r.post("/patients/me/referrals/:id/revoke", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    res.json(await referrals.revoke(actor.id, idParams.parse(req.params).id));
  });

  // Public: no account. The share ID is in the URL path, so never let it leak through a Referer header.
  r.get("/referral/:shareId", viewLimiter, async (req, res) => {
    const { shareId } = shareParams.parse(req.params);
    const ua = (req.header("user-agent") ?? "unknown").slice(0, 80);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.json(await referrals.view(shareId, { requesterIdentifier: `${req.ip ?? "unknown-ip"} | ${ua}` }));
  });

  return r;
}
