import type { Request } from "express";
import { AppError } from "../utils/errors.js";

export type ActorRole = "PATIENT" | "HEALTH_WORKER";
export interface Actor { id: string; role: ActorRole }

/**
 * DEV-ONLY auth stub: trusts x-actor-id / x-actor-role headers.
 * config.ts refuses to boot with AUTH_MODE=dev in production. Replace with real auth (JWT) before deploying.
 */
export function requireActor(req: Request, role: ActorRole): Actor {
  const id = req.header("x-actor-id");
  const claimedRole = req.header("x-actor-role");
  if (!id || claimedRole !== role) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
  return { id, role };
}
