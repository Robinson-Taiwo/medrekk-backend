import type { ReferralRepository } from "../../database/referralRepository.js";
import type { Repositories } from "../../database/repositories.js";
import type { Referral, ReferralItem, ReferralStatus } from "../../shared/referralTypes.js";
import type { CreateReferralInput } from "../../shared/referralValidation.js";
import type { AuditType } from "../../shared/types.js";
import { AppError } from "../../utils/errors.js";
import { newAccessToken, newId } from "../../utils/ids.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReferralDeps {
  repos: Repositories;
  referrals: ReferralRepository;
  now: () => Date;
}

interface AuditExtra {
  requesterIdentifier?: string;
  informationViewed?: string[];
  reason?: string;
}

export class ReferralService {
  constructor(private readonly deps: ReferralDeps) {}

  private iso(offsetMs = 0): string {
    return new Date(this.deps.now().getTime() + offsetMs).toISOString();
  }

  private statusOf(r: Referral): ReferralStatus {
    if (r.status === "REVOKED") return "REVOKED";
    return Date.parse(r.expiresAt) <= this.deps.now().getTime() ? "EXPIRED" : "ACTIVE";
  }

  private async audit(patientId: string, type: AuditType, extra: AuditExtra): Promise<void> {
    await this.deps.repos.audit.append({
      id: newId("aud"),
      patientId,
      type,
      accessType: "NORMAL",
      occurredAt: this.iso(),
      ...extra,
    });
  }

  private summary(r: Referral) {
    return {
      id: r.id,
      shareId: r.shareId,
      status: this.statusOf(r),
      destinationFacility: r.destinationFacility,
      reason: r.reason,
      note: r.note,
      items: r.items,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    };
  }

  async create(patientId: string, userId: string, input: CreateReferralInput) {
    const { repos, referrals } = this.deps;
    const patient = await repos.patients.findById(patientId);
    if (!patient) throw new AppError(404, "PATIENT_NOT_FOUND", "Patient not found.");

    const all = await repos.records.allFor(patientId);
    const items: ReferralItem[] = [];
    for (const claimId of new Set(input.claimIds)) {
      const claim = all.find((c) => c.id === claimId);
      if (!claim) throw new AppError(400, "CLAIM_NOT_FOUND", "One or more selected items were not found.");
      items.push({ claimId: claim.id, scope: claim.category, value: claim.value, status: claim.status });
    }

    const referral: Referral = {
      id: newId("ref"),
      shareId: newAccessToken(),
      patientId,
      createdByUserId: userId,
      createdByName: patient.fullName,
      createdByRole: "PATIENT",
      originatingFacility: null,
      destinationFacility: input.destinationFacility ?? null,
      reason: input.reason,
      note: input.note && input.note.length > 0 ? input.note : null,
      items,
      status: "ACTIVE",
      createdAt: this.iso(),
      expiresAt: this.iso(input.expiresInDays * DAY_MS),
    };
    await referrals.create(referral);
    await this.audit(patientId, "REFERRAL_CREATED", {
      requesterIdentifier: patient.fullName,
      informationViewed: items.map((i) => i.scope),
      reason: input.reason,
    });
    return this.summary(referral);
  }

  async listForPatient(patientId: string) {
    const rows = await this.deps.referrals.listForPatient(patientId);
    return rows.map((r) => this.summary(r));
  }

  async revoke(patientId: string, referralId: string) {
    const found = await this.deps.referrals.findById(referralId);
    if (!found || found.patientId !== patientId) {
      throw new AppError(404, "REFERRAL_NOT_FOUND", "Referral not found.");
    }
    if (found.status === "REVOKED") return this.summary(found);
    const revoked: Referral = { ...found, status: "REVOKED", revokedAt: this.iso() };
    await this.deps.referrals.update(revoked);
    await this.audit(patientId, "REFERRAL_REVOKED", {
      requesterIdentifier: found.createdByName,
      reason: found.reason,
    });
    return this.summary(revoked);
  }

  /** Public (no account): what a receiving provider sees when opening the link. Audited on every load. */
  async view(shareId: string, ctx: { requesterIdentifier: string }) {
    const referral = await this.deps.referrals.findByShareId(shareId);
    if (!referral) throw new AppError(404, "REFERRAL_NOT_FOUND", "Referral not found.");
    const status = this.statusOf(referral);
    if (status === "REVOKED") {
      throw new AppError(410, "REFERRAL_REVOKED", "This referral was cancelled by the patient.");
    }
    if (status === "EXPIRED") {
      throw new AppError(410, "REFERRAL_EXPIRED", "This referral has expired.");
    }
    const patient = await this.deps.repos.patients.findById(referral.patientId);
    if (!patient) throw new AppError(404, "REFERRAL_NOT_FOUND", "Referral not found.");
    await this.audit(referral.patientId, "REFERRAL_VIEWED", {
      requesterIdentifier: ctx.requesterIdentifier,
      informationViewed: referral.items.map((i) => i.scope),
      reason: referral.reason,
    });
    return {
      patient: { name: patient.fullName, medrekkCode: patient.medrekkCode },
      issuedBy: { name: referral.createdByName, role: referral.createdByRole },
      originatingFacility: referral.originatingFacility,
      destinationFacility: referral.destinationFacility,
      reason: referral.reason,
      note: referral.note,
      items: referral.items,
      createdAt: referral.createdAt,
      expiresAt: referral.expiresAt,
    };
  }
}
