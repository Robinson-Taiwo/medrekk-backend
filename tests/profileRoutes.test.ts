import request from "supertest";
import { describe, expect, it } from "vitest";
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
const worker = { "x-actor-id": "usr_demo_nurse", "x-actor-role": "HEALTH_WORKER" };

describe("profile routes", () => {
  it("starts empty", async () => {
    const app = buildApp({ config });
    const res = await request(app).get("/patients/me/profile").set(patient).expect(200);
    expect(res.body).toEqual({ dateOfBirth: null, gender: null });
  });

  it("saves and merges a partial update", async () => {
    const app = buildApp({ config });
    await request(app).patch("/patients/me/profile").set(patient).send({ dateOfBirth: "1990-05-20" }).expect(200);
    const res = await request(app).patch("/patients/me/profile").set(patient).send({ gender: "FEMALE" }).expect(200);
    expect(res.body).toEqual({ dateOfBirth: "1990-05-20", gender: "FEMALE" });
    const read = await request(app).get("/patients/me/profile").set(patient).expect(200);
    expect(read.body).toEqual({ dateOfBirth: "1990-05-20", gender: "FEMALE" });
  });

  it("rejects an empty body, an impossible date and unknown fields", async () => {
    const app = buildApp({ config });
    await request(app).patch("/patients/me/profile").set(patient).send({}).expect(400);
    await request(app).patch("/patients/me/profile").set(patient).send({ dateOfBirth: "1990-02-30" }).expect(400);
    await request(app).patch("/patients/me/profile").set(patient).send({ bloodGroup: "O+" }).expect(400);
  });

  it("is for patients only", async () => {
    const app = buildApp({ config });
    await request(app).get("/patients/me/profile").set(worker).expect(403);
    await request(app).patch("/patients/me/profile").set(worker).send({ gender: "MALE" }).expect(403);
  });
});

describe("phone at registration over HTTP", () => {
  it("rejects the same number in a different format with PHONE_TAKEN", async () => {
    const app = buildApp({ config });
    const body = { password: "password-123", fullName: "Test Person", role: "PATIENT" };
    await request(app).post("/auth/register").send({ ...body, email: "a@example.com", phone: "0803 123 4567" });
    const res = await request(app)
      .post("/auth/register")
      .send({ ...body, email: "b@example.com", phone: "+234 803 123 4567" })
      .expect(409);
    expect(res.body.error.code).toBe("PHONE_TAKEN");
  });
});
