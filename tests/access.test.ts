import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test", PORT: 0, AUTH_MODE: "dev", SEED_DEMO_DATA: true, CORS_ORIGIN: "http://localhost:3000",
};
const patient = { "x-actor-id": "pat_demo_amaka", "x-actor-role": "PATIENT" };
const lookup = { medrekkCode: "mrk-82941", patientName: "  amaka  OKAFOR " };
const ask = {
  requesterName: "Dr. Michael Adeyemi", requesterRole: "DOCTOR", reason: "Continuity of care",
  scopes: ["ALLERGIES", "CURRENT_MEDICATIONS"], durationMinutes: 120,
};

let clock = new Date("2026-10-06T12:00:00Z");
const makeApp = () => buildApp({ config, now: () => clock });

beforeEach(() => { clock = new Date("2026-10-06T12:00:00Z"); });

async function pendingSession(app: ReturnType<typeof makeApp>) {
  const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
  await request(app).post(`/access/${body.session}/request`).send(ask).expect(202);
  const list = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
  return { token: body.session as string, requestId: list.body[0].id as string };
}

describe("normal access flow", () => {
  it("rejects wrong name with a generic 404", async () => {
    const app = makeApp();
    const r = await request(app).post("/access/lookup").send({ ...lookup, patientName: "Someone Else" });
    expect(r.status).toBe(404);
  });

  it("blocks the record until the patient approves, then returns only approved scopes", async () => {
    const app = makeApp();
    const { token, requestId } = await pendingSession(app);
    await request(app).get(`/access/${token}/record`).expect(409);
    await request(app).post(`/patients/me/access-requests/${requestId}/decision`)
      .set(patient).send({ decision: "APPROVE", approvedScopes: ["ALLERGIES"] }).expect(200);
    const rec = await request(app).get(`/access/${token}/record`).expect(200);
    expect(Object.keys(rec.body.data)).toEqual(["ALLERGIES"]);
    expect(JSON.stringify(rec.body)).not.toContain("Metformin");
  });

  it("denied access reveals nothing", async () => {
    const app = makeApp();
    const { token, requestId } = await pendingSession(app);
    await request(app).post(`/patients/me/access-requests/${requestId}/decision`)
      .set(patient).send({ decision: "DENY" }).expect(200);
    const r = await request(app).get(`/access/${token}/record`).expect(403);
    expect(r.body.error.message).toBe("Access denied by patient.");
  });

  it("expires after the granted window", async () => {
    const app = makeApp();
    const { token, requestId } = await pendingSession(app);
    await request(app).post(`/patients/me/access-requests/${requestId}/decision`)
      .set(patient).send({ decision: "APPROVE" }).expect(200);
    clock = new Date("2026-10-06T14:01:00Z");
    const r = await request(app).get(`/access/${token}/record`).expect(410);
    expect(r.body.error.message).toBe("This access session has expired.");
  });

  it("another patient cannot decide on this request", async () => {
    const app = makeApp();
    const { requestId } = await pendingSession(app);
    await request(app).post(`/patients/me/access-requests/${requestId}/decision`)
      .set({ "x-actor-id": "pat_other", "x-actor-role": "PATIENT" }).send({ decision: "APPROVE" }).expect(404);
  });
});

describe("emergency access", () => {
  it("returns only the minimal profile and logs the access", async () => {
    const app = makeApp();
    const r = await request(app).get("/emergency/MRK-82941?reason=Road%20accident").expect(200);
    expect(r.body.criticalAllergies).toEqual(["Penicillin"]);
    expect(r.body.patientId).toBeUndefined();
    const audit = await request(app).get("/patients/me/audit").set(patient).expect(200);
    expect(audit.body.some((e: { type: string }) => e.type === "EMERGENCY_ACCESSED")).toBe(true);
  });
});

describe("sync", () => {
  const worker = { "x-actor-id": "hw_1", "x-actor-role": "HEALTH_WORKER" };
  const op = {
    operationId: "op-12345678", entityType: "encounters", entityId: "enc_1", operation: "CREATE",
    payload: { chiefComplaint: "cough" }, createdAt: "2026-10-06T10:00:00Z",
  };
  it("is idempotent per operationId", async () => {
    const app = makeApp();
    const a = await request(app).post("/sync/push").set(worker).send({ operations: [op] }).expect(200);
    const b = await request(app).post("/sync/push").set(worker).send({ operations: [op] }).expect(200);
    expect(a.body.results[0].status).toBe("SYNCED");
    expect(b.body.results[0].status).toBe("DUPLICATE");
  });
  it("requires a health worker", async () => {
    await request(makeApp()).post("/sync/push").set(patient).send({ operations: [op] }).expect(401);
  });
});
