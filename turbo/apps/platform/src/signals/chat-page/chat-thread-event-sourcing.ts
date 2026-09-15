import { command, computed, state, type Computed } from "ccstate";
import {
  chatThreadMetadataContract,
  type ChatThreadEvent,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import {
  captureChatThreadMetadataShortcut$,
  type ChatThreadMetadataShortcutOutcome,
} from "../../lib/posthog.ts";
import { activeRoute$ } from "../active-route.ts";
import { apiClient$ } from "../api-client.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { rootSignal$ } from "../root-signal.ts";
import { pathParams$ } from "../route.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  settle,
  withCleanup,
} from "../utils.ts";
import { i18n } from "../../i18n/index.ts";
import type {
  ChatThreadEventDataKey,
  ChatThreadEventQueryResult,
} from "../../shared-database/data-key.ts";
import { queryChatThreadEventSharedDatabase$ } from "../shared-database.ts";
import type {
  ChatThreadEventView,
  OptimisticChatThreadEvent,
  OptimisticChatThreadEventInput,
} from "./chat-thread-event-types.ts";

interface ChatThreadEventData {
  readonly snapshot: readonly ChatThreadSnapshotProjection[];
  readonly events: readonly ChatThreadEvent[];
}

interface ChatThreadSnapshotData {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

interface ChatThreadEventState {
  readonly snapshot: ChatThreadSnapshotData | null;
  readonly events: readonly ChatThreadEvent[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

export interface ThreadMeta {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly pinnedAt: string | null;
  readonly selectedModel: string | null;
  readonly modelSettings: ModelSettings;
  readonly serviceTier: "priority" | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
}

interface BootstrapThreadMetaEntry {
  readonly meta: ThreadMeta;
  readonly owner: object;
}

type ColdThreadMetaResolution =
  | { readonly source: "event-stream"; readonly meta: ThreadMeta | null }
  | { readonly source: "metadata"; readonly meta: ThreadMeta };

type RemoteThreadMetaAttempt =
  | Extract<ColdThreadMetaResolution, { readonly source: "metadata" }>
  | { readonly source: "metadata-unavailable" };

interface ResolvedThreadMeta {
  readonly localDurationMs?: number;
  readonly meta: ThreadMeta | null;
  readonly remoteDurationMs?: number;
  readonly source: "local" | "memory" | "not_found" | "remote";
}

interface RemoteThreadMetaResponse {
  readonly meta: ThreadMeta | null;
  readonly outcome: Exclude<
    ChatThreadMetadataShortcutOutcome,
    "transport-failure"
  >;
}

const optimisticChatThreadEventsState$ = state<
  readonly OptimisticChatThreadEvent[]
>([]);
const chatThreadEventState$ = state<ChatThreadEventState>({
  snapshot: null,
  events: [],
  latestEventId: null,
  latestSeqId: null,
});
const bootstrapThreadMetaState$ = state<
  ReadonlyMap<string, BootstrapThreadMetaEntry>
>(new Map());
const chatThreadEventSyncVersion$ = state(0);

const clearBootstrapThreadMeta$ = command(({ get, set }) => {
  set(bootstrapThreadMetaState$, new Map());
  set(chatThreadEventSyncVersion$, get(chatThreadEventSyncVersion$) + 1);
});

const registerBootstrapThreadMeta$ = command(
  (
    { get, set },
    meta: ThreadMeta,
    syncVersion: number,
    signal: AbortSignal,
  ): boolean => {
    signal.throwIfAborted();
    if (get(chatThreadEventSyncVersion$) !== syncVersion) {
      return false;
    }
    const owner = {};
    signal.addEventListener(
      "abort",
      () => {
        const current = get(bootstrapThreadMetaState$);
        if (current.get(meta.id)?.owner !== owner) {
          return;
        }
        const remaining = new Map(current);
        remaining.delete(meta.id);
        set(bootstrapThreadMetaState$, remaining);
      },
      { once: true },
    );
    const next = new Map(get(bootstrapThreadMetaState$));
    next.set(meta.id, { meta, owner });
    set(bootstrapThreadMetaState$, next);
    return true;
  },
);

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
const initialLocalChatThreadEventsLoadedDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
const initialRemoteChatThreadEventsSyncedDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const initialLocalChatThreadEventsLoaded$ = computed((get) => {
  return get(initialLocalChatThreadEventsLoadedDeferred$).promise;
});

const optimisticChatThreadCreateIds$ = computed((get): ReadonlySet<string> => {
  return new Set(
    get(optimisticChatThreadEventsState$).flatMap((event) => {
      return event.kind === "created" ? [event.chatThreadId] : [];
    }),
  );
});

function filterUnsettledOptimisticChatThreadEvents(
  optimistic: readonly OptimisticChatThreadEvent[],
  persisted: ChatThreadEventData,
): OptimisticChatThreadEvent[] {
  if (optimistic.length === 0) {
    return [];
  }
  const persistedEventIds = new Set(
    persisted.events.map((event) => {
      return event.id;
    }),
  );
  return optimistic.filter((event) => {
    return !persistedEventIds.has(event.id);
  });
}

const sharedChatThreadEventDataKey$ = computed((): ChatThreadEventDataKey => {
  return { kind: "chat-thread-event" };
});

const applySharedChatThreadEventResult$ = command(
  (
    { get, set },
    result: ChatThreadEventQueryResult,
    phase: "local" | "remote",
    signal: AbortSignal,
  ): void => {
    const lastEvent = result.events.at(-1);
    const state: ChatThreadEventState = {
      snapshot:
        result.snapshot === null
          ? null
          : {
              chatThreads: result.snapshot.chatThreads,
              latestEventId: result.snapshot.latestEventId,
              latestSeqId: result.snapshot.latestSeqId,
            },
      events: result.events,
      latestEventId: lastEvent?.id ?? result.snapshot?.latestEventId ?? null,
      latestSeqId: lastEvent?.seqId ?? result.snapshot?.latestSeqId ?? null,
    };
    set(chatThreadEventState$, state);
    set(reconcileOptimisticChatThreadEvents$, {
      snapshot: state.snapshot?.chatThreads ?? [],
      events: state.events,
    });
    set(syncCurrentChatThreadDocumentTitle$, signal);
    if (phase === "local") {
      const loaded = get(initialLocalChatThreadEventsLoadedDeferred$);
      if (!loaded.settled()) {
        loaded.resolve();
      }
      return;
    }
    set(clearBootstrapThreadMeta$);
    const synced = get(initialRemoteChatThreadEventsSyncedDeferred$);
    if (!synced.settled()) {
      synced.resolve();
    }
  },
);

// Each caller runs its own catch-up: a mutation can commit after an older sync
// has already read its result, so sharing one in-flight refresh would serve a
// stale answer. Failure remains a rejection, never authoritative not-found.
const syncSharedEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const dataKey = await get(sharedChatThreadEventDataKey$);
    signal.throwIfAborted();
    const currentSeqId = get(chatThreadEventState$).latestSeqId;
    const cached = await set(
      queryChatThreadEventSharedDatabase$,
      {
        dataKey,
        afterSeqId: currentSeqId,
        consistency: "cache-only",
      },
      signal,
    );
    signal.throwIfAborted();
    const cachedLastSeqId =
      cached.events.at(-1)?.seqId ?? cached.snapshot?.latestSeqId ?? null;
    const result =
      cachedLastSeqId !== null &&
      (currentSeqId === null || cachedLastSeqId > currentSeqId)
        ? cached
        : await set(
            queryChatThreadEventSharedDatabase$,
            {
              dataKey,
              afterSeqId: currentSeqId,
              consistency: "catch-up",
            },
            signal,
          );
    signal.throwIfAborted();
    set(applySharedChatThreadEventResult$, result, "remote", signal);
  },
);

const subscribeSharedEventDrivenChatThreads$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const dataKey = await get(sharedChatThreadEventDataKey$);
    signal.throwIfAborted();
    const cached = await set(
      queryChatThreadEventSharedDatabase$,
      { dataKey, afterSeqId: null, consistency: "cache-only" },
      signal,
    );
    signal.throwIfAborted();
    set(applySharedChatThreadEventResult$, cached, "local", signal);
    await set(syncSharedEventDrivenChatThreads$, signal);
  },
);

