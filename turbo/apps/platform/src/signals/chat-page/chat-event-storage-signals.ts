import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import type { ChatEventDataKey } from "../../shared-database/data-key.ts";
import { queryChatEventSharedDatabase$ } from "../shared-database.ts";
import { reloadBillingStatus$ } from "../okou-page/billing.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import {
  deliveryIntentsChanged$,
  listDeliveryIntents,
  removeDeliveryIntent,
} from "./chat-delivery-intents.ts";
import { notifyChatEventsChanged$ } from "./chat-event-change-registry.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  deriveServerRunStateFromChatEvents,
  type RunIndicatorState,
} from "./chat-event-state.ts";
import {
  appendOptimisticChatEvent$,
  createOptimisticChatEventEntry,
  createOptimisticChatEventsForThread,
  reconcileOptimisticChatEvents$,
  type OptimisticChatEventEntry,
  type OptimisticChatEventInput,
} from "./optimistic-chat-events.ts";
export type AppendOptimisticEventCommand = Command<
  Promise<void>,
  [OptimisticChatEventInput, AbortSignal]
>;

type PersistentChatEvents$ = State<PersistedChatEvent[]>;

function completedRunIdsFromEvents(
  events: readonly PersistedChatEvent[],
): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.eventType === "run.completed" && event.runId !== undefined) {
      ids.add(event.runId);
    }
  }
  return Array.from(ids);
}

function reportNewCompletedRuns({
  persistentEvents,
  events,
}: {
  persistentEvents: readonly PersistedChatEvent[];
  events: readonly PersistedChatEvent[];
}): boolean {
  const reportedCompletedRunIds = new Set(
    completedRunIdsFromEvents(persistentEvents),
  );
  const newlyCompletedRunIds = completedRunIdsFromEvents(events).filter(
    (runId) => {
      return !reportedCompletedRunIds.has(runId);
    },
  );
  for (const _ of newlyCompletedRunIds) {
    captureTaskCompletedSuccessfully();
  }
  return newlyCompletedRunIds.length > 0;
}

/**
 * An insufficient-credits rejection is rendered with the org's billing state,
 * so a newly persisted one refreshes that state instead of trusting a copy
 * loaded before the credits ran out. A rejection is new when it follows the
 * last known persisted event, or when it resolves a user message this page is
 * still showing optimistically (a new thread's first send has no persisted
 * baseline). Other rejections in the first merge of a thread's history are
 * old, and the billing state loaded with the page covers them.
 */
function hasNewInsufficientCreditsRejection({
  persistentEvents,
  events,
  pendingUserMessageIds,
}: {
  persistentEvents: readonly PersistedChatEvent[];
  events: readonly PersistedChatEvent[];
  pendingUserMessageIds: ReadonlySet<string>;
}): boolean {
  const lastKnownSeqId = persistentEvents.at(-1)?.seqId;
  return events.some((event) => {
    if (
      event.eventType !== "input.rejected" ||
      event.error !== "insufficient_credits"
    ) {
      return false;
    }
    return (
      (lastKnownSeqId !== undefined && event.seqId > lastKnownSeqId) ||
      pendingUserMessageIds.has(event.id) ||
      (event.revokesEventId !== undefined &&
        pendingUserMessageIds.has(event.revokesEventId))
    );
  });
}

function mergePersistentEvents(
  eventSets: readonly (readonly PersistedChatEvent[])[],
): PersistedChatEvent[] {
  const byId = new Map<string, PersistedChatEvent>();
  for (const events of eventSets) {
    for (const event of events) {
      byId.set(event.id, event);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return left.seqId - right.seqId;
  });
}

function createStoredChatEventsComputed({
  persistentEvents$,
  optimisticEvents$,
}: {
  persistentEvents$: PersistentChatEvents$;
  optimisticEvents$: Computed<OptimisticChatEventEntry[]>;
}): Computed<ChatEvent[]> {
  return computed((get): ChatEvent[] => {
    const persistentEvents = get(persistentEvents$);
    const serverIds = new Set(
      persistentEvents.map((event) => {
        return event.id;
      }),
    );
    const optimisticEvents = get(optimisticEvents$).filter((entry) => {
      return !serverIds.has(entry.event.id);
    });
    return [
      ...persistentEvents,
      ...optimisticEvents.map((entry) => {
        const association = entry.optimisticUserMessageAssociation;
        return association === undefined
          ? entry.event
          : {
              ...entry.event,
              optimisticUserMessageAssociation: association,
            };
      }),
    ];
  });
}

const reconcilePersistedDeliveryIntents$ = command(
  async (
    { get, set },
    threadId: string,
    events: readonly PersistedChatEvent[],
    signal: AbortSignal,
  ) => {
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const delivered = new Set(events.map((event) => {return event.id}));
    for (const intent of listDeliveryIntents(identity)) {
      if (intent.threadId === threadId && delivered.has(intent.clientEventId)) {
        removeDeliveryIntent(identity, intent.clientEventId);
      }
    }
    set(deliveryIntentsChanged$);
  },
);

