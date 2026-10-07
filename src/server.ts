import { buildApp, type AppOptions } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, poolDb } from "./database/postgres/db.js";
import { migrate } from "./database/postgres/migrations.js";
import { createPostgresReferralRepository } from "./database/postgres/referrals.js";
import { createPostgresRepositories } from "./database/postgres/repositories.js";
import { createPostgresUserRepository } from "./database/postgres/users.js";
import { parseKey } from "./utils/crypto.js";

async function main(): Promise<void> {
  const config = loadConfig();
  let options: AppOptions = { config };
  let closeDb: (() => Promise<void>) | undefined;

  if (config.DATABASE_URL) {
    if (!config.DATA_ENCRYPTION_KEY) throw new Error("DATA_ENCRYPTION_KEY is required when DATABASE_URL is set.");
    const key = parseKey(config.DATA_ENCRYPTION_KEY);
    if (config.DATABASE_SSL_INSECURE === "true" && config.NODE_ENV === "production") {
      throw new Error("DATABASE_SSL_INSECURE is not allowed in production. Set DATABASE_SSL_CA instead.");
    }
    if (config.DATABASE_SSL_INSECURE === "true") console.warn("WARNING: database certificate is not verified.");
    const pool = createPool(config.DATABASE_URL, config);
    const db = poolDb(pool);
    const ran = await migrate(db);
    console.log(ran.length > 0 ? `Applied migrations: ${ran.join(", ")}` : "Database schema is up to date.");
    if (config.SEED_DEMO_DATA) console.log("SEED_DEMO_DATA is ignored with Postgres. Register new accounts.");
    options = {
      config: { ...config, SEED_DEMO_DATA: false },
      repos: createPostgresRepositories(db),
      users: createPostgresUserRepository(db),
      referrals: createPostgresReferralRepository(db, key),
    };
    closeDb = () => pool.end();
    console.log("Storage: Postgres");
  } else {
    console.log("Storage: in memory (data is lost on restart)");
  }

  const server = buildApp(options).listen(config.PORT, "0.0.0.0", () => {
    console.log(`MedRekk backend listening on :${config.PORT} (auth=${config.AUTH_MODE})`);
  });

  const stop = (): void => {
    server.close(() => {
      const closing = closeDb ? closeDb() : Promise.resolve();
      void closing.finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err: Error) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
