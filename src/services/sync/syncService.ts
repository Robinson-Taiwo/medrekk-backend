import type { SyncOperation, SyncResultStatus } from "../../shared/types.js";
import type { Repositories } from "../../database/repositories.js";
import type { CloudAdapter } from "../cloud/rumpty.js";
import type { OperationApplier } from "./operationApplier.js";

export class SyncService {
  constructor(
    private readonly deps: { repos: Repositories; cloud: CloudAdapter; apply: OperationApplier },
  ) {}

  /** Idempotent by operationId: replays from flaky networks return DUPLICATE instead of re-applying. */
  async push(actorId: string, operations: SyncOperation[]) {
    const results: { operationId: string; status: SyncResultStatus }[] = [];
    for (const op of operations) {
      if (await this.deps.repos.sync.has(op.operationId)) {
        results.push({ operationId: op.operationId, status: "DUPLICATE" });
        continue;
      }
      try {
        // Apply it to the record first. Only once that has worked is the operation recorded
        // and the client told SYNCED, so a device never empties its queue on a promise.
        await this.deps.apply.apply(op, actorId);
        await this.deps.cloud.pushOperation(op);
        await this.deps.repos.sync.save(op, actorId);
        results.push({ operationId: op.operationId, status: "SYNCED" });
      } catch {
        results.push({ operationId: op.operationId, status: "FAILED" }); // client keeps it queued and retries
      }
    }
    return { results };
  }
}
