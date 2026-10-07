import { z } from "zod";
import { CREDENTIAL_STATUSES } from "./types.js";

export const credentialUpdateSchema = z.object({ status: z.enum(CREDENTIAL_STATUSES) });
export const workerListQuerySchema = z.object({ status: z.enum(CREDENTIAL_STATUSES).optional() });
export const userIdParams = z.object({ userId: z.string().min(1).max(100) });