export const syncEventDrivenChatThreads$ = syncSharedEventDrivenChatThreads$;

export const subscribeEventDrivenChatThreads$ =
  subscribeSharedEventDrivenChatThreads$;

const chatThreadsSnapshot$ = computed((get) => {
  return get(chatThreadEventState$).snapshot?.chatThreads ?? [];
});

const allChatThreadsEvents$ = computed((get) => {
  const state = get(chatThreadEventState$);
  const persistedData: ChatThreadEventData = {
    snapshot: state.snapshot?.chatThreads ?? [],
    events: state.events,
  };
  const persisted = persistedData.events;
  const optimistic = filterUnsettledOptimisticChatThreadEvents(
    get(optimisticChatThreadEventsState$),
    persistedData,
  );
  return [...persisted, ...optimistic] satisfies ChatThreadEventView[];
});

export const eventDrivenChatThreads$ = computed((get) => {
  return replayChatThreadEvents(
    get(chatThreadsSnapshot$),
    get(allChatThreadsEvents$),
  );
});

export function optimisticChatThreadCreateUnsettled(threadId: string) {
  return computed((get): boolean => {
    return get(optimisticChatThreadCreateIds$).has(threadId);
  });
}

const canonicalThreadMetaMap$ = computed((get) => {
  const metaById = new Map<string, ThreadMeta>();
  for (const thread of get(eventDrivenChatThreads$)) {
    metaById.set(thread.id, {
      id: thread.id,
      agentId: thread.agentId,
      title: thread.title,
      pinnedAt: thread.pinnedAt,
      selectedModel: thread.selectedModel,
      modelSettings: thread.modelSettings,
      serviceTier: thread.serviceTier,
      computerUseHostId: thread.computerUseHostId,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      selectedVideoModel: thread.selectedVideoModel,
      selectedImageModel: thread.selectedImageModel,
    });
  }
  return metaById;
});

