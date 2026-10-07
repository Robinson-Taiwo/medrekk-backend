import { randomBytes } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { User } from "../src/auth/userRepository.js";
import type { AppConfig } from "../src/config.js";
import { clientDb, connectionConfig, type Db } from "../src/database/postgres/db.js";
import { migrate } from "../src/database/postgres/migrations.js";
import { createPostgresReferralRepository } from "../src/database/postgres/referrals.js";
import { createPostgresRepositories } from "../src/database/postgres/repositories.js";
import { createPostgresUserRepository } from "../src/database/postgres/users.js";
import type { Referral } from "../src/shared/referralTypes.js";
import type { AccessSession, AuditEvent, ClinicalClaim, EmergencyProfile, Patient, SyncOperation } from "../src/shared/types.js";
import { parseKey } from "../src/utils/crypto.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const LONG = 60_000;

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: false,
  CORS_ORIGIN: "http://localhost:3000",
};

suite("postgres adapter", () => {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const client = new pg.Client(url ? connectionConfig(url, process.env) : {});
  const key = parseKey(randomBytes(32).toString("base64"));
  let db: Db;

  const patient: Patient = { id: "pat_t1", medrekkCode: "MRK-TEST01", fullName: "Test Patient", createdAt: "2026-10-07T10:00:00.000Z" };

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    db = clientDb(client);
    await migrate(db);
    await createPostgresRepositories(db).patients.create(patient);
  }, LONG);

  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }, LONG);

  it("migrations are idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
  }, LONG);

  it("stores and returns records in order", async () => {
    const repos = createPostgresRepositories(db);
    expect((await repos.patients.findByCode("MRK-TEST01"))?.fullName).toBe("Test Patient");
    expect(await repos.patients.findByCode("MRK-NOPE00")).toBeUndefined();

    const claim = (id: string, category: ClinicalClaim["category"], value: string): ClinicalClaim => ({
      id, patientId: patient.id, category, value, status: "SELF_REPORTED", source: "Patient",
    });
    await repos.records.add(claim("c1", "ALLERGIES", "Penicillin"));
    await repos.records.add(claim("c2", "CURRENT_MEDICATIONS", "Metformin"));
    await repos.records.add(claim("c3", "ALLERGIES", "Peanuts"));
    await repos.records.update({ ...claim("c1", "ALLERGIES", "Penicillin"), status: "EVIDENCE_BACKED" });
    expect((await repos.records.allFor(patient.id)).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect((await repos.records.claimsFor(patient.id, "ALLERGIES")).map((c) => c.id)).toEqual(["c1", "c3"]);
    expect((await repos.records.findById("c1"))?.status).toBe("EVIDENCE_BACKED");

    const event = (id: string): AuditEvent => ({
      id, patientId: patient.id, type: "RECORD_VIEWED", accessType: "NORMAL", occurredAt: "2026-10-07T10:00:00.000Z",
    });
    await repos.audit.append(event("a1"));
    await repos.audit.append(event("a2"));
    expect((await repos.audit.listForPatient(patient.id)).map((e) => e.id)).toEqual(["a1", "a2"]);

    const session: AccessSession = {
      id: "ses_t1", tokenHash: "hash-1", patientId: patient.id, status: "AWAITING_REQUEST", requestedScopes: [],
      approvedScopes: [], createdAt: "2026-10-07T10:00:00.000Z", expiresAt: "2026-10-07T10:30:00.000Z",
    };
    await repos.sessions.create(session);
    await repos.sessions.update({ ...session, status: "PENDING" });
    expect((await repos.sessions.findByTokenHash("hash-1"))?.status).toBe("PENDING");
    expect((await repos.sessions.listForPatient(patient.id)).length).toBe(1);

    const profile: EmergencyProfile = {
      patientId: patient.id, criticalAllergies: ["Penicillin"], criticalConditions: [], criticalMedications: [],
      implantedDevices: [], importantWarnings: [], verificationStatus: "SELF_REPORTED",
    };
    await repos.emergency.save(profile);
    await repos.emergency.save({ ...profile, bloodGroup: "O+" });
    expect((await repos.emergency.profileFor(patient.id))?.bloodGroup).toBe("O+");

    await repos.profiles.save(patient.id, { dateOfBirth: "1990-05-20", updatedAt: "2026-10-07T10:00:00.000Z" });
    expect((await repos.profiles.get(patient.id))?.dateOfBirth).toBe("1990-05-20");

    const op: SyncOperation = {
      operationId: "op_1", entityType: "claims", entityId: "c1", operation: "CREATE", payload: {}, createdAt: "2026-10-07T10:00:00.000Z",
    };
    expect(await repos.sync.has("op_1")).toBe(false);
    await repos.sync.save(op, "usr_1");
    expect(await repos.sync.has("op_1")).toBe(true);
  }, LONG);

  it("enforces unique email and phone", async () => {
    const users = createPostgresUserRepository(db);
    const user = (id: string, email: string, phone?: string): User => ({
      id, email, passwordHash: "x", fullName: "U", role: "PATIENT", patientId: null, facility: null,
      credentialStatus: null, createdAt: "2026-10-07T10:00:00.000Z", ...(phone ? { phone } : {}),
    });
    await users.create(user("u1", "one@example.com", "+2348031234567"));
    await expect(users.create(user("u2", "one@example.com"))).rejects.toMatchObject({ status: 409, code: "EMAIL_TAKEN" });
    await expect(users.create(user("u3", "three@example.com", "+2348031234567"))).rejects.toMatchObject({
      status: 409, code: "PHONE_TAKEN",
    });
    expect((await users.findByPhone("+2348031234567"))?.id).toBe("u1");
    expect((await users.findByEmail("one@example.com"))?.id).toBe("u1");
  }, LONG);

  it("encrypts share IDs at rest but returns them in clear", async () => {
    const referrals = createPostgresReferralRepository(db, key);
    const shareId = "S".repeat(43);
    const referral = { id: "ref_t1", shareId, patientId: patient.id, createdAt: "2026-10-07T10:00:00.000Z" } as Referral;
    await referrals.create(referral);
    const raw = await client.query<{ raw: string }>("SELECT data::text AS raw FROM referrals WHERE id = 'ref_t1'");
    expect(raw.rows[0]?.raw.includes(shareId)).toBe(false);
    expect((await referrals.findByShareId(shareId))?.shareId).toBe(shareId);
    expect((await referrals.listForPatient(patient.id))[0]?.shareId).toBe(shareId);
    expect(await referrals.findByShareId("T".repeat(43))).toBeUndefined();
  }, LONG);

  it("keeps data across an app restart", async () => {
    const makeApp = () =>
      buildApp({
        config,
        repos: createPostgresRepositories(db),
        users: createPostgresUserRepository(db),
        referrals: createPostgresReferralRepository(db, key),
      });
    const credentials = { email: "persist@example.com", password: "password-123" };
    const first = makeApp();
    const registered = await request(first)
      .post("/auth/register")
      .send({ ...credentials, fullName: "Persist Person", role: "PATIENT" });
    expect(registered.status).toBeLessThan(300);
    const token = registered.body.token as string;
    await request(first)
      .post("/patients/me/claims")
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "ALLERGIES", value: "Penicillin" })
      .expect(201);

    const second = makeApp();
    const login = await request(second).post("/auth/login").send(credentials).expect(200);
    const claims = await request(second)
      .get("/patients/me/claims")
      .set("Authorization", `Bearer ${login.body.token as string}`)
      .expect(200);
    expect(claims.body).toHaveLength(1);
    expect(claims.body[0].status).toBe("SELF_REPORTED");
    const me = await request(second).get("/patients/me").set("Authorization", `Bearer ${login.body.token as string}`).expect(200);
    expect(me.body.medrekkCode).toMatch(/^MRK-/);
    await request(second).post("/auth/register").send({ ...credentials, fullName: "Persist Person", role: "PATIENT" }).expect(409);
  }, LONG);
});
