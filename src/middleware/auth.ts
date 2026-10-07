import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthService } from "../auth/authService.js";
import { RoleSchema, type AuthContext } from "../shared/auth.js";
import { AppError } from "../utils/errors.js";

export type ActorRole = "PATIENT" | "HEALTH_WORKER";
export interface Actor { id: string; role: ActorRole }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Sets req.auth from a Bearer JWT. In AUTH_MODE=dev only, falls back to x-actor-id / x-actor-role.
 * A bad token is rejected; no credentials just leaves req.auth unset.
 */
export function createAttachAuth(authService: AuthService, authMode: "dev" | "jwt"): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      const ctx = authService.verify(header.slice(7));
      if (!ctx) return next(new AppError(401, "UNAUTHENTICATED", "Invalid or expired token."));
      req.auth = ctx;
      return next();
    }

    if (authMode === "dev") {
      const id = req.header("x-actor-id");
      const role = RoleSchema.safeParse(req.header("x-actor-role"));
      if (id && role.success) {
        req.auth = { userId: id, role: role.data, patientId: role.data === "PATIENT" ? id : null };
      }
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new AppError(401, "UNAUTHENTICATED", "Authentication required."));
  next();
};

/**
 * 401 = we don't know who you are (missing, invalid or expired token).
 * 403 = we know who you are, but this account can't do this.
 */
export function requireActor(req: Request, role: ActorRole): Actor {
  if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
  if (req.auth.role !== role) throw new AppError(403, "FORBIDDEN", "This account type can't do that.");
  const id = role === "PATIENT" ? req.auth.patientId : req.auth.userId;
  if (!id) throw new AppError(403, "FORBIDDEN", "No patient record is linked to this account.");
  return { id, role };
}
