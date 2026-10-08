export const CLAIM_CATEGORIES = [
  "ALLERGIES",
  "CURRENT_MEDICATIONS",
  "RECENT_ENCOUNTERS",
  "PAST_MEDICAL_HISTORY",
  "LAB_RESULTS",
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export const ENCOUNTER_STATUSES = ["CAPTURED", "STRUCTURED", "REVIEWED"] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export const CAPTURE_METHODS = ["TEXT", "VOICE"] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export interface DraftItem {
  category: ClaimCategory;
  value: string;
}

export interface Encounter {
  id: string;
  patientId: string;
  sessionId: string;
  workerUserId: string;
  workerName: string;
  workerFacility: string | null;
  captureMethod: CaptureMethod;
  /** The original capture. Never overwritten by AI output or review. */
  rawInput: string;
  draftSource: "AI" | "WORKER" | null;
  draft: DraftItem[];
  status: EncounterStatus;
  createdAt: string;
  structuredAt?: string;
  reviewedAt?: string;
  createdClaimIds: string[];
}
