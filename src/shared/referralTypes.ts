import type { AccessScope, VerificationStatus } from "./types.js";

export const REFERRAL_STATUSES = ["ACTIVE", "REVOKED", "EXPIRED"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export interface ReferralItem {
  claimId: string;
  scope: AccessScope;
  value: string;
  status: VerificationStatus;
}

export interface Referral {
  id: string;
  shareId: string;
  patientId: string;
  createdByUserId: string;
  createdByName: string;
  createdByRole: "PATIENT" | "HEALTH_WORKER";
  originatingFacility: string | null;
  destinationFacility: string | null;
  reason: string;
  note: string | null;
  items: ReferralItem[];
  status: "ACTIVE" | "REVOKED";
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}
