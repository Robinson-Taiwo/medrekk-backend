export const CLAIM_CATEGORIES = [
  "ALLERGIES",
  "CURRENT_MEDICATIONS",
  "RECENT_ENCOUNTERS",
  "PAST_MEDICAL_HISTORY",
  "LAB_RESULTS",
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export const ENCOUNTER_STATUSES = ["CAPTURED", "STRUCTURED", "REVIEWED", "DISCARDED"] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export const CAPTURE_METHODS = ["TEXT", "VOICE", "PHOTO"] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export interface DraftItem {
  category: ClaimCategory;
  value: string;
  /** The exact words in rawInput this was derived from. Kept so a claim can always be traced back. */
  excerpt?: string;
}

export interface Encounter {
  id: string;
  patientId: string;
  /** Absent on a patient's own entry: there is no access session to approve. */
  sessionId?: string;
  /**
   * Undefined means WORKER, which is every row written before patients could record.
   * On a PATIENT entry the three worker* fields below carry the patient's own identity,
   * so one encounter shape serves both and the patient's visit view needs no new reader.
   */
  authoredBy?: "PATIENT" | "WORKER";
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
  /** On a patient entry, what the document says it came from. See Evidence.origin. */
  origin?: { facility?: string; clinician?: string; documentDate?: string };
  /** SHA-256 of the captured image, hex. The image is not stored. */
  imageHash?: string;
}
