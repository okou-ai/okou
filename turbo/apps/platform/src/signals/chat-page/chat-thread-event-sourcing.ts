import { command, computed, state, type Command } from "ccstate";
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
  resetSignal,
  waitForOperation,
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

type CacheMissThreadMetaResolution =
  | { readonly source: "event-stream"; readonly meta: ThreadMeta | null }
  | { readonly source: "metadata"; readonly meta: ThreadMeta };

type ThreadMetadataShortcutAttempt =
  | Extract<CacheMissThreadMetaResolution, { readonly source: "metadata" }>
  | { readonly source: "metadata-unavailable" };

type ThreadMetaResolutionPath =
  | "after-cache-hydration"
  | "canonical-event-stream"
  | "canonical-not-found"
  | "current-projection"
  | "metadata-shortcut";

interface ThreadMetaLookupResult {
  readonly cacheHydrationWaitMs?: number;
  readonly cacheMissResolutionMs?: number;
  readonly meta: ThreadMeta | null;
  readonly resolutionPath: ThreadMetaResolutionPath;
}

interface ThreadMetadataShortcutResponse {
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
const initialChatThreadEventCacheHydrationDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
const initialChatThreadEventCanonicalReadyDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

const initialChatThreadEventCacheHydrated$ = computed((get) => {
  return get(initialChatThreadEventCacheHydrationDeferred$).promise;
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

const applyPersistedChatThreadEventResult$ = command(
  (
    { set },
    result: ChatThreadEventQueryResult,
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
  },
);

const hydrateSharedChatThreadEventCache$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const dataKey = await get(sharedChatThreadEventDataKey$);
    signal.throwIfAborted();
    const cached = await set(
      queryChatThreadEventSharedDatabase$,
      { dataKey, afterSeqId: null, consistency: "cache-only" },
      signal,
    );
    signal.throwIfAborted();
    set(applyPersistedChatThreadEventResult$, cached, signal);
    const hydration = get(initialChatThreadEventCacheHydrationDeferred$);
    if (!hydration.settled()) {
      hydration.resolve();
    }
  },
);

// Each caller runs its own catch-up: a mutation can commit after an older sync
// has already read its result, so sharing one in-flight refresh would serve a
// stale answer. Failure remains a rejection, never authoritative not-found.
const catchUpSharedChatThreadEventSource$ = command(
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
    set(applyPersistedChatThreadEventResult$, result, signal);
    set(clearBootstrapThreadMeta$);
    const canonicalReady = get(initialChatThreadEventCanonicalReadyDeferred$);
    if (!canonicalReady.settled()) {
      canonicalReady.resolve();
    }
  },
);

const initializeSharedChatThreadEventSource$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(hydrateSharedChatThreadEventCache$, signal);
    await set(catchUpSharedChatThreadEventSource$, signal);
  },
);

export const catchUpChatThreadEventSource$ =
  catchUpSharedChatThreadEventSource$;

export const initializeChatThreadEventSource$ =
  initializeSharedChatThreadEventSource$;

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

