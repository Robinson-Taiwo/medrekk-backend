import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { emergencyQuerySchema, medrekkCodeSchema } from "../shared/validation.js";
import type { EmergencyService } from "../services/emergency/emergencyService.js";

export function emergencyRoutes(emergency: EmergencyService): Router {
  const r = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  r.get("/emergency/:identifier", limiter, async (req, res) => {
    const { identifier } = z.object({ identifier: medrekkCodeSchema }).parse(req.params);
    const { reason } = emergencyQuerySchema.parse(req.query);
    const ua = (req.header("user-agent") ?? "unknown").slice(0, 80);
    res.json(await emergency.access(identifier, { requesterIdentifier: `${req.ip ?? "unknown-ip"} | ${ua}`, reason }));
  });
  return r;
}
