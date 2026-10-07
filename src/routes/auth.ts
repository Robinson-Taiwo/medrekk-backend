import { Router } from "express";
import type { AuthService } from "../auth/authService.js";
import { requireAuth } from "../middleware/auth.js";
import { LoginSchema, RegisterSchema } from "../shared/auth.js";
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

  return router;
}