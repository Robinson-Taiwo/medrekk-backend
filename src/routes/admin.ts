import { Router, type Request } from "express";
import { requireAuth } from "../middleware/auth.js";
import type { AdminService } from "../services/admin/adminService.js";
import { credentialUpdateSchema, userIdParams, workerListQuerySchema } from "../shared/adminValidation.js";
import { AppError } from "../utils/errors.js";

function callerId(req: Request): string {
  if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
  return req.auth.userId;
}

export function adminRoutes(admin: AdminService): Router {
  const r = Router();
  // 401 for no token. The admin check itself (403) happens in the service.
  r.use("/admin", requireAuth);

  r.get("/admin/health-workers", async (req, res) => {
    const { status } = workerListQuerySchema.parse(req.query);
    res.json(await admin.listHealthWorkers(callerId(req), status));
  });

  r.post("/admin/health-workers/:userId/credential", async (req, res) => {
    const { userId } = userIdParams.parse(req.params);
    const { status } = credentialUpdateSchema.parse(req.body);
    res.json(await admin.setCredential(callerId(req), userId, status));
  });

  r.get("/admin/credential-log", async (req, res) => {
    res.json(await admin.credentialLog(callerId(req)));
  });

  return r;
}
