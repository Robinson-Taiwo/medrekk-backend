import { Router } from "express";
import { syncPushSchema } from "../shared/validation.js";
import type { SyncService } from "../services/sync/syncService.js";
import { requireActor } from "../middleware/auth.js";

export function syncRoutes(sync: SyncService): Router {
  const r = Router();
  r.post("/sync/push", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    res.json(await sync.push(actor.id, syncPushSchema.parse(req.body).operations));
  });
  return r;
}
