import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    /**
     * Defaults to jwt, deliberately. dev mode trusts x-actor-id / x-actor-role headers with
     * no token at all, so anyone who can reach the server can act as any patient. Defaulting
     * to dev meant a host that simply never set AUTH_MODE served an open record store while
     * looking entirely normal — a missing variable should fail closed, not open.
     */
    AUTH_MODE: z.enum(["dev", "jwt"]).default("jwt"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    SEED_DEMO_DATA: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    // Comma-separated account emails allowed to approve health-worker credentials. Optional; blank means no admins.
    ADMIN_EMAILS: z.string().optional(),
    // Postgres connection string. When set, data is stored in Postgres instead of memory.
    DATABASE_URL: z.string().optional(),
    // 32 random bytes, base64. Encrypts referral share IDs at rest. Required when DATABASE_URL is set.
    DATA_ENCRYPTION_KEY: z.string().optional(),
    // Path to the database server's CA certificate (PEM). Keeps full certificate verification on.
    DATABASE_SSL_CA: z.string().optional(),
    // "true" encrypts but does not verify the database's identity. Local testing only; refused in production.
    DATABASE_SSL_INSECURE: z.enum(["true", "false"]).optional(),
    // Secret the USSD aggregator must send in x-ussd-secret. Left unset, /ussd is open,
    // which is fine for a local simulator and not for production.
    USSD_SHARED_SECRET: z.string().min(16).optional(),
    // "true" sends push notifications through Expo. Left unset, the app works unchanged and
    // nothing is sent — the consent flow never depended on a notification arriving.
    EXPO_PUSH_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AUTH_MODE === "dev"), {
    message: "AUTH_MODE=dev is not allowed in production",
  })
  // NODE_ENV is easy to leave unset on a host; a database full of real records is not. If
  // data is being persisted, header auth is wrong whatever NODE_ENV happens to say.
  .refine((e) => !(e.DATABASE_URL !== undefined && e.DATABASE_URL !== "" && e.AUTH_MODE === "dev"), {
    message: "AUTH_MODE=dev is not allowed when DATABASE_URL is set",
  });

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Refusing to start is the right answer to a misconfigured environment — a server that boots
 * anyway and serves records without checking tokens is worse than one that is down. But the
 * only thing the operator sees is one line in a log, so that line has to name the variable
 * and the fix rather than printing a parser's JSON at them.
 */
export const loadConfig = (): AppConfig => {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.join(".");
    return where.length > 0 ? `${where}: ${issue.message}` : issue.message;
  });
  throw new Error(`Refusing to start. Fix the environment:\n  - ${problems.join("\n  - ")}`);
};
