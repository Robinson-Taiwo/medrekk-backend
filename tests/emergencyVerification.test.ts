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

async function login(app: App, email: string): Promise<Bearer> {
  const res = await request(app).post("/auth/login").send({ email, password: "demo-pass-123" });
  expect([200, 201]).toContain(res.status);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

async function pendingWorker(app: App): Promise<Bearer> {
  const res = await request(app).post("/auth/register")
    .send({ email: "pending@example.com", password: "password-123", fullName: "Pending Worker", role: "HEALTH_WORKER" })
    .expect(201);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

// Worker looks up the demo patient and requests the given scopes; the patient approves. Returns the session token.
async function approvedSession(app: App, worker: Bearer, scopes: string[]): Promise<string> {
  const patient = await login(app, "amaka@demo.medrekk");
  const lookup = await request(app).post("/access/lookup")
    .send({ medrekkCode: "MRK-82941", patientName: "Amaka Okafor" }).expect(201);
  const session = lookup.body.session as string;
  await request(app).post(`/access/${session}/request`).set(worker)
    .send({ requesterName: "Test Worker", requesterRole: "NURSE", reason: "Continuity of care", scopes, durationMinutes: 120 })
    .expect(202);
  const list = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
  await request(app).post(`/patients/me/access-requests/${list.body[0].id as string}/decision`)
    .set(patient).send({ decision: "APPROVE" }).expect(200);
  return session;
}

async function patientSavesProfile(app: App): Promise<void> {
  const patient = await login(app, "amaka@demo.medrekk");
  const res = await request(app).put("/patients/me/emergency-profile").set(patient)
    .send({ criticalAllergies: ["Penicillin"], bloodGroup: "O+" }).expect(200);
  expect(res.body.verificationStatus).toBe("SELF_REPORTED");
}

describe("emergency profile verification", () => {
  it("an approved nurse can clinically verify, and the patient edit drops it back to self-reported", async () => {
    const app = buildApp({ config });
    await patientSavesProfile(app);
    const nurse = await login(app, "nurse@demo.medrekk");
    const session = await approvedSession(app, nurse, ["EMERGENCY_INFORMATION"]);

    const review = await request(app).get(`/access/${session}/emergency-profile`).set(nurse).expect(200);
    expect(review.body.criticalAllergies).toEqual(["Penicillin"]);
    expect(review.body.patientId).toBeUndefined();

    const ok = await request(app).post(`/access/${session}/emergency-profile/verify`).set(nurse)
      .send({ level: "CLINICALLY_VERIFIED", method: "Reviewed with patient" }).expect(200);
    expect(ok.body.profile.verificationStatus).toBe("CLINICALLY_VERIFIED");
    expect(ok.body.profile.verifiedByName).toBeTruthy();

    const publicView = await request(app).get("/emergency/MRK-82941").expect(200);
    expect(publicView.body.verificationStatus).toBe("CLINICALLY_VERIFIED");
    expect(publicView.body.verifiedByName).toBeTruthy();
    expect(publicView.body.verifiedAt).toBeTruthy();
    expect(publicView.body.verificationMethod).toBeUndefined();

    await request(app).post(`/access/${session}/emergency-profile/verify`).set(nurse)
      .send({ level: "CLINICALLY_VERIFIED", method: "Again" }).expect(409);

    const patient = await login(app, "amaka@demo.medrekk");
    await request(app).put("/patients/me/emergency-profile").set(patient)
      .send({ criticalAllergies: ["Penicillin", "Peanuts"] }).expect(200);
    const after = await request(app).get("/emergency/MRK-82941").expect(200);
    expect(after.body.verificationStatus).toBe("SELF_REPORTED");
    expect(after.body.verifiedByName).toBeUndefined();

    const audit = await request(app).get("/patients/me/audit").set(patient).expect(200);
    const types: string[] = audit.body.map((e: { type: string }) => e.type);
    expect(types).toContain("EMERGENCY_PROFILE_VERIFIED");
  });

  it("a worker without an approved credential can only reach evidence-backed", async () => {
    const app = buildApp({ config });
    await patientSavesProfile(app);
    const pending = await pendingWorker(app);
    const session = await approvedSession(app, pending, ["EMERGENCY_INFORMATION"]);

    const denied = await request(app).post(`/access/${session}/emergency-profile/verify`).set(pending)
      .send({ level: "CLINICALLY_VERIFIED", method: "Looked at it" }).expect(403);
    expect(denied.body.error.code).toBe("CREDENTIAL_NOT_APPROVED");

    const ok = await request(app).post(`/access/${session}/emergency-profile/verify`).set(pending)
      .send({ level: "EVIDENCE_BACKED", method: "Saw prescription" }).expect(200);
    expect(ok.body.profile.verificationStatus).toBe("EVIDENCE_BACKED");
  });

  it("is refused when the session did not include emergency information", async () => {
    const app = buildApp({ config });
    const nurse = await login(app, "nurse@demo.medrekk");
    const session = await approvedSession(app, nurse, ["ALLERGIES"]);
    const r = await request(app).post(`/access/${session}/emergency-profile/verify`).set(nurse)
      .send({ level: "EVIDENCE_BACKED", method: "Looked at it" }).expect(403);
    expect(r.body.error.code).toBe("SCOPE_NOT_APPROVED");
  });

  it("is refused for a worker who did not request the session, and for patients", async () => {
    const app = buildApp({ config });
    const nurse = await login(app, "nurse@demo.medrekk");
    const session = await approvedSession(app, nurse, ["EMERGENCY_INFORMATION"]);
    const other = await pendingWorker(app);
    await request(app).post(`/access/${session}/emergency-profile/verify`).set(other)
      .send({ level: "EVIDENCE_BACKED", method: "Looked at it" }).expect(403);
    const patient = await login(app, "amaka@demo.medrekk");
    await request(app).post(`/access/${session}/emergency-profile/verify`).set(patient)
      .send({ level: "EVIDENCE_BACKED", method: "Looked at it" }).expect(403);
  });
});
