import { observeClientOperation } from "../lib/client-telemetry.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
} from "./bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type {
  SharedDatabaseRealtimeMessage,
  SharedDatabaseRealtimeScope,
} from "./protocol.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";

interface SingleConnectionSharedDatabaseBridgeOptions {
  readonly createBridge: (
    events: SharedDatabaseBridgeEvents,
    signal: AbortSignal,
  ) => SharedDatabaseBridge;
  readonly events: SharedDatabaseBridgeEvents;
}

export class SingleConnectionSharedDatabaseBridge implements SharedDatabaseBridge {
  private bridge: SharedDatabaseBridge | null = null;
  private ownerSignal: AbortSignal | null = null;

  constructor(
    private readonly options: SingleConnectionSharedDatabaseBridgeOptions,
  ) {}

  prepare(signal: AbortSignal): Promise<void> {
    this.bindOwner(signal);
    if (!this.bridge) {
      this.bridge = this.options.createBridge(this.options.events, signal);
    }
    return Promise.resolve();
  }

  async registerTab(signal: AbortSignal): Promise<void> {
    await this.prepare(signal);
    const bridge = this.requireRegistered(this.bridge);
    await bridge.registerTab(this.requireRegistered(this.ownerSignal));
    signal.throwIfAborted();
  }

  subscribeRealtime(
    subscriptionId: string,
    scope: SharedDatabaseRealtimeScope,
    topic: string,
    listener: (message: SharedDatabaseRealtimeMessage) => void,
    onResync: () => void,
  ): Promise<void> {
    return this.requireRegistered(this.bridge).subscribeRealtime(
      subscriptionId,
      scope,
      topic,
      listener,
      onResync,
    );
  }

  unsubscribeRealtime(subscriptionId: string): void {
    this.requireRegistered(this.bridge).unsubscribeRealtime(subscriptionId);
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const bridge = this.requireRegistered(this.bridge);
    return await observeClientOperation(
      {
        event_name: "shared_database.query",
        // Dataset kind and consistency are the complete low-cardinality query
        // shape; cursor and entity identifiers are intentionally omitted.
        template: `${query.dataKey.kind}.${query.consistency}`,
      },
      async () => {
        return await bridge.query(query, signal);
      },
    );
  }

  async getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    const bridge = this.requireRegistered(this.bridge);
    return await bridge.getComputed(computedKey);
  }

  private bindOwner(signal: AbortSignal): void {
    if (this.ownerSignal === signal) {
      return;
    }
    if (this.ownerSignal !== null) {
      throw new Error("Shared database bridge already has a lifecycle owner");
    }
    signal.throwIfAborted();
    this.ownerSignal = signal;
  }

  private requireRegistered<T>(value: T | null): T {
    if (!value) {
      throw new Error("Shared database tab registration is required first");
    }
    return value;
  }
}
