import { z } from "zod";
import { EVIDENCE_KINDS, type EvidenceKind } from "./types.js";

/**
 * Kinds a worker may attach by hand. ORIGINAL_CAPTURE is deliberately absent: it records where a claim
 * came from, which is provenance, not corroboration. Allowing it here would let a patient's own words
 * lift their own claim to EVIDENCE_BACKED. Only the review step writes that kind, and it never
 * changes a claim's status.
 */
const MANUAL_EVIDENCE_KINDS = [
  "LAB_REPORT",
  "PRESCRIPTION",
  "DOCUMENT",
  "PREVIOUS_RECORD",
  "PATIENT_CONFIRMATION",
  "PROFESSIONAL_CONFIRMATION",
] as const satisfies readonly EvidenceKind[];

void EVIDENCE_KINDS;

export const addEvidenceSchema = z.object({
  kind: z.enum(MANUAL_EVIDENCE_KINDS),
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
