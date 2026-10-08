import { checkServerIdentity as verifyName, type PeerCertificate } from "node:tls";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { Client, Pool, PoolConfig, QueryResult, QueryResultRow } from "pg";

export type SqlValue = string | number | boolean | null;

export interface Db {
  query<R extends QueryResultRow>(text: string, values?: SqlValue[]): Promise<QueryResult<R>>;
}

export interface SslEnv {
  DATABASE_SSL_CA?: string | undefined;
  DATABASE_SSL_INSECURE?: string | undefined;
  DATABASE_SSL_SERVERNAME?: string | undefined;
}

/**
 * Builds connection settings. The sslmode in the URL is removed and applied explicitly,
 * so the CA file or the insecure flag actually takes effect.
 */
export function connectionConfig(connectionString: string, env: SslEnv): PoolConfig {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  url.searchParams.delete("uselibpqcompat");
  const base: PoolConfig = { connectionString: url.toString() };
  if (mode === null || mode === "disable") return base;
  if (env.DATABASE_SSL_CA) {
    const ca = readFileSync(env.DATABASE_SSL_CA, "utf8");
    const servername = env.DATABASE_SSL_SERVERNAME ?? process.env.DATABASE_SSL_SERVERNAME;
    if (!servername) return { ...base, ssl: { ca } };
    return {
      ...base,
      ssl: { ca, checkServerIdentity: (_host: string, cert: PeerCertificate) => verifyName(servername, cert) },
    };
  }
  if (env.DATABASE_SSL_INSECURE === "true") return { ...base, ssl: { rejectUnauthorized: false } };
  return { ...base, ssl: true };
}

export function createPool(connectionString: string, env: SslEnv): Pool {
  console.log("Database host:", new URL(connectionString).hostname);
  const pool = new pg.Pool({ ...connectionConfig(connectionString, env), max: 10, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));
  return pool;
}

export const poolDb = (pool: Pool): Db => ({ query: (text, values) => pool.query(text, values) });

export const clientDb = (client: Client): Db => ({ query: (text, values) => client.query(text, values) });
