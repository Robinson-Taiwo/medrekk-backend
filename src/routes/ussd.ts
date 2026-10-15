import { timingSafeEqual } from "node:crypto";
import { Router } from "express";

import { requireActor } from "../middleware/auth.js";
import { UssdPinSchema, UssdRequestSchema } from "../shared/ussd.js";
import type { UssdService } from "../services/ussd/ussdService.js";
import { AppError } from "../utils/errors.js";

function sameSecret(expected: string, received: string | undefined): boolean {
  if (received === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `sharedSecret` is what the aggregator sends in x-ussd-secret. When it is unset the
 * endpoint is open: fine for a local simulator, but in production anyone could then POST
 * someone else's number, probe whether it has an account, and burn their PIN attempts.
 */
export function ussdRoutes(ussd: UssdService, sharedSecret?: string): Router {
  const r = Router();

  r.post("/ussd", async (req, res) => {
    if (sharedSecret && !sameSecret(sharedSecret, req.header("x-ussd-secret"))) {
      throw new AppError(401, "UNAUTHENTICATED", "Invalid USSD credentials.");
    }
    const reply = await ussd.handle(UssdRequestSchema.parse(req.body));
    // Aggregators read the leading CON/END off a plain-text body, not a JSON envelope.
    res.type("text/plain").send(`${reply.done ? "END" : "CON"} ${reply.message}`);
  });

  r.get("/patients/me/ussd-pin", async (req, res) => {
    requireActor(req, "PATIENT");
    res.json(await ussd.pinStatus(req.auth!.userId));
  });

  r.patch("/patients/me/ussd-pin", async (req, res) => {
    requireActor(req, "PATIENT");
    const { pin } = UssdPinSchema.parse(req.body);
    res.json(await ussd.setPin(req.auth!.userId, pin));
  });

  r.delete("/patients/me/ussd-pin", async (req, res) => {
    requireActor(req, "PATIENT");
    res.json(await ussd.clearPin(req.auth!.userId));
  });

  return r;
}
