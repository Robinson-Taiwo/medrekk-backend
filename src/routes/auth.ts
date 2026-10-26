import { Router } from "express";
import type { AuthService } from "../auth/authService.js";
import { requireAuth } from "../middleware/auth.js";
import { CredentialSubmissionSchema, LoginSchema, PhoneUpdateSchema, PushTokenSchema, RegisterSchema } from "../shared/auth.js";
import { AppError } from "../utils/errors.js";

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  router.post("/register", async (req, res) => {
    res.status(201).json(await authService.register(RegisterSchema.parse(req.body)));
  });

  router.post("/login", async (req, res) => {
    res.json(await authService.login(LoginSchema.parse(req.body)));
  });

  router.get("/me", requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
    res.json(await authService.me(req.auth.userId));
  });

  router.patch("/me/phone", requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
    const { phone } = PhoneUpdateSchema.parse(req.body);
    res.json(await authService.setPhone(req.auth.userId, phone));
  });

  /**
   * A health worker submitting their registration details and a photograph of the licence,
   * so an approver has something to check rather than a name and a free-text facility.
   */
  router.post("/me/credential", requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
    res.json(await authService.submitCredential(req.auth.userId, CredentialSubmissionSchema.parse(req.body)));
  });

  /** A health worker turning on their own patient record. Returns a new token carrying it. */
  router.post("/me/patient-record", requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
    res.status(201).json(await authService.addOwnRecord(req.auth.userId));
  });

  /** This handset, so the server can tell this account something while the app is closed. */
  router.post("/me/push-token", requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
    await authService.registerPushToken(req.auth.userId, PushTokenSchema.parse(req.body).token);
    res.status(204).end();
  });

  router.delete("/me/push-token", requireAuth, async (req, res) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
    await authService.forgetPushToken(req.auth.userId, PushTokenSchema.parse(req.body).token);
    res.status(204).end();
  });

  return router;
}