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
  ADMIN_EMAILS: "admin@example.com",
};

type App = ReturnType<typeof buildApp>;
type Bearer = Record<string, string>;
interface Account { auth: Bearer; id: string }

async function register(app: App, email: string, role: "PATIENT" | "HEALTH_WORKER"): Promise<Account> {
  const res = await request(app)
    .post("/auth/register")
    .send({ email, password: "password-123", fullName: "Test Person", role })
    .expect(201);
  return { auth: { Authorization: `Bearer ${res.body.token as string}` }, id: res.body.user.id as string };
}

async function loginDemoPatient(app: App): Promise<Bearer> {
  const res = await request(app).post("/auth/login").send({ email: "amaka@demo.medrekk", password: "demo-pass-123" });
  expect([200, 201]).toContain(res.status);
  return { Authorization: `Bearer ${res.body.token as string}` };
}

// Worker requests PAST_MEDICAL_HISTORY on the demo patient, patient approves. Returns the session token.
async function approvedSession(app: App, worker: Bearer): Promise<string> {
  const patient = await loginDemoPatient(app);
  const lookup = await request(app)
    .post("/access/lookup")
    .send({ medrekkCode: "MRK-82941", patientName: "Amaka Okafor" })
    .expect(201);
  const session = lookup.body.session as string;
  await request(app)
    .post(`/access/${session}/request`)
    .set(worker)
    .send({
      requesterName: "Test Worker", requesterRole: "NURSE", reason: "Follow-up visit",
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

describe("credential approval", () => {
  it("an admin approves a pending worker, who can then clinically verify", async () => {
    const app = buildApp({ config });
    const admin = await register(app, "admin@example.com", "PATIENT");
    const worker = await register(app, "pending@example.com", "HEALTH_WORKER");
    const session = await approvedSession(app, worker.auth);

    const before = await request(app)
      .post(`/access/${session}/claims/clm_4/verify`)
      .set(worker.auth)
      .send({ method: "Reviewed history with patient" })
      .expect(403);
    expect(before.body.error.code).toBe("CREDENTIAL_NOT_APPROVED");

    const list = await request(app).get("/admin/health-workers?status=PENDING").set(admin.auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].email).toBe("pending@example.com");
    expect(list.body[0].passwordHash).toBeUndefined();

    const approved = await request(app)
      .post(`/admin/health-workers/${worker.id}/credential`)
      .set(admin.auth)
      .send({ status: "APPROVED" })
      .expect(200);
    expect(approved.body.credentialStatus).toBe("APPROVED");

    const after = await request(app)
      .post(`/access/${session}/claims/clm_4/verify`)
      .set(worker.auth)
      .send({ method: "Reviewed history with patient" })
      .expect(200);
    expect(after.body.claim.status).toBe("CLINICALLY_VERIFIED");
  });

  it("revoking returns a worker to PENDING and every change is logged", async () => {
    const app = buildApp({ config });
    const admin = await register(app, "admin@example.com", "PATIENT");
    const worker = await register(app, "pending@example.com", "HEALTH_WORKER");
    const url = `/admin/health-workers/${worker.id}/credential`;

    await request(app).post(url).set(admin.auth).send({ status: "APPROVED" }).expect(200);
    await request(app).post(url).set(admin.auth).send({ status: "PENDING" }).expect(200);
    await request(app).post(url).set(admin.auth).send({ status: "PENDING" }).expect(200); // no change, not logged

    const log = await request(app).get("/admin/credential-log").set(admin.auth).expect(200);
    expect(log.body).toHaveLength(2);
    expect(log.body[0].previousStatus).toBe("PENDING");
    expect(log.body[0].newStatus).toBe("APPROVED");
    expect(log.body[1].newStatus).toBe("PENDING");
    expect(log.body[0].adminEmail).toBe("admin@example.com");
  });

  it("non-admins get 403 and anonymous callers get 401", async () => {
    const app = buildApp({ config });
    const worker = await register(app, "pending@example.com", "HEALTH_WORKER");
    const patient = await loginDemoPatient(app);

    await request(app).get("/admin/health-workers").set(worker.auth).expect(403);
    await request(app).get("/admin/credential-log").set(patient).expect(403);
    // A pending worker cannot approve themselves.
    await request(app)
      .post(`/admin/health-workers/${worker.id}/credential`)
      .set(worker.auth)
      .send({ status: "APPROVED" })
      .expect(403);
    await request(app).get("/admin/health-workers").expect(401);
    await request(app).post(`/admin/health-workers/${worker.id}/credential`).send({ status: "APPROVED" }).expect(401);
  });

  it("returns 404 for an unknown user and 400 for a non-health-worker account", async () => {
    const app = buildApp({ config });
    const admin = await register(app, "admin@example.com", "PATIENT");
    const missing = await request(app)
      .post("/admin/health-workers/usr_does_not_exist/credential")
      .set(admin.auth)
      .send({ status: "APPROVED" })
      .expect(404);
    expect(missing.body.error.code).toBe("USER_NOT_FOUND");

    const wrongRole = await request(app)
      .post(`/admin/health-workers/${admin.id}/credential`)
      .set(admin.auth)
      .send({ status: "APPROVED" })
      .expect(400);
    expect(wrongRole.body.error.code).toBe("NOT_A_HEALTH_WORKER");

    await request(app)
      .post(`/admin/health-workers/${admin.id}/credential`)
      .set(admin.auth)
      .send({ status: "MAYBE" })
      .expect(400);
  });
});