export const chatThreadMetaMap$ = computed((get) => {
  const metaById = new Map<string, ThreadMeta>();
  for (const { meta } of get(bootstrapThreadMetaState$).values()) {
    metaById.set(meta.id, meta);
  }
  for (const [threadId, meta] of get(canonicalThreadMetaMap$)) {
    metaById.set(threadId, meta);
  }
  return metaById;
});

export function threadMeta(threadId: string) {
  return computed((get): ThreadMeta | null => {
    return get(chatThreadMetaMap$).get(threadId) ?? null;
  });
}

function remoteThreadMeta(metadata: ChatThreadMetadata): ThreadMeta {
  return {
    id: metadata.id,
    agentId: metadata.agentId,
    title: metadata.title,
    pinnedAt: metadata.pinnedAt,
    selectedModel: metadata.selectedModel,
    modelSettings: metadata.modelSettings,
    serviceTier: metadata.serviceTier,
    computerUseHostId: metadata.computerUseHostId,
    cloudBrowserEnabled: metadata.cloudBrowserEnabled,
    selectedVideoModel: metadata.selectedVideoModel,
    selectedImageModel: metadata.selectedImageModel,
  };
}

const fetchRemoteThreadMeta$ = command(
  async (
    { get },
    threadId: string,
    signal: AbortSignal,
  ): Promise<RemoteThreadMetaResponse> => {
    const client = get(apiClient$)(chatThreadMetadataContract);
    const result = await accept(
      client.get({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200, 404],
      signal,
      { showErrorToast: false },
    );
    if (result.status === 404) {
      return { meta: null, outcome: "not-found" };
    }
    return { meta: remoteThreadMeta(result.body), outcome: "hit" };
  },
);

function waitForSharedWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const waitController = createChildAbortController(signal);
  const aborted = createDeferredPromise<never>(waitController.signal);
  return withCleanup(Promise.race([work, aborted.promise]), () => {
    waitController.abort(
      new DOMException("Thread metadata wait completed", "AbortError"),
    );
  });
}

const lookupEventStreamThreadMeta$ = command(
  async (
    { get },
    meta$: Computed<ThreadMeta | null>,
    sync: Promise<void>,
    signal: AbortSignal,
  ): Promise<ColdThreadMetaResolution> => {
    await waitForSharedWork(sync, signal);
    signal.throwIfAborted();
    return { source: "event-stream", meta: get(meta$) };
  },
);

