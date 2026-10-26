import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "dev",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: true,
  CORS_ORIGIN: "http://localhost:3000",
  EXPO_PUSH_ENABLED: false,
};

const patient = { "x-actor-id": "pat_demo_amaka", "x-actor-role": "PATIENT" };
const worker = { "x-actor-id": "hw_1", "x-actor-role": "HEALTH_WORKER" };
const lookup = { medrekkCode: "MRK-82941", patientName: "Amaka Okafor" };

const makeApp = () => buildApp({ config, now: () => new Date("2026-10-17T09:00:00Z") });
type TestApp = ReturnType<typeof makeApp>;

async function approved(app: TestApp): Promise<string> {
  const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
  await request(app)
    .post(`/access/${body.session}/request`)
    .set(worker)
    .send({
      requesterName: "Dr A. Bello",
      requesterRole: "DOCTOR",
      reason: "Clinic visit",
      scopes: ["ALLERGIES"],
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

const activeCount = async (app: TestApp): Promise<number> => {
  const { body } = await request(app).get("/patients/me/access-sessions").set(patient).expect(200);
  return (body as unknown[]).length;
};

describe("a worker handing access back", () => {
  it("stops the patient being told somebody can see their record", async () => {
    const app = makeApp();
    const token = await approved(app);
    expect(await activeCount(app)).toBe(1);

    await request(app).post(`/access/${token}/release`).expect(200);

    // The point of the whole fix: the patient's list is honest again.
    expect(await activeCount(app)).toBe(0);
  });

  it("closes the session so the token cannot read the record afterwards", async () => {
    const app = makeApp();
    const token = await approved(app);
    await request(app).get(`/access/${token}/record`).set(worker).expect(200);

    await request(app).post(`/access/${token}/release`).expect(200);

    const after = await request(app).get(`/access/${token}/record`).set(worker);
    expect(after.status).not.toBe(200);
  });

  it("tells the patient's log that the worker gave it back, not that they withdrew it", async () => {
    const app = makeApp();
    const token = await approved(app);
    await request(app).post(`/access/${token}/release`).expect(200);

    const audit = await request(app).get("/patients/me/audit").set(patient).expect(200);
    const types = (audit.body.items as { type: string }[]).map((e) => e.type);
    expect(types).toContain("ACCESS_RELEASED");
    expect(types).not.toContain("ACCESS_REVOKED");
  });

  it("is safe to call twice", async () => {
    const app = makeApp();
    const token = await approved(app);
    await request(app).post(`/access/${token}/release`).expect(200);
    const again = await request(app).post(`/access/${token}/release`).expect(200);
    expect(again.body.status).toBe("REVOKED");
  });
});
