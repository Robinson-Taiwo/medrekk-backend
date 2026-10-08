import { z } from "zod";
import { CAPTURE_METHODS, CLAIM_CATEGORIES } from "./encounterTypes.js";

export const captureEncounterSchema = z.object({
  rawInput: z.string().trim().min(3).max(5000),
  captureMethod: z.enum(CAPTURE_METHODS).default("TEXT"),
});
export type CaptureEncounterInput = z.infer<typeof captureEncounterSchema>;

const draftItemSchema = z.object({
  category: z.enum(CLAIM_CATEGORIES),
  value: z.string().trim().min(2).max(300),
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
