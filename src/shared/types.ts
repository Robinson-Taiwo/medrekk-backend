// Shared MedRekk domain types. Runtime constant arrays double as the source of truth for Zod enums.

export const VERIFICATION_STATUSES = ["UNVERIFIED", "SELF_REPORTED", "EVIDENCE_BACKED", "CLINICALLY_VERIFIED"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const ACCESS_SCOPES = [
  "ALLERGIES",
  "CURRENT_MEDICATIONS",
  "RECENT_ENCOUNTERS",
  "PAST_MEDICAL_HISTORY",
  "LAB_RESULTS",
  "REFERRALS",
  "EMERGENCY_INFORMATION",
] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export const ACCESS_STATUSES = ["AWAITING_REQUEST", "PENDING", "APPROVED", "DENIED", "EXPIRED"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export const REQUESTER_ROLES = ["DOCTOR", "NURSE", "PHARMACIST", "LAB_SCIENTIST", "OTHER_CLINICIAN"] as const;
export type RequesterRole = (typeof REQUESTER_ROLES)[number];

export const SYNC_ENTITY_TYPES = [
  "patients", "encounters", "claims", "evidence", "verification_events", "medications", "allergies",
  "vitals", "referrals", "emergency_profiles",
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export const SYNC_OPERATIONS = ["CREATE", "UPDATE", "DELETE"] as const;
export type SyncOperationKind = (typeof SYNC_OPERATIONS)[number];

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Patient {
  id: string; // internal id, never exposed as the MedRekk Code
  medrekkCode: string; // e.g. MRK-82941
  fullName: string;
  createdAt: string;
}

export interface ClinicalClaim {
  id: string;
  patientId: string;
  category: AccessScope;
  value: string;
  status: VerificationStatus;
  source: string;
  verificationMethod?: string;
  verifiedAt?: string;
  lastConfirmedAt?: string;
  evidenceId?: string;
}

export interface EmergencyProfile {
  patientId: string;
  criticalAllergies: string[];
  criticalConditions: string[];
  criticalMedications: string[];
  implantedDevices: string[];
  bloodGroup?: string;
  importantWarnings: string[];
  emergencyContact?: { name: string; phone: string; relationship: string };
  verificationStatus: VerificationStatus;
  lastConfirmedAt?: string;
}

export interface AccessSession {
  id: string;
  tokenHash: string; // sha256 of the opaque URL token; the raw token is never stored
  patientId: string;
  status: AccessStatus;
  requester?: { name: string; role: RequesterRole; reason: string };
  requestedScopes: AccessScope[];
  approvedScopes: AccessScope[];
  durationMinutes?: number;
  grantedUntil?: string;
  createdAt: string;
  expiresAt: string; // lifetime of the un-granted session/request
  decidedAt?: string;
}

export type AuditType =
  | "ACCESS_SESSION_STARTED"
  | "ACCESS_REQUESTED"
  | "ACCESS_APPROVED"
  | "ACCESS_DENIED"
  | "RECORD_VIEWED"
  | "EMERGENCY_ACCESSED";

export interface AuditEvent {
  id: string;
  patientId: string;
  type: AuditType;
  accessType: "NORMAL" | "EMERGENCY";
  occurredAt: string;
  requesterIdentifier?: string;
  informationViewed?: string[];
  reason?: string;
  sessionId?: string;
}

export interface SyncOperation {
  operationId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperationKind;
  payload: { [key: string]: Json };
  createdAt: string;
}

export type SyncResultStatus = "SYNCED" | "DUPLICATE" | "FAILED";
