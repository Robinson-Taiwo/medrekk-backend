import { z } from "zod";
import { CAPTURE_METHODS, CLAIM_CATEGORIES } from "./encounterTypes.js";

export const captureEncounterSchema = z.object({
  /**
   * The client may supply the id. An encounter captured with no connection is given its
   * identity on the handset, so that when it finally syncs it is the same encounter rather
   * than a second copy — and a replayed upload is recognised instead of duplicated.
   */
  id: z.string().trim().regex(/^enc_[A-Za-z0-9-]{8,64}$/).optional(),
  rawInput: z.string().trim().min(3).max(5000),
  captureMethod: z.enum(CAPTURE_METHODS).default("TEXT"),
});
export type CaptureEncounterInput = z.infer<typeof captureEncounterSchema>;

const draftItemSchema = z.object({
  category: z.enum(CLAIM_CATEGORIES),
  value: z.string().trim().min(2).max(300),
  excerpt: z.string().trim().max(500).optional(),
});

export const encounterDraftSchema = z.object({
  source: z.enum(["AI", "WORKER"]).default("AI"),
  items: z.array(draftItemSchema).max(40),
});
export type EncounterDraftInput = z.infer<typeof encounterDraftSchema>;

export const encounterReviewSchema = z.object({
  items: z.array(draftItemSchema).max(40),
});
export type EncounterReviewInput = z.infer<typeof encounterReviewSchema>;

/** Document kinds only. A patient cannot file a professional's confirmation. */
export const PATIENT_EVIDENCE_KINDS = ["LAB_REPORT", "PRESCRIPTION", "DOCUMENT", "PREVIOUS_RECORD"] as const;

export const selfEntrySchema = z.object({
  /** The capture itself: OCR output, dictation or typing. Never rewritten afterwards. */
  note: z.string().trim().min(3).max(5000),
  captureMethod: z.enum(CAPTURE_METHODS).default("PHOTO"),
  evidenceKind: z.enum(PATIENT_EVIDENCE_KINDS).default("DOCUMENT"),
  /**
   * What was pulled out of the note. Allowed to be empty: a discharge summary whose extraction
   * found nothing nameable is still a document the patient wants kept, and refusing it would
   * throw away the one copy they have in order to protect a list of tags.
   */
  items: z.array(draftItemSchema).max(20).default([]),
  origin: z
    .object({
      facility: z.string().trim().max(160).optional(),
      clinician: z.string().trim().max(160).optional(),
      documentDate: z.string().trim().max(40).optional(),
    })
    .optional(),
  /** Hex SHA-256 of the image the patient keeps. Computed on the device. */
  imageHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/, "imageHash must be a hex SHA-256.")
    .optional(),
  textSource: z.enum(["OCR", "TYPED", "DICTATED"]).default("TYPED"),
});
export type SelfEntryInput = z.infer<typeof selfEntrySchema>;
