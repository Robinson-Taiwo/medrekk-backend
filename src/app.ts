import bcrypt from "bcryptjs";
import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { AuthService } from "./auth/authService.js";
import { InMemoryUserRepository } from "./auth/userRepository.js";
import type { AppConfig } from "./config.js";
import { createMemoryRepositories, emptyStore, seedDemoData } from "./database/memory.js";
import type { Repositories } from "./database/repositories.js";
import { createAttachAuth } from "./middleware/auth.js";
import { accessRoutes } from "./routes/access.js";
import { adminRoutes } from "./routes/admin.js";
import { createAuthRouter } from "./routes/auth.js";
import { emergencyRoutes } from "./routes/emergency.js";
import { patientRoutes } from "./routes/patients.js";
import { syncRoutes } from "./routes/sync.js";
import { verificationRoutes } from "./routes/verification.js";
import { AccessService } from "./services/access/accessService.js";
import { AdminService } from "./services/admin/adminService.js";
import { NoopCloudAdapter, type CloudAdapter } from "./services/cloud/rumpty.js";
import { EmergencyService } from "./services/emergency/emergencyService.js";
import { PatientService } from "./services/patient/patientService.js";
import { SyncService } from "./services/sync/syncService.js";
import { VerificationService } from "./services/verification/verificationService.js";
import { AppError } from "./utils/errors.js";

export interface AppOptions {
  config: AppConfig;
  now?: () => Date;
  repos?: Repositories;
  cloud?: CloudAdapter;
}

interface BodyParseError extends Error { type?: string }
const isBodyParseError = (e: Error): boolean => (e as BodyParseError).type === "entity.parse.failed";

export function buildApp(opts: AppOptions): Express {
  const now = opts.now ?? (() => new Date());
  let repos = opts.repos;
  if (!repos) {
    const store = emptyStore();
    if (opts.config.SEED_DEMO_DATA) seedDemoData(store);
    repos = createMemoryRepositories(store);
  }
  const cloud = opts.cloud ?? new NoopCloudAdapter();

  // ---- Patients and auth ----
  const patientService = new PatientService(repos, now);
  const users = new InMemoryUserRepository();
  const authService = new AuthService(users, opts.config.JWT_SECRET, patientService);
  if (opts.config.SEED_DEMO_DATA) {
    // In-memory create resolves immediately, so void is safe here.
    void users.create({
      id: "usr_demo_amaka",
      email: "amaka@demo.medrekk",
      passwordHash: bcrypt.hashSync("demo-pass-123", 10),
      fullName: "Amaka Okafor",
      role: "PATIENT",
      patientId: "pat_demo_amaka",
      facility: null,
      credentialStatus: null,
      createdAt: now().toISOString(),
    });
    // Demo-only approved health worker.
    void users.create({
      id: "usr_demo_nurse",
      email: "nurse@demo.medrekk",
      passwordHash: bcrypt.hashSync("demo-pass-123", 10),
      fullName: "Ngozi Eze",
      role: "HEALTH_WORKER",
      patientId: null,
      facility: "Demo Community Clinic",
      credentialStatus: "APPROVED",
      createdAt: now().toISOString(),
    });
  }

  const adminEmails = (opts.config.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  const accessService = new AccessService({ repos, now });
  const verificationService = new VerificationService({ repos, users, access: accessService, now });
  const adminService = new AdminService({ users, adminEmails, now });

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(cors({ origin: opts.config.CORS_ORIGIN.split(",").map((o) => o.trim()).filter((o) => o.length > 0) }));
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }); // never cache medical data

  // Brute-force protection for credential endpoints only.
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: opts.config.NODE_ENV === "production" ? 10 : 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/auth/login", authLimiter);
  app.use("/auth/register", authLimiter);

  // Must come before the routers so req.auth is set when requireActor runs.
  app.use(createAttachAuth(authService, opts.config.AUTH_MODE));
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.use("/auth", createAuthRouter(authService));
  app.use(patientRoutes(patientService));
  app.use(accessRoutes(accessService));
  app.use(verificationRoutes(verificationService));
  app.use(adminRoutes(adminService));
  app.use(emergencyRoutes(new EmergencyService({ repos, now })));
  app.use(syncRoutes(new SyncService({ repos, cloud })));

  app.use((_req, res) => { res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } }); });

  const onError: ErrorRequestHandler = (err: Error, _req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR", message: "Invalid request.",
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    } else if (isBodyParseError(err)) {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON." } });
    } else {
      console.error(err);
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
    }
  };
  app.use(onError);
  return app;
}
