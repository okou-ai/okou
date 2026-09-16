import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import type { ComputedKey, ComputedValue } from "./computed-key.ts";
import type {
  SharedDatabaseRealtimeMessage,
  SharedDatabaseRealtimeScope,
  SharedDatabaseWorkerUnavailableReason,
} from "./protocol.ts";

export interface SharedDatabaseBridge {
  registerTab(signal: AbortSignal): Promise<void>;
  subscribeRealtime(
    subscriptionId: string,
    scope: SharedDatabaseRealtimeScope,
    topic: string,
    listener: (message: SharedDatabaseRealtimeMessage) => void,
    onResync: () => void,
  ): Promise<void>;
  unsubscribeRealtime(subscriptionId: string): void;
  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>>;
  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>>;
}

export type SharedDatabaseTokenProvider = (
  signal?: AbortSignal,
) => Promise<string | null>;

export interface SharedDatabaseBridgeEvents {
  readonly databaseInvalidated: (
    dataKey: SharedDatabaseDataKey,
  ) => void | Promise<void>;
  readonly workerUnavailable: (
    reason: SharedDatabaseWorkerUnavailableReason,
  ) => void;
  readonly computedReloaded: (computedKey: ComputedKey) => void;
  readonly chatThreadReadCursorUpdated: (payload: unknown) => void;
}

export interface SharedDatabasePortLike {
  postMessage(value: unknown): void;
  start(): void;
  close(): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}