function threadMetaFromMetadata(metadata: ChatThreadMetadata): ThreadMeta {
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

const fetchThreadMetadataShortcut$ = command(
  async (
    { get },
    threadId: string,
    signal: AbortSignal,
  ): Promise<ThreadMetadataShortcutResponse> => {
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
    return { meta: threadMetaFromMetadata(result.body), outcome: "hit" };
  },
);

const lookupEventStreamThreadMeta$ = command(
  async (
    { get },
    threadId: string,
    eventStreamReady: Promise<void>,
    signal: AbortSignal,
  ): Promise<CacheMissThreadMetaResolution> => {
    signal.throwIfAborted();
    await waitForOperation(eventStreamReady, signal);
    signal.throwIfAborted();
    return {
      source: "event-stream",
      meta: get(chatThreadMetaMap$).get(threadId) ?? null,
    };
  },
);

const attemptThreadMetadataShortcut$ = command(
  async (
    { set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<ThreadMetadataShortcutAttempt> => {
    const result = await settle(
      set(fetchThreadMetadataShortcut$, threadId, signal),
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

async function resolveCacheMissThreadMetaAttempts(
  metadata: Promise<ThreadMetadataShortcutAttempt>,
  eventStream: Promise<CacheMissThreadMetaResolution>,
): Promise<CacheMissThreadMetaResolution> {
  const first = await Promise.race([metadata, eventStream]);
  return first.source === "metadata-unavailable" ? eventStream : first;
}

function cacheMissResolutionPath(
  resolution: CacheMissThreadMetaResolution,
): ThreadMetaResolutionPath {
  if (resolution.meta === null) {
    return "canonical-not-found";
  }
  return resolution.source === "metadata"
    ? "metadata-shortcut"
    : "canonical-event-stream";
}

/** Construct one lookup graph for each requesting surface, including same-thread readers. */
export function createThreadMetaLookup(): Command<
  Promise<ThreadMetaLookupResult>,
  [string, AbortSignal]
> {
  const resetRace$ = resetSignal();
  const resolveCacheMissThreadMeta$ = command(
    async (
      { set },
      threadId: string,
      canonicalEventStreamReady: Promise<void>,
      signal: AbortSignal,
    ): Promise<CacheMissThreadMetaResolution> => {
      signal.throwIfAborted();
      const raceSignal = set(resetRace$, signal);
      const metadataShortcut = set(
        attemptThreadMetadataShortcut$,
        threadId,
        raceSignal,
      );
      const eventStream = set(
        lookupEventStreamThreadMeta$,
        threadId,
        canonicalEventStreamReady,
        raceSignal,
      );
      return await withCleanup(
        resolveCacheMissThreadMetaAttempts(metadataShortcut, eventStream),
        () => {
          // A replaced or cancelled lookup must not reset a newer race.
          if (!raceSignal.aborted) {
            set(resetRace$);
          }
        },
      );
    },
  );

  return command(
    async (
      { get, set },
      threadId: string,
      signal: AbortSignal,
    ): Promise<ThreadMetaLookupResult> => {
      signal.throwIfAborted();
      let meta = get(chatThreadMetaMap$).get(threadId) ?? null;
      if (meta) {
        return { meta, resolutionPath: "current-projection" };
      }

      const cacheHydrationStartedAt = performance.now();
      await waitForOperation(
        get(initialChatThreadEventCacheHydrated$),
        signal,
      );
      signal.throwIfAborted();
      const cacheHydrationWaitMs = Math.round(
        performance.now() - cacheHydrationStartedAt,
      );
      meta = get(chatThreadMetaMap$).get(threadId) ?? null;
      if (meta) {
        return {
          cacheHydrationWaitMs,
          meta,
          resolutionPath: "after-cache-hydration",
        };
      }

      const cacheMissResolutionStartedAt = performance.now();
      const initialCanonicalReady = get(
        initialChatThreadEventCanonicalReadyDeferred$,
      );
      // Refresh missing threads against the current canonical event source
      // after initial readiness. This reader owns its own refresh, so another
      // caller's cancellation can never finish it.
      const canonicalEventStreamReady = initialCanonicalReady.settled()
        ? set(catchUpSharedChatThreadEventSource$, get(rootSignal$))
        : initialCanonicalReady.promise;
      const syncVersion = get(chatThreadEventSyncVersion$);
      const resolution = await set(
        resolveCacheMissThreadMeta$,
        threadId,
        canonicalEventStreamReady,
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
            cacheHydrationWaitMs,
            cacheMissResolutionMs: Math.round(
              performance.now() - cacheMissResolutionStartedAt,
            ),
            meta,
            resolutionPath: meta
              ? "canonical-event-stream"
              : "canonical-not-found",
          };
        }
      }
      return {
        cacheHydrationWaitMs,
        cacheMissResolutionMs: Math.round(
          performance.now() - cacheMissResolutionStartedAt,
        ),
        meta: resolution.meta,
        resolutionPath: cacheMissResolutionPath(resolution),
      };
    },
  );
}

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
