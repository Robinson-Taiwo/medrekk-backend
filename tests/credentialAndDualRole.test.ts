import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

/**
 * Two things that used to be impossible: an approver seeing anything about the worker they
 * are approving, and a clinician holding their own record on the same account.
 */

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: false,
  CORS_ORIGIN: "http://localhost:3000",
  EXPO_PUSH_ENABLED: false,
  ADMIN_EMAILS: "boss@clinic.test",
};

const makeApp = () => buildApp({ config, now: () => new Date("2026-10-26T09:00:00Z") });
type TestApp = ReturnType<typeof makeApp>;

const PNG = "iVBORw0KGgo=".repeat(20); // long enough to clear the minimum

async function registerUser(
  app: TestApp,
  email: string,
  role: "PATIENT" | "HEALTH_WORKER",
  fullName: string,
): Promise<{ token: string; id: string }> {
  const { body } = await request(app)
    .post("/auth/register")
    .send({ email, password: "a-good-password", fullName, role })
    .expect(201);
  return { token: body.token as string, id: body.user.id as string };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const submission = {
  body: "MDCN",
  number: "MD/2019/44821",
  profession: "Medical officer",
  image: { mime: "image/png", base64: PNG },
};

describe("a worker submitting a licence", () => {
  it("gives the approver a register, a number and a photograph", async () => {
    const app = makeApp();
    const admin = await registerUser(app, "boss@clinic.test", "HEALTH_WORKER", "Boss Person");
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");

    await request(app).post("/auth/me/credential").set(bearer(worker.token)).send(submission).expect(200);

    const list = await request(app).get("/admin/health-workers").set(bearer(admin.token)).expect(200);
    const row = list.body.find((w: { id: string }) => w.id === worker.id);
    expect(row.licence).toMatchObject({ body: "MDCN", number: "MD/2019/44821", profession: "Medical officer" });
    expect(row.hasDocument).toBe(true);

    const doc = await request(app)
      .get(`/admin/health-workers/${worker.id}/licence`)
      .set(bearer(admin.token))
      .expect(200);
    expect(doc.body.mime).toBe("image/png");
    expect(doc.body.base64).toBe(PNG);
  });

  it("keeps the image out of the worker listing", async () => {
    const app = makeApp();
    const admin = await registerUser(app, "boss@clinic.test", "HEALTH_WORKER", "Boss Person");
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    await request(app).post("/auth/me/credential").set(bearer(worker.token)).send(submission).expect(200);

    const list = await request(app).get("/admin/health-workers").set(bearer(admin.token)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(PNG);
  });

  it("returns an approved worker to pending if they swap the document", async () => {
    const app = makeApp();
    const admin = await registerUser(app, "boss@clinic.test", "HEALTH_WORKER", "Boss Person");
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    await request(app).post("/auth/me/credential").set(bearer(worker.token)).send(submission).expect(200);
    await request(app)
      .post(`/admin/health-workers/${worker.id}/credential`)
      .set(bearer(admin.token))
      .send({ status: "APPROVED" })
      .expect(200);

    // An approval refers to the document it was given, so a new one cannot inherit the tick.
    const again = await request(app)
      .post("/auth/me/credential")
      .set(bearer(worker.token))
      .send({ ...submission, number: "MD/2019/00000" })
      .expect(200);
    expect(again.body.credentialStatus).toBe("PENDING");
  });

  it("is refused to a patient account, and the photograph to a non-admin", async () => {
    const app = makeApp();
    const patient = await registerUser(app, "amaka@demo.test", "PATIENT", "Amaka Okafor");
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    await request(app).post("/auth/me/credential").set(bearer(worker.token)).send(submission).expect(200);

    await request(app).post("/auth/me/credential").set(bearer(patient.token)).send(submission).expect(403);
    await request(app).get(`/admin/health-workers/${worker.id}/licence`).set(bearer(worker.token)).expect(403);
    await request(app).get(`/admin/health-workers/${worker.id}/licence`).expect(401);
  });

  it("refuses an image too large for a request body", async () => {
    const app = makeApp();
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    await request(app)
      .post("/auth/me/credential")
      .set(bearer(worker.token))
      .send({ ...submission, image: { mime: "image/png", base64: "A".repeat(700_001) } })
      .expect(400);
  });
});

describe("a clinician holding their own record", () => {
  it("gains a record on the same account, and a token that carries it", async () => {
    const app = makeApp();
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");

    // Before: a health worker account has no record of its own.
    await request(app).get("/patients/me").set(bearer(worker.token)).expect(403);

    const added = await request(app).post("/auth/me/patient-record").set(bearer(worker.token)).expect(201);
    expect(added.body.user.patientId).toBeTruthy();
    expect(added.body.user.role).toBe("HEALTH_WORKER");

    const me = await request(app).get("/patients/me").set(bearer(added.body.token)).expect(200);
    expect(me.body.medrekkCode).toBeTruthy();
    expect(me.body.fullName).toBe("Dr A. Bello");
  });

  it("can keep their own entries, and still work as a clinician", async () => {
    const app = makeApp();
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    const { body } = await request(app).post("/auth/me/patient-record").set(bearer(worker.token)).expect(201);
    const token = body.token as string;

    await request(app)
      .post("/patients/me/claims")
      .set(bearer(token))
      .send({ category: "ALLERGIES", value: "Sulfa drugs" })
      .expect(201);
    const claims = await request(app).get("/patients/me/claims").set(bearer(token)).expect(200);
    expect(claims.body).toHaveLength(1);

    // The clinician side is untouched: still a health worker, still awaiting approval.
    const mine = await request(app).get("/access/mine").set(bearer(token)).expect(200);
    expect(mine.body).toEqual([]);
  });

  it("is idempotent — asking twice does not mint a second record", async () => {
    const app = makeApp();
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    const first = await request(app).post("/auth/me/patient-record").set(bearer(worker.token)).expect(201);
    const second = await request(app).post("/auth/me/patient-record").set(bearer(worker.token)).expect(201);
    expect(second.body.user.patientId).toBe(first.body.user.patientId);
  });

  it("does not let a patient act as a health worker", async () => {
    const app = makeApp();
    const patient = await registerUser(app, "amaka@demo.test", "PATIENT", "Amaka Okafor");
    // Being a clinician is an assertion somebody else approves, so it is still gated on role.
    await request(app).get("/access/mine").set(bearer(patient.token)).expect(403);
  });

  it("still keeps one patient out of another's record", async () => {
    const app = makeApp();
    const worker = await registerUser(app, "doc@clinic.test", "HEALTH_WORKER", "Dr A. Bello");
    const { body } = await request(app).post("/auth/me/patient-record").set(bearer(worker.token)).expect(201);
    const other = await registerUser(app, "amaka@demo.test", "PATIENT", "Amaka Okafor");

    await request(app)
      .post("/patients/me/claims")
      .set(bearer(other.token))
      .send({ category: "ALLERGIES", value: "Penicillin" })
      .expect(201);

    // The clinician's own record is their own and holds nothing of hers.
    const mine = await request(app).get("/patients/me/claims").set(bearer(body.token as string)).expect(200);
    expect(mine.body).toEqual([]);
  });
});
