import cors from "cors";
import express, { type ErrorRequestHandler, type Express } from "express";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { createMemoryRepositories, emptyStore, seedDemoData } from "./database/memory.js";
import type { Repositories } from "./database/repositories.js";
import { accessRoutes } from "./routes/access.js";
import { emergencyRoutes } from "./routes/emergency.js";
import { syncRoutes } from "./routes/sync.js";
import { AccessService } from "./services/access/accessService.js";
import { NoopCloudAdapter, type CloudAdapter } from "./services/cloud/rumpty.js";
import { EmergencyService } from "./services/emergency/emergencyService.js";
import { SyncService } from "./services/sync/syncService.js";
import { AppError } from "./utils/errors.js";

export interface AppOptions {
  config: AppConfig;
  now?: () => Date;
  repos?: Repositories;
  cloud?: CloudAdapter;
}

export function buildApp(opts: AppOptions): Express {
  const now = opts.now ?? (() => new Date());
  let repos = opts.repos;
  if (!repos) {
    const store = emptyStore();
    if (opts.config.SEED_DEMO_DATA) seedDemoData(store);
    repos = createMemoryRepositories(store);
  }
  const cloud = opts.cloud ?? new NoopCloudAdapter();

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(cors({ origin: opts.config.CORS_ORIGIN }));
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }); // never cache medical data

  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.use(accessRoutes(new AccessService({ repos, now })));
  app.use(emergencyRoutes(new EmergencyService({ repos, now })));
  app.use(syncRoutes(new SyncService({ repos, cloud })));

  app.use((_req, res) => { res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } }); });

  const onError: ErrorRequestHandler = (err: Error, _req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
    } else if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request.",
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    } else {
      console.error(err);
      res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
    }
  };
  app.use(onError);
  return app;
}
