import { z } from "zod";

export const createReferralSchema = z.object({
  destinationFacility: z.string().trim().min(2).max(120).optional(),
  reason: z.string().trim().min(3).max(300),
  note: z.string().trim().max(500).optional(),
  claimIds: z.array(z.string().min(1).max(100)).min(1).max(30),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export type CreateReferralInput = z.infer<typeof createReferralSchema>;
