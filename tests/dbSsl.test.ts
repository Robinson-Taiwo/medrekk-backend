import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerCertificate } from "node:tls";
import { describe, expect, it } from "vitest";
import { connectionConfig } from "../src/database/postgres/db.js";

const dir = mkdtempSync(join(tmpdir(), "ca-"));
const caFile = join(dir, "ca.pem");
writeFileSync(caFile, "placeholder");

const cert = { subject: { CN: "pg-bfcb6b" }, subjectaltname: "DNS:pg-bfcb6b" } as PeerCertificate;

function sslOf(env: { DATABASE_SSL_CA?: string; DATABASE_SSL_SERVERNAME?: string }) {
  const cfg = connectionConfig("postgresql://u:p@db.example.com:5432/app?sslmode=require", env);
  if (typeof cfg.ssl !== "object") throw new Error("expected ssl options");
  return cfg.ssl;
}

describe("database TLS server name", () => {
  it("verifies against the chosen name instead of the connection host", () => {
    const ssl = sslOf({ DATABASE_SSL_CA: caFile, DATABASE_SSL_SERVERNAME: "pg-bfcb6b" });
    expect(ssl.checkServerIdentity?.("db.example.com", cert)).toBeUndefined();
  });

  it("still rejects a certificate that does not match the chosen name", () => {
    const ssl = sslOf({ DATABASE_SSL_CA: caFile, DATABASE_SSL_SERVERNAME: "some-other-name" });
    expect(ssl.checkServerIdentity?.("db.example.com", cert)).toBeInstanceOf(Error);
  });

  it("keeps normal host verification when no server name is set", () => {
    const ssl = sslOf({ DATABASE_SSL_CA: caFile });
    expect(ssl.checkServerIdentity).toBeUndefined();
  });
});
