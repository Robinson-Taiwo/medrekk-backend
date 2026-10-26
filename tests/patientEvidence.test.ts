import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

/**
 * A patient backing their own entry with a document. The point of these is the line that must
 * not move: attaching your own paper makes it reviewable, not confirmed.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "dev",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: true,
  CORS_ORIGIN: "http://localhost:3000",
};

const patient = { "x-actor-id": "pat_demo_amaka", "x-actor-role": "PATIENT" };
const other = { "x-actor-id": "pat_someone_else", "x-actor-role": "PATIENT" };
const makeApp = () => buildApp({ config, now: () => new Date("2026-10-26T09:00:00Z") });
type TestApp = ReturnType<typeof makeApp>;

const doc = {
  kind: "PRESCRIPTION",
  description: "Photograph of the prescription from my clinic visit",
  captureMethod: "OCR",
  origin: { facility: "Ilorin General", documentDate: "2026-10-16" },
  imageHash: "a".repeat(64),
};

async function selfClaim(app: TestApp): Promise<string> {
  const { body } = await request(app)
    .post("/patients/me/claims")
    .set(patient)
    .send({ category: "CURRENT_MEDICATIONS", value: "Metformin 500mg, twice daily" })
    .expect(201);
  expect(body.status).toBe("SELF_REPORTED");
  return body.id as string;
}

describe("a patient attaching their own document", () => {
  it("stores the document with where it came from and how it was read", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    const { body } = await request(app)
      .post(`/patients/me/claims/${id}/evidence`)
      .set(patient)
      .send(doc)
      .expect(201);

    expect(body).toMatchObject({
      kind: "PRESCRIPTION",
      captureMethod: "OCR",
      origin: { facility: "Ilorin General" },
      imageHash: "a".repeat(64),
    });
    // Who put the row in MedRekk, which is not who issued the paper.
    expect(body.addedByName).toBe("Amaka Okafor");
  });

  it("does NOT raise the entry's standing", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    await request(app).post(`/patients/me/claims/${id}/evidence`).set(patient).send(doc).expect(201);

    const claims = await request(app).get("/patients/me/claims").set(patient).expect(200);
    const mine = claims.body.find((c: { id: string }) => c.id === id);
    expect(mine.status).toBe("SELF_REPORTED");
    expect(mine.verifiedAt).toBeUndefined();
    expect(mine.verificationMethod).toBeUndefined();
    // Still linked, so a clinician can find the paper.
    expect(mine.evidenceId).toBeTruthy();
  });

  it("refuses the kinds that are one person vouching for another", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    for (const kind of ["PATIENT_CONFIRMATION", "PROFESSIONAL_CONFIRMATION", "ORIGINAL_CAPTURE"]) {
      await request(app)
        .post(`/patients/me/claims/${id}/evidence`)
        .set(patient)
        .send({ ...doc, kind })
        .expect(400);
    }
  });

  it("will not attach to somebody else's entry", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    await request(app).post(`/patients/me/claims/${id}/evidence`).set(other).send(doc).expect(404);
  });

  it("shows up in the patient's own audit trail", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    await request(app).post(`/patients/me/claims/${id}/evidence`).set(patient).send(doc).expect(201);

    const audit = await request(app).get("/patients/me/audit").set(patient).expect(200);
    const row = audit.body.find((e: { type: string }) => e.type === "EVIDENCE_ADDED");
    expect(row).toBeTruthy();
    expect(row.requesterIdentifier).toContain("(PATIENT)");
  });

  it("lists what is attached", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    await request(app).post(`/patients/me/claims/${id}/evidence`).set(patient).send(doc).expect(201);
    const { body } = await request(app).get(`/patients/me/claims/${id}/evidence`).set(patient).expect(200);
    expect(body).toHaveLength(1);
  });

  it("rejects a malformed image hash rather than storing something unprovable", async () => {
    const app = makeApp();
    const id = await selfClaim(app);
    await request(app)
      .post(`/patients/me/claims/${id}/evidence`)
      .set(patient)
      .send({ ...doc, imageHash: "not-a-hash" })
      .expect(400);
  });
});