function createSharedDatabaseEventSignals({
  threadId,
  persistentChatEvents$,
  chatEvents$,
  mergePersistentEvents$,
}: {
  readonly threadId: string;
  readonly persistentChatEvents$: PersistentChatEvents$;
  readonly chatEvents$: Computed<ChatEvent[]>;
  readonly mergePersistentEvents$: Command<
    Promise<void>,
    [PersistedChatEvent[], AbortSignal]
  >;
}) {
  const dataKey$ = computed((): ChatEventDataKey => {
    return { kind: "chat-event", threadId };
  });
  const load$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const dataKey = await get(dataKey$);
      signal.throwIfAborted();
      const rows = await set(
        queryChatEventSharedDatabase$,
        { dataKey, afterSeqId: null, consistency: "cache-only" },
        signal,
      );
      signal.throwIfAborted();
      if (rows.length === 0) {
        return;
      }
      const events = rows.map((row) => {
        return chatEventFromRow(row);
      });
      set(persistentChatEvents$, (previous) => {
        return mergePersistentEvents([previous, events]);
      });
      set(reconcileOptimisticChatEvents$, { threadId, events });
      await set(reconcilePersistedDeliveryIntents$, threadId, events, signal);
      signal.throwIfAborted();
      await set(notifyChatEventsChanged$, chatEvents$, signal);
    },
  );
  const sync$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const dataKey = await get(dataKey$);
      signal.throwIfAborted();
      const afterSeqId = get(persistentChatEvents$).at(-1)?.seqId ?? null;
      const cachedRows = await set(
        queryChatEventSharedDatabase$,
        { dataKey, afterSeqId, consistency: "cache-only" },
        signal,
      );
      signal.throwIfAborted();
      const rows =
        cachedRows.length > 0
          ? cachedRows
          : await set(
              queryChatEventSharedDatabase$,
              { dataKey, afterSeqId, consistency: "catch-up" },
              signal,
            );
      signal.throwIfAborted();
      await set(
        mergePersistentEvents$,
        rows.map((row) => {
          return chatEventFromRow(row);
        }),
        signal,
      );
      signal.throwIfAborted();
    },
  );
  return { load$, sync$ };
}

export function createChatEventStorageSignals({
  threadId,
}: {
  threadId: string;
}) {
  const persistentChatEvents$ = state<PersistedChatEvent[]>([]);
  const optimisticEvents$ = createOptimisticChatEventsForThread(threadId);
  const hasOptimisticUserMessage$ = computed((get): boolean => {
    return get(optimisticEvents$).some((entry) => {
      return entry.optimisticUserMessageAssociation !== undefined;
    });
  });
  const serverRunState$ = computed((get): RunIndicatorState => {
    return deriveServerRunStateFromChatEvents(get(persistentChatEvents$));
  });
  const chatEvents$ = createStoredChatEventsComputed({
    persistentEvents$: persistentChatEvents$,
    optimisticEvents$,
  });
  const appendOptimisticEvent$: AppendOptimisticEventCommand = command(
    async (
      { set },
      input: OptimisticChatEventInput,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      set(appendOptimisticChatEvent$, createOptimisticChatEventEntry(input));
      await set(notifyChatEventsChanged$, chatEvents$, signal);
    },
  );
  const mergePersistentEvents$ = command(
    async (
      { get, set },
      events: PersistedChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (events.length === 0) {
        return;
      }
      const persistentEvents = get(persistentChatEvents$);
      reportNewCompletedRuns({ persistentEvents, events });
      const pendingUserMessageIds = new Set(
        get(optimisticEvents$).flatMap((entry) => {
          return entry.optimisticUserMessageAssociation === undefined
            ? []
            : [entry.event.id];
        }),
      );
      if (
        hasNewInsufficientCreditsRejection({
          persistentEvents,
          events,
          pendingUserMessageIds,
        })
      ) {
        set(reloadBillingStatus$);
      }
      set(persistentChatEvents$, (previous) => {
        return mergePersistentEvents([previous, events]);
      });
      set(reconcileOptimisticChatEvents$, { threadId, events });
      await set(reconcilePersistedDeliveryIntents$, threadId, events, signal);
      signal.throwIfAborted();
      await set(notifyChatEventsChanged$, chatEvents$, signal);
      signal.throwIfAborted();
    },
  );
  const sharedDatabase = createSharedDatabaseEventSignals({
    threadId,
    persistentChatEvents$,
    chatEvents$,
    mergePersistentEvents$,
  });
  const syncRemoteEvents$ = sharedDatabase.sync$;
  /** Unlike the ordinary incremental sync, retry must contact the server. */
  const confirmDelivery$ = command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<boolean> => {
      const rows = await set(
        queryChatEventSharedDatabase$,
        {
          dataKey: { kind: "chat-event", threadId },
          afterSeqId: null,
          consistency: "catch-up",
        },
        signal,
      );
      signal.throwIfAborted();
      await set(mergePersistentEvents$, rows.map(chatEventFromRow), signal);
      return rows.some((row) => {return row.id === eventId});
    },
  );
  const initializeIndexedDbEvents$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(sharedDatabase.load$, signal);
    },
  );

  return {
    chatEvents$,
    hasOptimisticUserMessage$,
    serverRunState$,
    initializeIndexedDbEvents$,
    appendOptimisticEvent$,
    syncRemoteEvents$,
    confirmDelivery$,
  };
}
