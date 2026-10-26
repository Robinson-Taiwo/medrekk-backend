import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { PushMessage, PushSender } from "../src/services/notify/pushService.js";

/**
 * The consent model assumes the patient notices a request inside the few minutes it stays
 * open. These pin who gets told what, and — just as important — that nothing here can fail
 * the request that triggered it.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: false,
  CORS_ORIGIN: "http://localhost:3000",
  EXPO_PUSH_ENABLED: false,
};

class Recorder implements PushSender {
  sent: { tokens: readonly string[]; message: PushMessage }[] = [];
  async send(tokens: readonly string[], message: PushMessage): Promise<void> {
    this.sent.push({ tokens, message });
  }
}

class Broken implements PushSender {
  async send(): Promise<void> {
    throw new Error("Expo is down");
  }
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const PATIENT_TOKEN = "ExponentPushToken[patient-handset]";
const WORKER_TOKEN = "ExponentPushToken[worker-handset]";

async function scenario(push: PushSender) {
  const app = buildApp({ config, push, now: () => new Date("2026-10-26T09:00:00Z") });

  const patient = await request(app)
    .post("/auth/register")
    .send({ email: "amaka@demo.test", password: "a-good-password", fullName: "Amaka Okafor", role: "PATIENT" })
    .expect(201);
  const worker = await request(app)
    .post("/auth/register")
    .send({ email: "doc@clinic.test", password: "a-good-password", fullName: "Dr A. Bello", role: "HEALTH_WORKER" })
    .expect(201);

  await request(app).post("/auth/me/push-token").set(bearer(patient.body.token)).send({ token: PATIENT_TOKEN }).expect(204);
  await request(app).post("/auth/me/push-token").set(bearer(worker.body.token)).send({ token: WORKER_TOKEN }).expect(204);

  const me = await request(app).get("/patients/me").set(bearer(patient.body.token)).expect(200);
  const lookup = await request(app)
    .post("/access/lookup")
    .send({ medrekkCode: me.body.medrekkCode, patientName: "Amaka Okafor" })
    .expect(201);

  await request(app)
    .post(`/access/${lookup.body.session}/request`)
    .set(bearer(worker.body.token))
    .send({
      requesterName: "Dr A. Bello",
      requesterRole: "DOCTOR",
      reason: "Clinic visit",
      requesterFacility: "Ilorin General",
      scopes: ["ALLERGIES"],
      durationMinutes: 120,
    })
    .expect(202);

  return { app, patientToken: patient.body.token as string, session: lookup.body.session as string };
}

describe("who gets told what", () => {
  it("tells the patient when their record is asked for", async () => {
    const push = new Recorder();
    await scenario(push);

    expect(push.sent).toHaveLength(1);
    const first = push.sent[0];
    expect(first?.tokens).toEqual([PATIENT_TOKEN]);
    expect(first?.message.title).toBe("Someone wants to read your record");
    expect(first?.message.body).toContain("Dr A. Bello");
    expect(first?.message.body).toContain("Ilorin General");
    expect(first?.message.data?.kind).toBe("ACCESS_REQUEST");
  });

  it("tells the worker when the patient approves, and when they end it", async () => {
    const push = new Recorder();
    const { app, patientToken } = await scenario(push);

    const pending = await request(app).get("/patients/me/access-requests").set(bearer(patientToken)).expect(200);
    await request(app)
      .post(`/patients/me/access-requests/${pending.body[0].id as string}/decision`)
      .set(bearer(patientToken))
      .send({ decision: "APPROVE" })
      .expect(200);

    const approved = push.sent.at(-1);
    expect(approved?.tokens).toEqual([WORKER_TOKEN]);
    expect(approved?.message.title).toBe("Access approved");

    const live = await request(app).get("/patients/me/access-sessions").set(bearer(patientToken)).expect(200);
    await request(app)
      .post(`/patients/me/access-sessions/${live.body[0].id as string}/revoke`)
      .set(bearer(patientToken))
      .expect(200);

    const ended = push.sent.at(-1);
    expect(ended?.tokens).toEqual([WORKER_TOKEN]);
    expect(ended?.message.title).toBe("Access ended");
  });

  it("tells the worker when the patient declines", async () => {
    const push = new Recorder();
    const { app, patientToken } = await scenario(push);

    const pending = await request(app).get("/patients/me/access-requests").set(bearer(patientToken)).expect(200);
    await request(app)
      .post(`/patients/me/access-requests/${pending.body[0].id as string}/decision`)
      .set(bearer(patientToken))
      .send({ decision: "DENY" })
      .expect(200);

    expect(push.sent.at(-1)?.message.title).toBe("Access declined");
  });

  it("a notification that cannot be sent does not fail the request that triggered it", async () => {
    // The access request is the thing that matters. A patient can always open the app.
    const { app, patientToken } = await scenario(new Broken());
    const pending = await request(app).get("/patients/me/access-requests").set(bearer(patientToken)).expect(200);
    expect(pending.body).toHaveLength(1);
  });

  it("forgets a handset on request, so the next person holding it is not told", async () => {
    const push = new Recorder();
    const app = buildApp({ config, push, now: () => new Date("2026-10-26T09:00:00Z") });
    const patient = await request(app)
      .post("/auth/register")
      .send({ email: "amaka@demo.test", password: "a-good-password", fullName: "Amaka Okafor", role: "PATIENT" })
      .expect(201);

    await request(app).post("/auth/me/push-token").set(bearer(patient.body.token)).send({ token: PATIENT_TOKEN }).expect(204);
    await request(app).delete("/auth/me/push-token").set(bearer(patient.body.token)).send({ token: PATIENT_TOKEN }).expect(204);

    const me = await request(app).get("/patients/me").set(bearer(patient.body.token)).expect(200);
    const lookup = await request(app)
      .post("/access/lookup")
      .send({ medrekkCode: me.body.medrekkCode, patientName: "Amaka Okafor" })
      .expect(201);
    await request(app)
      .post(`/access/${lookup.body.session}/request`)
      .send({ requesterName: "Someone", requesterRole: "DOCTOR", reason: "Visit", scopes: ["ALLERGIES"], durationMinutes: 60 })
      .expect(202);

    expect(push.sent).toHaveLength(0);
  });

  it("needs a signed-in account to register a handset", async () => {
    const app = buildApp({ config, now: () => new Date("2026-10-26T09:00:00Z") });
    await request(app).post("/auth/me/push-token").send({ token: PATIENT_TOKEN }).expect(401);
  });
});