const attemptRemoteThreadMeta$ = command(
  async (
    { set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<RemoteThreadMetaAttempt> => {
    const result = await settle(
      set(fetchRemoteThreadMeta$, threadId, signal),
      signal,
    );
    if (!result.ok) {
      set(captureChatThreadMetadataShortcut$, "transport-failure");
      return { source: "metadata-unavailable" };
    }
    set(captureChatThreadMetadataShortcut$, result.value.outcome);
    if (result.value.meta === null) {
      return { source: "metadata-unavailable" };
    }
    return { source: "metadata", meta: result.value.meta };
  },
);

async function resolveThreadMetaAttempts(
  metadata: Promise<RemoteThreadMetaAttempt>,
  eventStream: Promise<ColdThreadMetaResolution>,
): Promise<ColdThreadMetaResolution> {
  const first = await Promise.race([metadata, eventStream]);
  return first.source === "metadata-unavailable" ? eventStream : first;
}

const resolveColdThreadMeta$ = command(
  async (
    { set },
    threadId: string,
    meta$: Computed<ThreadMeta | null>,
    canonicalSync: Promise<void>,
    signal: AbortSignal,
  ): Promise<ColdThreadMetaResolution> => {
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    const controller = createChildAbortController(signal);
    const metadata = set(attemptRemoteThreadMeta$, threadId, controller.signal);
    const eventStream = set(
      lookupEventStreamThreadMeta$,
      meta$,
      canonicalSync,
      controller.signal,
    );
    return await withCleanup(
      resolveThreadMetaAttempts(metadata, eventStream),
      () => {
        controller.abort(
          new DOMException("Thread metadata resolved", "AbortError"),
        );
      },
    );
  },
);

export const resolveThreadMeta$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<ResolvedThreadMeta> => {
    const meta$ = threadMeta(threadId);
    let meta = get(meta$);
    if (meta) {
      return { meta, source: "memory" };
    }

    const localStartedAt = performance.now();
    await waitForSharedWork(get(initialLocalChatThreadEventsLoaded$), signal);
    signal.throwIfAborted();
    const localDurationMs = Math.round(performance.now() - localStartedAt);
    meta = get(meta$);
    if (meta) {
      return { localDurationMs, meta, source: "local" };
    }

    const remoteStartedAt = performance.now();
    const initialRemoteSync = get(initialRemoteChatThreadEventsSyncedDeferred$);
    // Refresh missing threads against current server state after initial sync.
    // This reader owns its own refresh, so another caller's cancellation can
    // never finish it.
    const canonicalSync = initialRemoteSync.settled()
      ? set(syncSharedEventDrivenChatThreads$, get(rootSignal$))
      : initialRemoteSync.promise;
    const syncVersion = get(chatThreadEventSyncVersion$);
    const resolution = await set(
      resolveColdThreadMeta$,
      threadId,
      meta$,
      canonicalSync,
      signal,
    );
    signal.throwIfAborted();
    if (resolution.meta && resolution.source === "metadata") {
      const registered = set(
        registerBootstrapThreadMeta$,
        resolution.meta,
        syncVersion,
        signal,
      );
      if (!registered) {
        meta = get(canonicalThreadMetaMap$).get(threadId) ?? null;
        return {
          localDurationMs,
          meta,
          remoteDurationMs: Math.round(performance.now() - remoteStartedAt),
          source: meta ? "remote" : "not_found",
        };
      }
    }
    return {
      localDurationMs,
      meta: resolution.meta,
      remoteDurationMs: Math.round(performance.now() - remoteStartedAt),
      source: resolution.meta ? "remote" : "not_found",
    };
  },
);

/** Synchronize the active primary chat tab title after committed thread data changes. */
const syncCurrentChatThreadDocumentTitle$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (get(activeRoute$) !== "chat") {
      return;
    }
    const threadId = get(pathParams$)?.threadId;
    if (typeof threadId !== "string") {
      return;
    }
    const meta = get(threadMeta(threadId));
    signal.throwIfAborted();
    if (meta) {
      set(
        updateDocumentTitle$,
        meta.title ??
          i18n.t(($) => {
            return $.chat.newChat;
          }),
      );
    }
  },
);

export const registerOptimisticChatThreadEvent$ = command(
  ({ set }, input: OptimisticChatThreadEventInput) => {
    const event: OptimisticChatThreadEvent = {
      title: null,
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedVideoModel: null,
      selectedImageModel: null,
      createdAt: nowDate().toISOString(),
      ...input,
    };
    set(optimisticChatThreadEventsState$, (events) => {
      if (
        events.some((existing) => {
          return existing.id === event.id;
        })
      ) {
        return events;
      }
      return [...events, event];
    });
  },
);

export const touchOptimisticChatThreadSort$ = command(
  (
    { set },
    args: {
      readonly id: string;
      readonly threadId: string;
      readonly agentId: string;
      readonly createdAt: string;
    },
  ) => {
    set(registerOptimisticChatThreadEvent$, {
      id: args.id,
      kind: "sort_touched",
      chatThreadId: args.threadId,
      agentId: args.agentId,
      createdAt: args.createdAt,
    });
  },
);

const reconcileOptimisticChatThreadEvents$ = command(
  ({ set }, persisted: ChatThreadEventData) => {
    set(optimisticChatThreadEventsState$, (events) => {
      return filterUnsettledOptimisticChatThreadEvents(events, persisted);
    });
  },
);
