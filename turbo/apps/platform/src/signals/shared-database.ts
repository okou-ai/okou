import { command, computed, state, type Command } from "ccstate";
import type { QueueResponse } from "@okouai/api-contracts/contracts/runs";
import type {
  ChatThreadIndicators,
  ChatEventDataKey,
  ChatThreadEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../shared-database/data-key.ts";
import type {
  ComputedKey,
  IndexedDbDiagnostics,
  IndexedDbSnapshotMeasurement,
} from "../shared-database/computed-key.ts";
import {
  reloadChatIndicatorsCounter$,
  reloadChatIndicatorsLocally$,
} from "./chat-thread-list-reload.ts";
import { installedSharedDatabaseBridge$ } from "./shared-database-bridge-state.ts";

const internalReloadQueueDataFromWorker$ = state(0);

const reloadQueueDataFromWorker$ = command(({ set }): void => {
  set(internalReloadQueueDataFromWorker$, (value) => {
    return value + 1;
  });
});

const internalReloadIndexedDbDiagnosticsFromWorker$ = state(0);

export const reloadIndexedDbDiagnosticsFromWorker$ = command(
  ({ set }): void => {
    set(internalReloadIndexedDbDiagnosticsFromWorker$, (value) => {
      return value + 1;
    });
  },
);

export const measureIndexedDbSnapshotFromWorker$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<IndexedDbSnapshotMeasurement | null> => {
    return await get(installedSharedDatabaseBridge$).getComputed(
      "indexeddb-snapshot-measurement",
      undefined,
      signal,
    );
  },
);

export const reloadComputedFromWorker$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    switch (computedKey) {
      case "chat-thread-indicators": {
        set(reloadChatIndicatorsLocally$);
        return;
      }
      case "computer-use-hosts": {
        // The composer reads its host briefs from the user overview.
        return;
      }
      case "indexeddb-diagnostics": {
        set(reloadIndexedDbDiagnosticsFromWorker$);
        return;
      }
      case "indexeddb-snapshot-measurement": {
        return;
      }
      case "queue-data": {
        set(reloadQueueDataFromWorker$);
        return;
      }
    }
  },
);

export const chatThreadIndicatorsFromWorker$ = computed(
  async (get): Promise<ChatThreadIndicators> => {
    get(reloadChatIndicatorsCounter$);
    return await get(installedSharedDatabaseBridge$).getComputed(
      "chat-thread-indicators",
    );
  },
);

export const queueDataFromWorker$ = computed(
  async (get): Promise<QueueResponse> => {
    get(internalReloadQueueDataFromWorker$);
    return await get(installedSharedDatabaseBridge$).getComputed("queue-data");
  },
);

export const indexedDbDiagnosticsFromWorker$ = computed(
  async (get): Promise<IndexedDbDiagnostics> => {
    get(internalReloadIndexedDbDiagnosticsFromWorker$);
    return await get(installedSharedDatabaseBridge$).getComputed(
      "indexeddb-diagnostics",
    );
  },
);

type QueryChatEventSharedDatabaseCommand = Command<
  Promise<SharedDatabaseQueryResult<ChatEventDataKey>>,
  [SharedDatabaseQuery<ChatEventDataKey>, AbortSignal]
>;

type QueryChatThreadEventSharedDatabaseCommand = Command<
  Promise<SharedDatabaseQueryResult<ChatThreadEventDataKey>>,
  [SharedDatabaseQuery<ChatThreadEventDataKey>, AbortSignal]
>;

const querySharedDatabaseCommand$ = command(
  async (
    { get },
    query: SharedDatabaseQuery<SharedDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<SharedDatabaseDataKey>> => {
    const bridge = get(installedSharedDatabaseBridge$);
    return await bridge.query(query, signal);
  },
);

// These are typed views of the same Query command, not separate operations.
// The bridge validates the selected dataset schema before the command returns.
export const queryChatEventSharedDatabase$ =
  querySharedDatabaseCommand$ as QueryChatEventSharedDatabaseCommand;
export const queryChatThreadEventSharedDatabase$ =
  querySharedDatabaseCommand$ as QueryChatThreadEventSharedDatabaseCommand;
