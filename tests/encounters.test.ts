import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "dev",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: true,
  CORS_ORIGIN: "http://localhost:3000",
};

const patient = { "x-actor-id": "pat_demo_amaka", "x-actor-role": "PATIENT" };
const worker = { "x-actor-id": "hw_1", "x-actor-role": "HEALTH_WORKER" };
const otherWorker = { "x-actor-id": "hw_2", "x-actor-role": "HEALTH_WORKER" };
const lookup = { medrekkCode: "MRK-82941", patientName: "Amaka Okafor" };

let clock = new Date("2026-10-08T09:00:00Z");
const makeApp = () => buildApp({ config, now: () => clock });
type TestApp = ReturnType<typeof makeApp>;

beforeEach(() => {
  clock = new Date("2026-10-08T09:00:00Z");
});

async function approved(app: TestApp, scopes: string[]) {
  const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
  await request(app)
    .post(`/access/${body.session}/request`)
    .set(worker)
    .send({
      requesterName: "Nurse Ada",
      requesterRole: "NURSE",
      reason: "Clinic visit",
      scopes,
      durationMinutes: 120,
    })
    .expect(202);
  const pending = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
  await request(app)
    .post(`/patients/me/access-requests/${pending.body[0].id as string}/decision`)
    .set(patient)
    .send({ decision: "APPROVE" })
    .expect(200);
  return body.session as string;
}

const raw = "Patient says she is allergic to penicillin and has coughed for three days.";

describe("worker encounters", () => {
  it("captures, drafts, reviews, and only then creates claims", async () => {
    const app = makeApp();
    const token = await approved(app, ["RECENT_ENCOUNTERS"]);

    const captured = await request(app)
      .post(`/access/${token}/encounters`)
      .set(worker)
      .send({ rawInput: raw, captureMethod: "VOICE" })
      .expect(201);
    expect(captured.body.status).toBe("CAPTURED");
    expect(captured.body.rawInput).toBe(raw);

    const id = captured.body.id as string;
    const before = await request(app).get("/patients/me/claims").set(patient).expect(200);

    await request(app)
      .post(`/access/${token}/encounters/${id}/draft`)
      .set(worker)
      .send({ source: "AI", items: [{ category: "ALLERGIES", value: "Penicillin" }] })
      .expect(200);

    const mid = await request(app).get("/patients/me/claims").set(patient).expect(200);
    expect(mid.body).toHaveLength(before.body.length);

    const reviewed = await request(app)
      .post(`/access/${token}/encounters/${id}/review`)
      .set(worker)
      .send({
        items: [
          { category: "ALLERGIES", value: "Penicillin (confirmed)" },
          { category: "RECENT_ENCOUNTERS", value: "Cough for three days" },
        ],
      })
      .expect(200);
    expect(reviewed.body.status).toBe("REVIEWED");
    expect(reviewed.body.createdClaimIds).toHaveLength(2);
    expect(reviewed.body.rawInput).toBe(raw);

    const after = await request(app).get("/patients/me/claims").set(patient).expect(200);
    expect(after.body).toHaveLength(before.body.length + 2);
    const added = (after.body as { value: string; status: string; source: string }[]).find(
      (c) => c.value === "Penicillin (confirmed)",
    );
    expect(added?.status).toBe("UNVERIFIED");
    expect(added?.source).toBe("Nurse Ada");
  });

  it("rejects a malformed draft and keeps the raw input", async () => {
    const app = makeApp();
    const token = await approved(app, ["RECENT_ENCOUNTERS"]);
    const captured = await request(app)
      .post(`/access/${token}/encounters`)
      .set(worker)
      .send({ rawInput: raw })
      .expect(201);
    const id = captured.body.id as string;
    await request(app)
      .post(`/access/${token}/encounters/${id}/draft`)
      .set(worker)
      .send({ items: [{ category: "NOT_A_CATEGORY", value: "x" }] })
      .expect(400);
    const still = await request(app).get(`/access/${token}/encounters/${id}`).set(worker).expect(200);
    expect(still.body.status).toBe("CAPTURED");
    expect(still.body.rawInput).toBe(raw);
  });

  it("needs the patient's approval for recording encounters", async () => {
    const app = makeApp();
    const token = await approved(app, ["ALLERGIES"]);
    const res = await request(app).post(`/access/${token}/encounters`).set(worker).send({ rawInput: raw }).expect(403);
    expect(res.body.error.code).toBe("SCOPE_NOT_APPROVED");
  });

  it("another worker cannot use this session, and a patient cannot record", async () => {
    const app = makeApp();
    const token = await approved(app, ["RECENT_ENCOUNTERS"]);
    const res = await request(app)
      .post(`/access/${token}/encounters`)
      .set(otherWorker)
      .send({ rawInput: raw })
      .expect(403);
    expect(res.body.error.code).toBe("NOT_SESSION_REQUESTER");
    await request(app).post(`/access/${token}/encounters`).set(patient).send({ rawInput: raw }).expect(403);
  });

  it("cannot review twice, and cannot record after access expires", async () => {
    const app = makeApp();
    const token = await approved(app, ["RECENT_ENCOUNTERS"]);
    const captured = await request(app)
      .post(`/access/${token}/encounters`)
      .set(worker)
      .send({ rawInput: raw })
      .expect(201);
    const id = captured.body.id as string;
    const body = { items: [{ category: "ALLERGIES", value: "Penicillin" }] };
    await request(app).post(`/access/${token}/encounters/${id}/review`).set(worker).send(body).expect(200);
    await request(app).post(`/access/${token}/encounters/${id}/review`).set(worker).send(body).expect(409);

    clock = new Date("2026-10-08T11:30:00Z");
    await request(app).post(`/access/${token}/encounters`).set(worker).send({ rawInput: raw }).expect(403);
  });
});
