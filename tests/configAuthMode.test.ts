import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * dev mode trusts x-actor-id / x-actor-role headers with no token, so anyone who can reach
 * the server can act as any patient. These pin the three ways that must not happen quietly.
 */

const base = { JWT_SECRET: "x".repeat(32) };
const load = (env: Record<string, string>) => {
  const saved = process.env;
  process.env = { ...base, ...env } as NodeJS.ProcessEnv;
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
};

describe("AUTH_MODE fails closed", () => {
  it("defaults to jwt when the host never set it", () => {
    expect(load({}).AUTH_MODE).toBe("jwt");
  });

  it("still allows dev when asked for explicitly in development", () => {
    expect(load({ AUTH_MODE: "dev" }).AUTH_MODE).toBe("dev");
  });

  it("refuses dev in production", () => {
    expect(() => load({ NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow();
  });

  it("refuses dev whenever a real database is attached, whatever NODE_ENV says", () => {
    expect(() =>
      load({ AUTH_MODE: "dev", DATABASE_URL: "postgres://user@host:5432/db" }),
    ).toThrow();
  });
});
