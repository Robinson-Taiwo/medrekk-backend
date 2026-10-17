import { z } from "zod";

import type { SyncOperation } from "../../shared/types.js";
import { CAPTURE_METHODS, CLAIM_CATEGORIES } from "../../shared/encounterTypes.js";
import type { EncounterService } from "../encounter/encounterService.js";
import { AppError } from "../../utils/errors.js";

/**
 * Applies an operation a handset recorded while it had no connection.
 *
 * Before this existed, /sync/push accepted operations, answered SYNCED and threw them away:
 * the queue on the device emptied and nothing reached the record. A worker could capture a
 * whole clinic's visits offline and lose every one of them without a single error.
 *
 * Everything goes through the same EncounterService the online routes use, so a visit that
 * syncs an hour late is written exactly like one saved in the room: same validation, same
 * audit trail, same UNVERIFIED starting point.
 */

const itemSchema = z.object({
  category: z.enum(CLAIM_CATEGORIES),
  value: z.string().trim().min(2).max(300),
  excerpt: z.string().trim().max(500).optional(),
});

const encounterPayload = z.object({
  /** The access grant the patient approved. Authority comes from this, not from the queue. */
  accessToken: z.string().min(20).max(100),
  rawInput: z.string().trim().min(3).max(5000),
  captureMethod: z.enum(CAPTURE_METHODS).default("TEXT"),
  items: z.array(itemSchema).max(40).default([]),
});

export class OperationApplier {
  constructor(private readonly deps: { encounters: EncounterService }) {}

  async apply(op: SyncOperation, actorId: string): Promise<void> {
    if (op.entityType === "encounters") return this.encounter(op, actorId);

    // Refusing loudly is the point: a client told SYNCED believes the record holds this.
    throw new AppError(400, "SYNC_UNSUPPORTED", `Cannot apply ${op.entityType} operations yet.`);
  }

  private async encounter(op: SyncOperation, actorId: string): Promise<void> {
    if (op.operation !== "CREATE") {
      throw new AppError(400, "SYNC_UNSUPPORTED", "Encounters sync as a single CREATE.");
    }
    const payload = encounterPayload.parse(op.payload);

    // Capture is idempotent on the handset's id, so a replay returns the existing encounter.
    await this.deps.encounters.capture(payload.accessToken, actorId, {
      id: op.entityId,
      rawInput: payload.rawInput,
      captureMethod: payload.captureMethod,
    });

    if (payload.items.length === 0) return;

    try {
      await this.deps.encounters.review(payload.accessToken, actorId, op.entityId, {
        items: payload.items,
      });
    } catch (e) {
      // Already reviewed means a previous attempt got further than the client was told.
      // That is this operation's work already done, not a failure to retry forever.
      if (e instanceof AppError && e.code === "ENCOUNTER_REVIEWED") return;
      throw e;
    }
  }
}
