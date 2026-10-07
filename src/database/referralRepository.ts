import type { Referral } from "../shared/referralTypes.js";

export interface ReferralRepository {
  create(referral: Referral): Promise<void>;
  findByShareId(shareId: string): Promise<Referral | undefined>;
  findById(id: string): Promise<Referral | undefined>;
  update(referral: Referral): Promise<void>;
  listForPatient(patientId: string): Promise<Referral[]>;
}

export function createMemoryReferralRepository(): ReferralRepository {
  const rows = new Map<string, Referral>();
  return {
    create: async (r) => void rows.set(r.id, r),
    findByShareId: async (shareId) => [...rows.values()].find((r) => r.shareId === shareId),
    findById: async (id) => rows.get(id),
    update: async (r) => void rows.set(r.id, r),
    listForPatient: async (patientId) =>
      [...rows.values()]
        .filter((r) => r.patientId === patientId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
