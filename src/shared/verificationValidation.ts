import { z } from "zod";
import { EVIDENCE_KINDS } from "./types.js";

export const addEvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  description: z.string().trim().min(3).max(300),
});
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;

// The method is free text ("Examined patient", "Lab report reviewed") and is stored on the verification event.
export const verifyClaimSchema = z.object({
  method: z.string().trim().min(3).max(200),
});
export type VerifyClaimInput = z.infer<typeof verifyClaimSchema>;

// Emergency profile: EVIDENCE_BACKED needs any worker in an approved session; CLINICALLY_VERIFIED needs an approved credential.
export const verifyProfileSchema = z.object({
  level: z.enum(["EVIDENCE_BACKED", "CLINICALLY_VERIFIED"]),
  method: z.string().trim().min(3).max(200),
});
export type VerifyProfileInput = z.infer<typeof verifyProfileSchema>;
