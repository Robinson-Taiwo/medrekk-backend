import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: false,
  CORS_ORIGIN: "http://localhost:3000",
  EXPO_PUSH_ENABLED: false,
};

const HASH = "a".repeat(64);

const LAB_NOTE = [
  "LAGOS GENERAL HOSPITAL - HAEMATOLOGY",
  "Patient: Ada Obi   Date: 12/10/2026",
  "Haemoglobin 9.2 g/dL   Reference 12.0-16.0 g/dL   LOW",
].join("\n");

async function patient() {
  const app = buildApp({ config });
  const res = await request(app)
    .post("/auth/register")
    .send({
      email: `ada-${Math.random().toString(36).slice(2)}@example.com`,
      password: "password-123",
      fullName: "Ada Obi",
      role: "PATIENT",
    })
    .expect(201);
  return { app, auth: { Authorization: `Bearer ${res.body.token as string}` } };
}

const entry = {
  note: LAB_NOTE,
  captureMethod: "PHOTO",
  evidenceKind: "LAB_REPORT",
  textSource: "OCR",
  origin: { facility: "Lagos General Hospital", clinician: "Dr A. Adebayo", documentDate: "12/10/2026" },
  imageHash: HASH,
  items: [{ category: "LAB_RESULTS", value: "Haemoglobin 9.2 g/dL", excerpt: "Haemoglobin 9.2 g/dL" }],
};

describe("a patient recording a document they hold", () => {
  it("lands as one visit, readable through the screen the app already has", async () => {
    const { app, auth } = await patient();
    const created = await request(app).post("/patients/me/entries").set(auth).send(entry).expect(201);

    const visit = await request(app)
      .get(`/patients/me/encounters/${created.body.id as string}`)
      .set(auth)
      .expect(200);

    expect(visit.body.authoredBy).toBe("PATIENT");
    expect(visit.body.recordedByName).toBe("Ada Obi");
    // The capture is preserved exactly, so the explanation templates have the real text.
    expect(visit.body.rawInput).toContain("Haemoglobin 9.2 g/dL");
    expect(visit.body.origin.facility).toBe("Lagos General Hospital");
    expect(visit.body.imageHash).toBe(HASH);
  });

  it("groups several items under one visit rather than scattering them", async () => {
    const { app, auth } = await patient();
    const created = await request(app)
      .post("/patients/me/entries")
      .set(auth)
      .send({
        note: "RX: Artemether-lumefantrine. Paracetamol 500mg.",
        evidenceKind: "PRESCRIPTION",
        items: [
          { category: "CURRENT_MEDICATIONS", value: "Artemether-lumefantrine" },
          { category: "CURRENT_MEDICATIONS", value: "Paracetamol 500mg" },
        ],
      })
      .expect(201);

    const claims = await request(app).get("/patients/me/claims").set(auth).expect(200);
    const mine = (claims.body as { encounterId?: string }[]).filter(
      (c) => c.encounterId === (created.body.id as string),
    );
    expect(mine).toHaveLength(2);
  });

  it("is self-reported, and the facility on the paper never becomes the source", async () => {
    const { app, auth } = await patient();
    await request(app).post("/patients/me/entries").set(auth).send(entry).expect(201);

    const claims = await request(app).get("/patients/me/claims").set(auth).expect(200);
    const claim = (claims.body as { status: string; source: string }[])[0]!;
    expect(claim.status).toBe("SELF_REPORTED");
    // A hospital named on a document the patient uploaded has not vouched for anything.
    expect(claim.source).toBe("Patient");
    expect(claim.source).not.toContain("Lagos General");
  });

  it("keeps the document's origin and fingerprint on the evidence", async () => {
    const { app, auth } = await patient();
    await request(app).post("/patients/me/entries").set(auth).send(entry).expect(201);
    const claims = await request(app).get("/patients/me/claims").set(auth).expect(200);
    const claimId = (claims.body as { id: string }[])[0]!.id;

    const origin = await request(app).get(`/patients/me/claims/${claimId}/origin`).set(auth).expect(200);
    const row = (origin.body as {
      kind: string;
      captureMethod?: string;
      imageHash?: string;
      origin?: { facility?: string; clinician?: string };
      addedByName: string;
    }[])[0]!;

    expect(row.kind).toBe("LAB_REPORT");
    expect(row.captureMethod).toBe("OCR"); // read off the paper, not typed from memory
    expect(row.imageHash).toBe(HASH);
    expect(row.origin?.facility).toBe("Lagos General Hospital");
    expect(row.origin?.clinician).toBe("Dr A. Adebayo");
    // Who filed it, kept distinct from who issued it.
    expect(row.addedByName).toBe("Ada Obi");
  });

  it("refuses an evidence kind only a professional may file", async () => {
    const { app, auth } = await patient();
    await request(app)
      .post("/patients/me/entries")
      .set(auth)
      .send({ ...entry, evidenceKind: "PROFESSIONAL_CONFIRMATION" })
      .expect(400);
  });

  it("refuses a malformed image fingerprint rather than storing a useless one", async () => {
    const { app, auth } = await patient();
    await request(app).post("/patients/me/entries").set(auth).send({ ...entry, imageHash: "nope" }).expect(400);
  });

  it("requires at least one item, so an empty entry cannot be filed", async () => {
    const { app, auth } = await patient();
    await request(app).post("/patients/me/entries").set(auth).send({ ...entry, items: [] }).expect(400);
  });

  it("shows in the patient's audit trail", async () => {
    const { app, auth } = await patient();
    await request(app).post("/patients/me/entries").set(auth).send(entry).expect(201);
    const log = await request(app).get("/patients/me/audit").set(auth).expect(200);
    const types = (log.body.items as { type: string }[]).map((e) => e.type);
    expect(types).toContain("ENCOUNTER_RECORDED");
  });

  it("is patient-only, and needs authentication", async () => {
    const app = buildApp({ config });
    const worker = await request(app)
      .post("/auth/register")
      .send({ email: "hw@example.com", password: "password-123", fullName: "Ngozi Eze", role: "HEALTH_WORKER" })
      .expect(201);
    await request(app)
      .post("/patients/me/entries")
      .set({ Authorization: `Bearer ${worker.body.token as string}` })
      .send(entry)
      .expect(403);
    await request(app).post("/patients/me/entries").send(entry).expect(401);
  });

  it("cannot be read by another patient", async () => {
    const a = await patient();
    const created = await request(a.app).post("/patients/me/entries").set(a.auth).send(entry).expect(201);
    const b = await request(a.app)
      .post("/auth/register")
      .send({ email: "bola@example.com", password: "password-123", fullName: "Bola Ade", role: "PATIENT" })
      .expect(201);
    await request(a.app)
      .get(`/patients/me/encounters/${created.body.id as string}`)
      .set({ Authorization: `Bearer ${b.body.token as string}` })
      .expect(404);
  });
});
