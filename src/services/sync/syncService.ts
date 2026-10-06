import type { SyncOperation, SyncResultStatus } from "../../shared/types.js";
import type { Repositories } from "../../database/repositories.js";
import type { CloudAdapter } from "../cloud/rumpty.js";

export class SyncService {
  constructor(private readonly deps: { repos: Repositories; cloud: CloudAdapter }) {}

  /** Idempotent by operationId: replays from flaky networks return DUPLICATE instead of re-applying. */
  async push(actorId: string, operations: SyncOperation[]) {
    const results: { operationId: string; status: SyncResultStatus }[] = [];
    for (const op of operations) {
      if (await this.deps.repos.sync.has(op.operationId)) {
        results.push({ operationId: op.operationId, status: "DUPLICATE" });
        continue;
      }
      try {
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
