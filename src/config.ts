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
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AUTH_MODE === "dev"), {
    message: "AUTH_MODE=dev is not allowed in production",
  });

export type AppConfig = z.infer<typeof envSchema>;
export const loadConfig = (): AppConfig => envSchema.parse(process.env);
