import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

/**
 * The bug these cover: a health worker's grant lived only in the handset's secure storage.
 * Signing out deleted it, and nothing on the server could hand it back — so the worker saw no
 * access while the patient went on seeing it running and could still revoke it.
 */

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
const otherWorker = { "x-actor-id": "hw_2", "x-actor-role": "HEALTH_WORKER" };
const lookup = { medrekkCode: "MRK-82941", patientName: "Amaka Okafor" };

const makeApp = () => buildApp({ config, now: () => new Date("2026-10-17T09:00:00Z") });
type TestApp = ReturnType<typeof makeApp>;

async function approvedFor(app: TestApp, who: Record<string, string>): Promise<string> {
  const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
  await request(app)
    .post(`/access/${body.session}/request`)
    .set(who)
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

describe("a worker picking their own grant back up", () => {
  it("still lists the grant after the device has thrown its token away", async () => {
    const app = makeApp();
    await approvedFor(app, worker);

    // Signing out no longer releases anything, so the server still holds it. This is the
    // state the worker used to come back to and be shown nothing at all.
    const { body } = await request(app).get("/access/mine").set(worker).expect(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ status: "APPROVED", patientName: "Amaka Okafor" });
  });

  it("hands back a working token, and the old one stops working", async () => {
    const app = makeApp();
    const first = await approvedFor(app, worker);

    const mine = await request(app).get("/access/mine").set(worker).expect(200);
    const resumed = await request(app)
      .post(`/access/mine/${mine.body[0].id as string}/resume`)
      .set(worker)
      .expect(200);

    expect(resumed.body.session).not.toBe(first);
    await request(app).get(`/access/${resumed.body.session as string}/record`).expect(200);
    // Rotation is the point: a token left on a phone the worker signed out of is dead.
    await request(app).get(`/access/${first}/status`).expect(404);
  });

  it("the patient's view and the worker's view agree", async () => {
    const app = makeApp();
    await approvedFor(app, worker);

    const theirs = await request(app).get("/patients/me/access-sessions").set(patient).expect(200);
    const ours = await request(app).get("/access/mine").set(worker).expect(200);
    expect(theirs.body).toHaveLength(1);
    expect(ours.body).toHaveLength(1);
    expect(ours.body[0].id).toBe(theirs.body[0].id);
  });

  it("a revoked grant disappears from the worker's list too", async () => {
    const app = makeApp();
    await approvedFor(app, worker);
    const theirs = await request(app).get("/patients/me/access-sessions").set(patient).expect(200);
    await request(app)
      .post(`/patients/me/access-sessions/${theirs.body[0].id as string}/revoke`)
      .set(patient)
      .expect(200);

    const ours = await request(app).get("/access/mine").set(worker).expect(200);
    expect(ours.body).toHaveLength(0);
  });

  it("does not hand one worker's grant to another", async () => {
    const app = makeApp();
    await approvedFor(app, worker);
    const mine = await request(app).get("/access/mine").set(worker).expect(200);

    const theirs = await request(app).get("/access/mine").set(otherWorker).expect(200);
    expect(theirs.body).toHaveLength(0);
    await request(app).post(`/access/mine/${mine.body[0].id as string}/resume`).set(otherWorker).expect(404);
  });

  it("needs a health-worker account, not just any caller", async () => {
    const app = makeApp();
    await approvedFor(app, worker);
    await request(app).get("/access/mine").expect(401);
    await request(app).get("/access/mine").set(patient).expect(403);
  });

  it("an expired grant cannot be picked up", async () => {
    // One app, one store, a clock that moves — otherwise this would only prove that a second
    // app starts empty, which is true of any store and tests nothing.
    let clock = new Date("2026-10-17T09:00:00Z");
    const app = buildApp({ config, now: () => clock });
    await approvedFor(app, worker);
    const mine = await request(app).get("/access/mine").set(worker).expect(200);
    const id = mine.body[0].id as string;

    clock = new Date("2026-10-17T12:00:00Z"); // three hours on; the grant ran for two
    const after = await request(app).get("/access/mine").set(worker).expect(200);
    expect(after.body).toHaveLength(0);
    await request(app).post(`/access/mine/${id}/resume`).set(worker).expect(410);
  });
});
