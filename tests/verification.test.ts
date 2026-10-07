import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: true,
  CORS_ORIGIN: "http://localhost:3000",
};

type App = ReturnType<typeof buildApp>;
type Bearer = Record<string, string>;

async function login(app: App, email: string, password: string): Promise<Bearer> {
  const res = await request(app).post("/auth/login").send({ email, password });
  expect([200, 201]).toContain(res.status);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

async function registerWorker(app: App, email: string): Promise<Bearer> {
  const res = await request(app)
    .post("/auth/register")
    .send({ email, password: "password-123", fullName: "Pending Worker", role: "HEALTH_WORKER" })
    .expect(201);
  expect(res.body.user.credentialStatus).toBe("PENDING");
  return { Authorization: `Bearer ${res.body.token as string}` };
}

// Provider looks up the demo patient, requests PAST_MEDICAL_HISTORY, patient approves. Returns the session token.
async function approvedSession(app: App, worker: Bearer = {}): Promise<string> {
  const patient = await login(app, "amaka@demo.medrekk", "demo-pass-123");
  const lookup = await request(app)
    .post("/access/lookup")
    .send({ medrekkCode: "MRK-82941", patientName: "Amaka Okafor" })
    .expect(201);
  const session = lookup.body.session as string;
  await request(app)
    .post(`/access/${session}/request`)
    .set(worker)
    .send({
      requesterName: "Nurse Ngozi", requesterRole: "NURSE", reason: "Follow-up visit",
      scopes: ["PAST_MEDICAL_HISTORY"], durationMinutes: 60,
    })
    .expect(202);
  const pending = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
  await request(app)
    .post(`/patients/me/access-requests/${pending.body[0].id as string}/decision`)
    .set(patient)
    .send({ decision: "APPROVE" })
    .expect(200);
  return session;
}

describe("health worker verification", () => {
  it("an approved worker verifies a claim inside the approved scope, and the patient can see who did it", async () => {
    const app = buildApp({ config });
    const nurse = await login(app, "nurse@demo.medrekk", "demo-pass-123");
    const session = await approvedSession(app, nurse);

    const res = await request(app)
      .post(`/access/${session}/claims/clm_4/verify`)
      .set(nurse)
      .send({ method: "Reviewed history with patient" })
      .expect(200);
    expect(res.body.claim.status).toBe("CLINICALLY_VERIFIED");
    expect(res.body.claim.value).toBe("Type 2 diabetes (2021)");
    expect(res.body.claim.patientId).toBeUndefined();

    const patient = await login(app, "amaka@demo.medrekk", "demo-pass-123");
    const events = await request(app).get("/patients/me/verifications").set(patient).expect(200);
    expect(events.body).toHaveLength(1);
    expect(events.body[0].verifierName).toBe("Ngozi Eze");
    expect(events.body[0].previousStatus).toBe("SELF_REPORTED");
    expect(events.body[0].resultingStatus).toBe("CLINICALLY_VERIFIED");
    expect(events.body[0].credentialApproved).toBe(true);
  });

  it("a pending worker can attach evidence but cannot clinically verify", async () => {
    const app = buildApp({ config });
    const pendingWorker = await registerWorker(app, "pending@example.com");
    const session = await approvedSession(app, pendingWorker);

    const ev = await request(app)
      .post(`/access/${session}/claims/clm_4/evidence`)
      .set(pendingWorker)
      .send({ kind: "PRESCRIPTION", description: "Metformin prescription on file" })
      .expect(201);
    expect(ev.body.claim.status).toBe("EVIDENCE_BACKED");

    const res = await request(app)
      .post(`/access/${session}/claims/clm_4/verify`)
      .set(pendingWorker)
      .send({ method: "Examined patient" })
      .expect(403);
    expect(res.body.error.code).toBe("CREDENTIAL_NOT_APPROVED");
  });

  it("cannot verify a claim outside the approved scopes", async () => {
    const app = buildApp({ config });
    const nurse = await login(app, "nurse@demo.medrekk", "demo-pass-123");
    const session = await approvedSession(app, nurse);
    const res = await request(app)
      .post(`/access/${session}/claims/clm_1/verify`)
      .set(nurse)
      .send({ method: "Examined patient" })
      .expect(404);
    expect(res.body.error.code).toBe("CLAIM_NOT_FOUND");
  });

  it("cannot verify in a session another account requested, or an anonymous one", async () => {
    const app = buildApp({ config });
    const nurse = await login(app, "nurse@demo.medrekk", "demo-pass-123");
    const other = await registerWorker(app, "other@example.com");

    const nurseSession = await approvedSession(app, nurse);
    const a = await request(app)
      .post(`/access/${nurseSession}/claims/clm_4/verify`)
      .set(other)
      .send({ method: "Examined patient" })
      .expect(403);
    expect(a.body.error.code).toBe("NOT_SESSION_REQUESTER");

    const anonymousSession = await approvedSession(app);
    const b = await request(app)
      .post(`/access/${anonymousSession}/claims/clm_4/verify`)
      .set(nurse)
      .send({ method: "Examined patient" })
      .expect(403);
    expect(b.body.error.code).toBe("NOT_SESSION_REQUESTER");
  });

  it("requires authentication, and a patient token is forbidden", async () => {
    const app = buildApp({ config });
    const fakeSession = "a".repeat(24);
    await request(app).post(`/access/${fakeSession}/claims/clm_4/verify`).send({ method: "x-ray" }).expect(401);
    const patient = await login(app, "amaka@demo.medrekk", "demo-pass-123");
    await request(app)
      .post(`/access/${fakeSession}/claims/clm_4/verify`)
      .set(patient)
      .send({ method: "x-ray" })
      .expect(403);
  });
});
