import { computed, type Computed } from "ccstate";
import {
  groupSemanticChatEvents,
  isUsageEvent,
  semanticChatEventsFromChatEvents,
  type SemanticChatEventState,
} from "@okouai/api-contracts/contracts/chat-event-semantics";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  chatRunEventContextFromChatEvents,
  deriveRunIndicatorStateFromChatEvents,
  lastAssistantCancelledFromGroups,
  liveRunIdsFromChatEvents,
  modelSelectionForChatRun,
  queuedEventsFromSemanticEvents,
  type ChatRunModelSelection,
} from "./chat-event-state.ts";

/** Shared event projections owned by one thread's signal graph. */
export function createChatEventProjectionSignals(
  chatEvents$: Computed<ChatEvent[]>,
) {
  const semanticEvents$ = computed((get): SemanticChatEventState[] => {
    return semanticChatEventsFromChatEvents(get(chatEvents$));
  });
  const semanticGroups$ = computed((get) => {
    return groupSemanticChatEvents(get(semanticEvents$));
  });
  const hasEvents$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      get(semanticEvents$).some((entry) => {
        return !isUsageEvent(entry.event);
      }),
    );
  });
  const queuedEvents$ = computed((get) => {
    return queuedEventsFromSemanticEvents(get(semanticEvents$));
  });
  const runContext$ = computed((get) => {
    return chatRunEventContextFromChatEvents(get(chatEvents$));
  });
  const runIndicatorState$ = computed((get) => {
    return deriveRunIndicatorStateFromChatEvents(
      get(chatEvents$),
      get(runContext$),
    );
  });
  const liveRunIds$ = computed((get) => {
    return liveRunIdsFromChatEvents(get(chatEvents$), get(runContext$));
  });
  const activeRunId$ = computed((get): string | null => {
    return get(liveRunIds$).at(-1) ?? null;
  });
  const runningModelSelection$ = computed(
    (get): Promise<ChatRunModelSelection | null> => {
      return Promise.resolve(
        modelSelectionForChatRun(
          get(chatEvents$),
          get(activeRunId$),
          get(runContext$).revokedEventIds,
        ),
      );
    },
  );
  const sending$ = computed((get): Promise<boolean> => {
    const running = get(runIndicatorState$) !== null;
    const lastAssistantCancelled = lastAssistantCancelledFromGroups(
      get(semanticGroups$),
    );
    return Promise.resolve(running && !lastAssistantCancelled);
  });

  return {
    semanticEvents$,
    semanticGroups$,
    hasEvents$,
    queuedEvents$,
    liveRunIds$,
    activeRunId$,
    runningModelSelection$,
    sending$,
  };
}

export type ChatEventProjectionSignals = ReturnType<
  typeof createChatEventProjectionSignals
>;
