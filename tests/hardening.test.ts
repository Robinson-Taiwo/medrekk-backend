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

describe("response headers", () => {
  it("sends no-referrer and no-store", async () => {
    const res = await request(buildApp({ config })).get("/health").expect(200);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
