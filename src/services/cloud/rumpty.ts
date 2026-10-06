import type { SyncOperation } from "../../shared/types.js";

/** Everything Rumpty-specific lives behind this interface. Routes/services never import a Rumpty SDK. */
export interface CloudAdapter {
  pushOperation(op: SyncOperation): Promise<void>;
}

/** Placeholder until the real Rumpty Cloud APIs are known. */
export class NoopCloudAdapter implements CloudAdapter {
  async pushOperation(): Promise<void> {
    return;
  }
}
