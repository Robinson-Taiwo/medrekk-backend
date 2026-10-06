import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    AUTH_MODE: z.enum(["dev", "jwt"]).default("dev"),
    SEED_DEMO_DATA: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
  })
  .refine((e) => !(e.NODE_ENV === "production" && e.AUTH_MODE === "dev"), {
    message: "AUTH_MODE=dev is not allowed in production",
  });

export type AppConfig = z.infer<typeof envSchema>;
export const loadConfig = (): AppConfig => envSchema.parse(process.env);
