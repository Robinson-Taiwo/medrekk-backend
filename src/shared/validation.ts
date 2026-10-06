import { z } from "zod";
import {
  ACCESS_SCOPES, REQUESTER_ROLES, SYNC_ENTITY_TYPES, SYNC_OPERATIONS, type Json,
} from "./types.js";

export const medrekkCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^MRK-[A-Z0-9]{5,8}$/, "Invalid MedRekk Code"));

export const accessScopeSchema = z.enum(ACCESS_SCOPES);

export const accessLookupSchema = z.object({
  medrekkCode: medrekkCodeSchema,
  patientName: z.string().trim().min(2).max(120),
});
export type AccessLookupInput = z.infer<typeof accessLookupSchema>;

export const accessRequestSchema = z.object({
  requesterName: z.string().trim().min(2).max(120),
  requesterRole: z.enum(REQUESTER_ROLES),
  reason: z.string().trim().min(3).max(300),
  scopes: z.array(accessScopeSchema).min(1).max(ACCESS_SCOPES.length),
  durationMinutes: z.number().int().min(15).max(1440).default(120),
});
export type AccessRequestInput = z.infer<typeof accessRequestSchema>;

export const accessDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "DENY"]),
  approvedScopes: z.array(accessScopeSchema).min(1).optional(), // patient may narrow the request
});
export type AccessDecisionInput = z.infer<typeof accessDecisionSchema>;

export const emergencyQuerySchema = z.object({
  reason: z.string().trim().min(3).max(200).default("Emergency QR/ID scan"),
});

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(jsonSchema)]),
);

export const syncOperationSchema = z.object({
  operationId: z.string().min(8).max(100),
  entityType: z.enum(SYNC_ENTITY_TYPES),
  entityId: z.string().min(1).max(100),
  operation: z.enum(SYNC_OPERATIONS),
  payload: z.record(jsonSchema),
  createdAt: z.string().datetime(),
});

export const syncPushSchema = z.object({
  operations: z.array(syncOperationSchema).min(1).max(100),
});
export type SyncPushInput = z.infer<typeof syncPushSchema>;
