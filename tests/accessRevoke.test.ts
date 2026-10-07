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
const other = { "x-actor-id": "pat_other", "x-actor-role": "PATIENT" };
const lookup = { medrekkCode: "mrk-82941", patientName: "Amaka Okafor" };
const ask = {
  requesterName: "Dr. Michael Adeyemi",
  requesterRole: "DOCTOR",
  requesterFacility: "General Hospital",
  reason: "Continuity of care",
  scopes: ["ALLERGIES", "CURRENT_MEDICATIONS"],
  durationMinutes: 120,
};

let clock = new Date("2026-10-06T12:00:00Z");
const makeApp = () => buildApp({ config, now: () => clock });
beforeEach(() => {
  clock = new Date("2026-10-06T12:00:00Z");
});

async function approvedSession(app: ReturnType<typeof makeApp>) {
  const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
  await request(app).post(`/access/${body.session}/request`).send(ask).expect(202);
  const pending = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
  const id = pending.body[0].id as string;
  await request(app).post(`/patients/me/access-requests/${id}/decision`).set(patient).send({ decision: "APPROVE" }).expect(200);
  return { token: body.session as string, id };
}

describe("requester facility", () => {
  it("is shown to the patient and written to the audit trail", async () => {
    const app = makeApp();
    const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
    await request(app).post(`/access/${body.session}/request`).send(ask).expect(202);
    const list = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
    expect(list.body[0].requester.facility).toBe("General Hospital");
    const audit = await request(app).get("/patients/me/audit").set(patient).expect(200);
    expect(JSON.stringify(audit.body)).toContain("General Hospital");
  });
  it("stays optional", async () => {
    const app = makeApp();
    const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
    const { requesterFacility: _unused, ...withoutFacility } = ask;
    await request(app).post(`/access/${body.session}/request`).send(withoutFacility).expect(202);
  });
});

describe("active access and revoke", () => {
  it("lists active access, then revoking ends it immediately", async () => {
    const app = makeApp();
    const { token, id } = await approvedSession(app);
    const active = await request(app).get("/patients/me/access-sessions?status=active").set(patient).expect(200);
    expect(active.body).toHaveLength(1);
    expect(active.body[0].id).toBe(id);
    await request(app).get(`/access/${token}/record`).expect(200);

    await request(app).post(`/patients/me/access-sessions/${id}/revoke`).set(patient).expect(200);

    const r = await request(app).get(`/access/${token}/record`).expect(403);
    expect(r.body.error.code).toBe("ACCESS_REVOKED");
    const activeAfter = await request(app).get("/patients/me/access-sessions?status=active").set(patient).expect(200);
    expect(activeAfter.body).toHaveLength(0);
    const past = await request(app).get("/patients/me/access-sessions?status=past").set(patient).expect(200);
    expect(past.body[0].status).toBe("REVOKED");
    const audit = await request(app).get("/patients/me/audit").set(patient).expect(200);
    expect(audit.body.some((e: { type: string }) => e.type === "ACCESS_REVOKED")).toBe(true);
  });

  it("cannot revoke twice, and another patient cannot revoke", async () => {
    const app = makeApp();
    const { id } = await approvedSession(app);
    await request(app).post(`/patients/me/access-sessions/${id}/revoke`).set(other).expect(404);
    await request(app).post(`/patients/me/access-sessions/${id}/revoke`).set(patient).expect(200);
    await request(app).post(`/patients/me/access-sessions/${id}/revoke`).set(patient).expect(409);
  });

  it("an expired access is past, not active, and not revocable", async () => {
    const app = makeApp();
    const { id } = await approvedSession(app);
    clock = new Date("2026-10-06T14:30:00Z");
    const active = await request(app).get("/patients/me/access-sessions?status=active").set(patient).expect(200);
    expect(active.body).toHaveLength(0);
    const past = await request(app).get("/patients/me/access-sessions?status=past").set(patient).expect(200);
    expect(past.body[0].status).toBe("EXPIRED");
    await request(app).post(`/patients/me/access-sessions/${id}/revoke`).set(patient).expect(409);
  });
});
