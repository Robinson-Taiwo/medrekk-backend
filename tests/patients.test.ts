import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: false,
  CORS_ORIGIN: "http://localhost:3000",
};

const signup = { email: "ada@example.com", password: "password-123", fullName: "Ada Obi", role: "PATIENT" };

async function registered() {
  const app = buildApp({ config });
  const res = await request(app).post("/auth/register").send(signup).expect(201);
  const auth = { Authorization: `Bearer ${res.body.token as string}` };
  return { app, auth, user: res.body.user as { patientId: string | null } };
}

describe("self-sufficient patient", () => {
  it("registration creates a real patient with a MedRekk Code", async () => {
    const { app, auth, user } = await registered();
    expect(user.patientId).toMatch(/^pat_/);
    const me = await request(app).get("/patients/me").set(auth).expect(200);
    expect(me.body.fullName).toBe("Ada Obi");
    expect(me.body.medrekkCode).toMatch(/^MRK-[A-Z0-9]{6}$/);
    expect(JSON.stringify(me.body)).not.toContain("pat_");
  });

  it("has an empty emergency profile that doctors can look up by code", async () => {
    const { app, auth } = await registered();
    const me = await request(app).get("/patients/me").set(auth).expect(200);
    const r = await request(app).get(`/emergency/${me.body.medrekkCode as string}`).expect(200);
    expect(r.body.criticalAllergies).toEqual([]);
    expect(r.body.verificationStatus).toBe("UNVERIFIED");
  });

  it("self-entered claims are always SELF_REPORTED, even if the client asks for more", async () => {
    const { app, auth } = await registered();
    const created = await request(app).post("/patients/me/claims").set(auth)
      .send({ category: "ALLERGIES", value: "Peanuts", status: "CLINICALLY_VERIFIED", source: "Hospital" })
      .expect(201);
    expect(created.body.status).toBe("SELF_REPORTED");
    expect(created.body.source).toBe("Patient");
    expect(created.body.patientId).toBeUndefined();
    const list = await request(app).get("/patients/me/claims").set(auth).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it("updating the emergency profile marks it SELF_REPORTED", async () => {
    const { app, auth } = await registered();
    const put = await request(app).put("/patients/me/emergency-profile").set(auth)
      .send({ criticalAllergies: ["Penicillin"], bloodGroup: "O+" }).expect(200);
    expect(put.body.verificationStatus).toBe("SELF_REPORTED");
    const get = await request(app).get("/patients/me/emergency-profile").set(auth).expect(200);
    expect(get.body.criticalAllergies).toEqual(["Penicillin"]);
    expect(get.body.bloodGroup).toBe("O+");
  });

  it("health workers cannot use patient endpoints", async () => {
    const app = buildApp({ config });
    const res = await request(app).post("/auth/register")
      .send({ ...signup, email: "hw@example.com", role: "HEALTH_WORKER" }).expect(201);
    await request(app).get("/patients/me").set({ Authorization: `Bearer ${res.body.token as string}` }).expect(403);
  });

  it("requires authentication", async () => {
    await request(buildApp({ config })).get("/patients/me").expect(401);
  });
});

describe("auth edge cases", () => {
  it("rejects a duplicate email with 409", async () => {
    const app = buildApp({ config });
    await request(app).post("/auth/register").send(signup).expect(201);
    const r = await request(app).post("/auth/register").send(signup).expect(409);
    expect(r.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("returns INVALID_JSON for a malformed body", async () => {
    const r = await request(buildApp({ config })).post("/auth/login")
      .set("Content-Type", "application/json").send("{bad").expect(400);
    expect(r.body.error.code).toBe("INVALID_JSON");
  });
});