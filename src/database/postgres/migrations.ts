import type { Db } from "./db.js";

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    sql: `
CREATE TABLE patients (
  id text PRIMARY KEY,
  medrekk_code text NOT NULL,
  data jsonb NOT NULL,
  CONSTRAINT patients_code_unique UNIQUE (medrekk_code)
);
CREATE TABLE patient_profiles (
  patient_id text PRIMARY KEY REFERENCES patients (id),
  data jsonb NOT NULL
);
CREATE TABLE emergency_profiles (
  patient_id text PRIMARY KEY REFERENCES patients (id),
  data jsonb NOT NULL
);
CREATE TABLE claims (
  seq bigserial NOT NULL,
  id text PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients (id),
  category text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX claims_patient_idx ON claims (patient_id, seq);
CREATE TABLE evidence (
  seq bigserial NOT NULL,
  id text PRIMARY KEY,
  claim_id text NOT NULL,
  patient_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX evidence_claim_idx ON evidence (claim_id, seq);
CREATE TABLE verification_events (
  seq bigserial NOT NULL,
  id text PRIMARY KEY,
  patient_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX verification_events_patient_idx ON verification_events (patient_id, seq);
CREATE TABLE access_sessions (
  seq bigserial NOT NULL,
  id text PRIMARY KEY,
  token_hash text NOT NULL,
  patient_id text NOT NULL REFERENCES patients (id),
  data jsonb NOT NULL,
  CONSTRAINT access_sessions_token_unique UNIQUE (token_hash)
);
CREATE INDEX access_sessions_patient_idx ON access_sessions (patient_id, seq);
CREATE TABLE audit_events (
  seq bigserial NOT NULL,
  id text PRIMARY KEY,
  patient_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX audit_events_patient_idx ON audit_events (patient_id, seq);
CREATE TABLE sync_operations (
  operation_id text PRIMARY KEY,
  actor_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  phone text,
  role text NOT NULL,
  data jsonb NOT NULL,
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_phone_unique UNIQUE (phone)
);
CREATE TABLE referrals (
  id text PRIMARY KEY,
  share_id_hash text NOT NULL,
  patient_id text NOT NULL REFERENCES patients (id),
  created_at text NOT NULL,
  data jsonb NOT NULL,
  CONSTRAINT referrals_share_unique UNIQUE (share_id_hash)
);
CREATE INDEX referrals_patient_idx ON referrals (patient_id, created_at DESC);
`,
  },
  {
    id: "002_encounters",
    sql: `
CREATE TABLE encounters (
  seq bigserial NOT NULL,
  id text PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients (id),
  worker_user_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX encounters_patient_idx ON encounters (patient_id, seq);
`,
  },
];

/** Applies any migration not yet recorded. Each one runs as a single multi-statement query, so it is atomic. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(done.rows.map((r) => r.id));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.query(`${m.sql}\nINSERT INTO schema_migrations (id) VALUES ('${m.id}');`);
    ran.push(m.id);
  }
  return ran;
}
