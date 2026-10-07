import { Router } from "express";
import { requireActor } from "../middleware/auth.js";
import type { PatientService } from "../services/patient/patientService.js";
import { emergencyProfileSchema, selfClaimSchema } from "../shared/validation.js";

export function patientRoutes(patients: PatientService): Router {
    const r = Router();

    r.get("/patients/me", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.me(actor.id));
    });

    r.get("/patients/me/claims", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.listClaims(actor.id));
    });

    r.post("/patients/me/claims", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.status(201).json(await patients.addSelfClaim(actor.id, selfClaimSchema.parse(req.body)));
    });

    r.get("/patients/me/emergency-profile", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.getEmergencyProfile(actor.id));
    });

    r.put("/patients/me/emergency-profile", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.updateEmergencyProfile(actor.id, emergencyProfileSchema.parse(req.body)));
    });

    return r;
}