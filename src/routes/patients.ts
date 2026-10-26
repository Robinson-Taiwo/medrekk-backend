import { Router } from "express";
import { requireActor } from "../middleware/auth.js";
import type { PatientService } from "../services/patient/patientService.js";
import { emergencyProfileSchema, patientEvidenceSchema, selfClaimSchema } from "../shared/validation.js";
import { ProfileUpdateSchema } from "../shared/profile.js";

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

    // A document the patient attaches to their own entry. It does not raise the entry's
    // standing — only a clinician can do that — but it puts the paper in front of whoever
    // reviews it next.
    r.post("/patients/me/claims/:id/evidence", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.status(201).json(
            await patients.addSelfEvidence(actor.id, String(req.params.id), patientEvidenceSchema.parse(req.body)),
        );
    });

    r.get("/patients/me/claims/:id/evidence", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.listSelfEvidence(actor.id, String(req.params.id)));
    });

    r.post("/patients/me/claims/:id/emergency", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.decideEmergencyCard(actor.id, String(req.params.id), true));
    });

    r.delete("/patients/me/claims/:id/emergency", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.decideEmergencyCard(actor.id, String(req.params.id), false));
    });

    r.delete("/patients/me/claims/:id", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.removeClaim(actor.id, String(req.params.id)));
    });

    r.get("/patients/me/emergency-profile", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.getEmergencyProfile(actor.id));
    });

    r.put("/patients/me/emergency-profile", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.updateEmergencyProfile(actor.id, emergencyProfileSchema.parse(req.body)));
    });

    r.get("/patients/me/profile", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.getProfile(actor.id));
    });

    r.patch("/patients/me/profile", async (req, res) => {
        const actor = requireActor(req, "PATIENT");
        res.json(await patients.updateProfile(actor.id, ProfileUpdateSchema.parse(req.body)));
    });

    return r;
}