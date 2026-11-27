import { command, computed, state, type Command } from "ccstate";

import {
  observeClientOperation,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
} from "../../lib/client-telemetry.ts";
import { apiClient$ } from "../api-client.ts";
import { clerk$, clerkUser$ } from "../auth.ts";
import { waitForClerkSession } from "../clerk-token.ts";
import type {
  IndexedDbDiagnostics,
  IndexedDbSnapshotMeasurement,
} from "../external/idb-diagnostics-store.ts";
import { NEVER_RESOLVED_PROMISE, resetSignal } from "../utils.ts";
import { ChatDatabaseRuntime } from "./runtime.ts";
import type {
  ChatDatabaseDataKey,
  ChatDatabaseQuery,
  ChatDatabaseQueryResult,
  ChatEventDataKey,
  ChatThreadEventDataKey,
  ProjectEventDataKey,
} from "./types.ts";

const chatDatabaseRuntimeState$ = state<ChatDatabaseRuntime | null>(null);
const internalChatDatabaseReady$ = state<Promise<void>>(NEVER_RESOLVED_PROMISE);
const projectRealtimeReadyState$ = state<Promise<void> | null>(null);
const internalReloadIndexedDbDiagnostics$ = state(0);
const resetChatDatabaseOwner$ = resetSignal();

export const chatDatabaseReady$ = computed((get): Promise<void> => {
  return get(internalChatDatabaseReady$);
});

const installedChatDatabaseRuntime$ = computed((get): ChatDatabaseRuntime => {
  const runtime = get(chatDatabaseRuntimeState$);
  if (!runtime) {
    throw new Error("Chat database runtime is not initialized");
  }
  return runtime;
});

export const setProjectRealtimeReady$ = command(
  ({ set }, ready: Promise<void>): void => {
    set(projectRealtimeReadyState$, ready);
  },
);

const initializeChatDatabase$ = command(
  async ({ get, set }, parentSignal: AbortSignal): Promise<void> => {
    if (get(chatDatabaseRuntimeState$) !== null) {
      return;
    }
    const clerk = await get(clerk$);
    await Promise.all([
      waitForClerkSession(clerk, parentSignal),
      get(clerkUser$),
    ]);
    parentSignal.throwIfAborted();
    // Read the member and session together after Clerk finishes activation.
    const { user, organization, session } = clerk;
    if (!session || !user || !organization) {
      return;
    }
    const identity = { userId: user.id, orgId: organization.id };
    const signal = set(resetChatDatabaseOwner$, parentSignal);
    const unsubscribe = clerk.addListener(
      () => {
        // Clerk can temporarily clear resources during a same-member refresh.
        if (
          clerk.session === null ||
          clerk.user === null ||
          (clerk.user && clerk.user.id !== identity.userId) ||
          (clerk.organization && clerk.organization.id !== identity.orgId)
        ) {
          set(resetChatDatabaseOwner$);
        }
      },
      { skipInitialEmit: true },
    );
    const runtime = new ChatDatabaseRuntime(
      {
        identity,
        onVersionChange: () => {
          recordClientTelemetry(
            startClientTelemetryMeasurement(),
            { event_name: "indexeddb.version_changed", database: "chat" },
            "error",
          );
        },
        createContractClient: get(apiClient$),
      },
      signal,
    );
    signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
        if (get(chatDatabaseRuntimeState$) === runtime) {
          set(chatDatabaseRuntimeState$, null);
        }
      },
      { once: true },
    );
    set(chatDatabaseRuntimeState$, runtime);
  },
);

export const setupChatDatabase$ = command(
  ({ set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const ready = set(initializeChatDatabase$, signal);
    set(internalChatDatabaseReady$, ready);
    return ready;
  },
);

export const reloadIndexedDbDiagnostics$ = command(({ set }): void => {
  set(internalReloadIndexedDbDiagnostics$, (value) => {
    return value + 1;
  });
});

export const indexedDbDiagnostics$ = computed(
  async (get): Promise<IndexedDbDiagnostics> => {
    get(internalReloadIndexedDbDiagnostics$);
    return await get(installedChatDatabaseRuntime$).getIndexedDbDiagnostics();
  },
);

export const measureIndexedDbSnapshot$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<IndexedDbSnapshotMeasurement | null> => {
    return await get(installedChatDatabaseRuntime$).measureIndexedDbSnapshot(
      signal,
    );
  },
);

export const catchUpChatEventsInDatabase$ = command(
  async (
    { get },
    threadIds: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    return await get(installedChatDatabaseRuntime$).catchUpChatEvents(
      threadIds,
      signal,
    );
  },
);

type QueryChatEventDatabaseCommand = Command<
  Promise<ChatDatabaseQueryResult<ChatEventDataKey>>,
  [ChatDatabaseQuery<ChatEventDataKey>, AbortSignal]
>;

type QueryChatThreadEventDatabaseCommand = Command<
  Promise<ChatDatabaseQueryResult<ChatThreadEventDataKey>>,
  [ChatDatabaseQuery<ChatThreadEventDataKey>, AbortSignal]
>;

type QueryProjectEventDatabaseCommand = Command<
  Promise<ChatDatabaseQueryResult<ProjectEventDataKey>>,
  [ChatDatabaseQuery<ProjectEventDataKey>, AbortSignal]
>;

const queryChatDatabaseCommand$ = command(
  async (
    { get },
    query: ChatDatabaseQuery<ChatDatabaseDataKey>,
    signal: AbortSignal,
  ): Promise<ChatDatabaseQueryResult<ChatDatabaseDataKey>> => {
    signal.throwIfAborted();
    return await observeClientOperation(
      {
        event_name: "chat_database.query",
        // Dataset kind and consistency are the complete low-cardinality query
        // shape; cursor and entity identifiers are intentionally omitted.
        template: `${query.dataKey.kind}.${query.consistency}`,
      },
      async () => {
        if (
          query.dataKey.kind === "project-event" &&
          query.consistency === "catch-up"
        ) {
          const projectRealtimeReady = get(projectRealtimeReadyState$);
          if (!projectRealtimeReady) {
            throw new Error("Chat database realtime is not initialized");
          }
          // The only baseline must follow the subscription that carries its
          // invalidations, including when realtime connects after the page.
          await projectRealtimeReady;
          signal.throwIfAborted();
        }
        return await get(installedChatDatabaseRuntime$).query(query, signal);
      },
    );
  },
);

export const queryChatEventDatabase$ =
  queryChatDatabaseCommand$ as QueryChatEventDatabaseCommand;
export const queryChatThreadEventDatabase$ =
  queryChatDatabaseCommand$ as QueryChatThreadEventDatabaseCommand;
export const queryProjectEventDatabase$ =
  queryChatDatabaseCommand$ as QueryProjectEventDatabaseCommand;
