import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    AUTH_MODE: z.enum(["dev", "jwt"]).default("dev"),
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
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AUTH_MODE === "dev"), {
    message: "AUTH_MODE=dev is not allowed in production",
  });

export type AppConfig = z.infer<typeof envSchema>;
export const loadConfig = (): AppConfig => envSchema.parse(process.env);
