import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
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

let clock = new Date("2026-10-07T12:00:00Z");
const makeApp = () => buildApp({ config, now: () => clock });
type TestApp = ReturnType<typeof makeApp>;

beforeEach(() => {
  clock = new Date("2026-10-07T12:00:00Z");
});

async function login(app: TestApp, email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: "demo-pass-123" });
  expect(typeof res.body.token).toBe("string");
  return { Authorization: `Bearer ${res.body.token as string}` };
}

const baseBody = {
  destinationFacility: "General Hospital Ilorin",
  reason: "Specialist review of persistent cough",
  note: "Patient is travelling tomorrow.",
  claimIds: ["clm_1", "clm_2"],
};

async function createReferral(app: TestApp, auth: { Authorization: string }, body: object = baseBody) {
  const res = await request(app).post("/patients/me/referrals").set(auth).send(body).expect(201);
  return res.body as { id: string; shareId: string; status: string; items: { claimId: string }[]; expiresAt: string };
}

describe("referrals", () => {
  it("lets a patient create a referral from their own claims", async () => {
    const app = makeApp();
    const auth = await login(app, "amaka@demo.medrekk");
    const ref = await createReferral(app, auth);
    expect(ref.id).toMatch(/^ref_/);
    expect(ref.shareId.length).toBeGreaterThanOrEqual(40);
    expect(ref.status).toBe("ACTIVE");
    expect(ref.items.map((i) => i.claimId).sort()).toEqual(["clm_1", "clm_2"]);
    expect(Date.parse(ref.expiresAt)).toBe(Date.parse("2026-10-14T12:00:00Z"));
  });

  it("public view shows only the attached items, sets Referrer-Policy and never leaks internal ids", async () => {
    const app = makeApp();
    const auth = await login(app, "amaka@demo.medrekk");
    const ref = await createReferral(app, auth);
    const view = await request(app).get(`/referral/${ref.shareId}`).expect(200);
    expect(view.headers["referrer-policy"]).toBe("no-referrer");
    expect(view.body.patient.medrekkCode).toBe("MRK-82941");
    expect(view.body.items).toHaveLength(2);
    const text = JSON.stringify(view.body);
    expect(text).toContain("Penicillin");
    expect(text).not.toContain("Type 2 diabetes");
    expect(text).not.toContain("pat_");
    expect(text).not.toContain("usr_");
  });

  it("audits creation and every view for the patient", async () => {
    const app = makeApp();
    const auth = await login(app, "amaka@demo.medrekk");
    const ref = await createReferral(app, auth);
    await request(app).get(`/referral/${ref.shareId}`).expect(200);
    await request(app).get(`/referral/${ref.shareId}`).expect(200);
    const audit = await request(app).get("/patients/me/audit").set(auth).expect(200);
    const types = (audit.body as { type: string }[]).map((e) => e.type);
    expect(types).toContain("REFERRAL_CREATED");
    expect(types.filter((t) => t === "REFERRAL_VIEWED")).toHaveLength(2);
  });

  it("revoking makes the link return 410", async () => {
    const app = makeApp();
    const auth = await login(app, "amaka@demo.medrekk");
    const ref = await createReferral(app, auth);
    await request(app).post(`/patients/me/referrals/${ref.id}/revoke`).set(auth).expect(200);
    const view = await request(app).get(`/referral/${ref.shareId}`).expect(410);
    expect(view.body.error.code).toBe("REFERRAL_REVOKED");
    const list = await request(app).get("/patients/me/referrals").set(auth).expect(200);
    expect(list.body[0].status).toBe("REVOKED");
  });

  it("expires after the chosen window", async () => {
    const app = makeApp();
    const auth = await login(app, "amaka@demo.medrekk");
    const ref = await createReferral(app, auth, { ...baseBody, expiresInDays: 1 });
    clock = new Date("2026-10-09T12:00:00Z");
    const view = await request(app).get(`/referral/${ref.shareId}`).expect(410);
    expect(view.body.error.code).toBe("REFERRAL_EXPIRED");
    const list = await request(app).get("/patients/me/referrals").set(auth).expect(200);
    expect(list.body[0].status).toBe("EXPIRED");
  });

  it("rejects unknown claims and claims that belong to another patient", async () => {
    const app = makeApp();
    const amaka = await login(app, "amaka@demo.medrekk");
    await request(app)
      .post("/patients/me/referrals")
      .set(amaka)
      .send({ ...baseBody, claimIds: ["clm_does_not_exist"] })
      .expect(400);

    const signup = { email: "ada@example.com", password: "password-123", fullName: "Ada Obi", role: "PATIENT" };
    const reg = await request(app).post("/auth/register").send(signup).expect(201);
    const ada = { Authorization: `Bearer ${reg.body.token as string}` };
    const res = await request(app).post("/patients/me/referrals").set(ada).send(baseBody).expect(400);
    expect(res.body.error.code).toBe("CLAIM_NOT_FOUND");
  });

  it("only the owner can revoke", async () => {
    const app = makeApp();
    const amaka = await login(app, "amaka@demo.medrekk");
    const ref = await createReferral(app, amaka);
    const signup = { email: "ada@example.com", password: "password-123", fullName: "Ada Obi", role: "PATIENT" };
    const reg = await request(app).post("/auth/register").send(signup).expect(201);
    const ada = { Authorization: `Bearer ${reg.body.token as string}` };
    await request(app).post(`/patients/me/referrals/${ref.id}/revoke`).set(ada).expect(404);
    await request(app).get(`/referral/${ref.shareId}`).expect(200);
  });

  it("requires a signed-in patient to create, list or revoke", async () => {
    const app = makeApp();
    await request(app).post("/patients/me/referrals").send(baseBody).expect(401);
    const nurse = await login(app, "nurse@demo.medrekk");
    await request(app).post("/patients/me/referrals").set(nurse).send(baseBody).expect(403);
    await request(app).get("/patients/me/referrals").set(nurse).expect(403);
  });

  it("handles bad and unknown share IDs", async () => {
    const app = makeApp();
    await request(app).get("/referral/short").expect(400);
    await request(app).get(`/referral/${"a".repeat(43)}`).expect(404);
  });
});
