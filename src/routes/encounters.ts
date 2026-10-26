import { Router } from "express";
import { z } from "zod";
import { requireActor } from "../middleware/auth.js";
import type { EncounterService } from "../services/encounter/encounterService.js";
import {
  captureEncounterSchema, encounterDraftSchema, encounterReviewSchema, selfEntrySchema,
} from "../shared/encounterValidation.js";

const params = z.object({ session: z.string().min(20).max(100), id: z.string().min(1).max(100) });
const sessionOnly = params.pick({ session: true });

export function encounterRoutes(encounters: EncounterService): Router {
  const r = Router();

  r.post("/access/:session/encounters", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const { session } = sessionOnly.parse(req.params);
    res.status(201).json(await encounters.capture(session, actor.id, captureEncounterSchema.parse(req.body)));
  });

  r.post("/access/:session/encounters/:id/draft", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const { session, id } = params.parse(req.params);
    res.json(await encounters.saveDraft(session, actor.id, id, encounterDraftSchema.parse(req.body)));
  });

  r.post("/access/:session/encounters/:id/discard", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const { session, id } = params.parse(req.params);
    res.json(await encounters.discard(session, actor.id, id));
  });

  r.post("/access/:session/encounters/:id/review", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const { session, id } = params.parse(req.params);
    res.json(await encounters.review(session, actor.id, id, encounterReviewSchema.parse(req.body)));
  });

  r.get("/access/:session/encounters/:id", async (req, res) => {
    const actor = requireActor(req, "HEALTH_WORKER");
    const { session, id } = params.parse(req.params);
    res.json(await encounters.get(session, actor.id, id));
  });

  // A patient recording a document they hold. One call, so a prescription with three
  // medicines lands as one visit rather than three loose items.
  r.post("/patients/me/entries", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    const userId = req.auth?.userId ?? actor.id;
    res.status(201).json(await encounters.selfRecord(actor.id, userId, selfEntrySchema.parse(req.body)));
  });

  r.get("/patients/me/entries", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    res.json(await encounters.listForPatient(actor.id));
  });

  r.get("/patients/me/encounters/:id", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    res.json(await encounters.encounterForPatient(actor.id, String(req.params.id)));
  });

  r.get("/patients/me/claims/:id/origin", async (req, res) => {
    const actor = requireActor(req, "PATIENT");
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    res.json(await encounters.originFor(actor.id, id));
  });

  return r;
}
