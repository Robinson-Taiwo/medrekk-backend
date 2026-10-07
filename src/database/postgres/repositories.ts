import type { PatientProfile } from "../../shared/profile.js";
import type {
  AccessScope, AccessSession, AuditEvent, ClinicalClaim, EmergencyProfile, Evidence, Patient, SyncOperation,
  VerificationEvent,
} from "../../shared/types.js";
import type { Repositories } from "../repositories.js";
import type { Db, SqlValue } from "./db.js";

type DataRow<T> = { data: T };

const json = (value: object): string => JSON.stringify(value);

async function selectOne<T>(db: Db, text: string, values: SqlValue[]): Promise<T | undefined> {
  const res = await db.query<DataRow<T>>(text, values);
  return res.rows[0]?.data;
}

async function selectMany<T>(db: Db, text: string, values: SqlValue[]): Promise<T[]> {
  const res = await db.query<DataRow<T>>(text, values);
  return res.rows.map((row) => row.data);
}

async function run(db: Db, text: string, values: SqlValue[]): Promise<void> {
  await db.query(text, values);
}

export function createPostgresRepositories(db: Db): Repositories {
  return {
    patients: {
      findByCode: (code) => selectOne<Patient>(db, "SELECT data FROM patients WHERE medrekk_code = $1", [code]),
      findById: (id) => selectOne<Patient>(db, "SELECT data FROM patients WHERE id = $1", [id]),
      create: (p) =>
        run(
          db,
          `INSERT INTO patients (id, medrekk_code, data) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (id) DO UPDATE SET medrekk_code = EXCLUDED.medrekk_code, data = EXCLUDED.data`,
          [p.id, p.medrekkCode, json(p)],
        ),
    },
    profiles: {
      get: (patientId) => selectOne<PatientProfile>(db, "SELECT data FROM patient_profiles WHERE patient_id = $1", [patientId]),
      save: (patientId, profile) =>
        run(
          db,
          `INSERT INTO patient_profiles (patient_id, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (patient_id) DO UPDATE SET data = EXCLUDED.data`,
          [patientId, json(profile)],
        ),
    },
    sessions: {
      create: (s: AccessSession) =>
        run(db, "INSERT INTO access_sessions (id, token_hash, patient_id, data) VALUES ($1, $2, $3, $4::jsonb)", [
          s.id,
          s.tokenHash,
          s.patientId,
          json(s),
        ]),
      findByTokenHash: (hash) => selectOne<AccessSession>(db, "SELECT data FROM access_sessions WHERE token_hash = $1", [hash]),
      findById: (id) => selectOne<AccessSession>(db, "SELECT data FROM access_sessions WHERE id = $1", [id]),
      update: (s) => run(db, "UPDATE access_sessions SET data = $2::jsonb WHERE id = $1", [s.id, json(s)]),
      listForPatient: (patientId) =>
        selectMany<AccessSession>(db, "SELECT data FROM access_sessions WHERE patient_id = $1 ORDER BY seq", [patientId]),
    },
    records: {
      claimsFor: (patientId: string, scope: AccessScope) =>
        selectMany<ClinicalClaim>(db, "SELECT data FROM claims WHERE patient_id = $1 AND category = $2 ORDER BY seq", [
          patientId,
          scope,
        ]),
      allFor: (patientId: string) =>
        selectMany<ClinicalClaim>(db, "SELECT data FROM claims WHERE patient_id = $1 ORDER BY seq", [patientId]),
      findById: (claimId) => selectOne<ClinicalClaim>(db, "SELECT data FROM claims WHERE id = $1", [claimId]),
      add: (c) =>
        run(db, "INSERT INTO claims (id, patient_id, category, data) VALUES ($1, $2, $3, $4::jsonb)", [
          c.id,
          c.patientId,
          c.category,
          json(c),
        ]),
      update: (c) => run(db, "UPDATE claims SET category = $2, data = $3::jsonb WHERE id = $1", [c.id, c.category, json(c)]),
    },
    evidence: {
      add: (e: Evidence) =>
        run(db, "INSERT INTO evidence (id, claim_id, patient_id, data) VALUES ($1, $2, $3, $4::jsonb)", [
          e.id,
          e.claimId,
          e.patientId,
          json(e),
        ]),
      listForClaim: (claimId) => selectMany<Evidence>(db, "SELECT data FROM evidence WHERE claim_id = $1 ORDER BY seq", [claimId]),
    },
    verifications: {
      append: (v: VerificationEvent) =>
        run(db, "INSERT INTO verification_events (id, patient_id, data) VALUES ($1, $2, $3::jsonb)", [
          v.id,
          v.patientId,
          json(v),
        ]),
      listForPatient: (patientId) =>
        selectMany<VerificationEvent>(db, "SELECT data FROM verification_events WHERE patient_id = $1 ORDER BY seq", [
          patientId,
        ]),
    },
    emergency: {
      profileFor: (patientId) =>
        selectOne<EmergencyProfile>(db, "SELECT data FROM emergency_profiles WHERE patient_id = $1", [patientId]),
      save: (profile) =>
        run(
          db,
          `INSERT INTO emergency_profiles (patient_id, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (patient_id) DO UPDATE SET data = EXCLUDED.data`,
          [profile.patientId, json(profile)],
        ),
    },
    audit: {
      append: (e: AuditEvent) =>
        run(db, "INSERT INTO audit_events (id, patient_id, data) VALUES ($1, $2, $3::jsonb)", [e.id, e.patientId, json(e)]),
      listForPatient: (patientId) =>
        selectMany<AuditEvent>(db, "SELECT data FROM audit_events WHERE patient_id = $1 ORDER BY seq", [patientId]),
    },
    sync: {
      has: async (operationId) => {
        const res = await db.query<{ operation_id: string }>(
          "SELECT operation_id FROM sync_operations WHERE operation_id = $1",
          [operationId],
        );
        return res.rows.length > 0;
      },
      save: (op: SyncOperation, actorId: string) =>
        run(
          db,
          `INSERT INTO sync_operations (operation_id, actor_id, data) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (operation_id) DO UPDATE SET actor_id = EXCLUDED.actor_id, data = EXCLUDED.data`,
          [op.operationId, actorId, json(op)],
        ),
    },
  };
}
