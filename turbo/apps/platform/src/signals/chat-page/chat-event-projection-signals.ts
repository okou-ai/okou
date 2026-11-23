import { computed, type Computed } from "ccstate";
import {
  groupSemanticChatEvents,
  isUsageEvent,
  semanticChatEventsFromChatEvents,
  type SemanticChatEventState,
  type SemanticChatGroups,
} from "@okouai/api-contracts/contracts/chat-event-semantics";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  chatRunEventContextFromChatEvents,
  deriveRunIndicatorStateFromChatEvents,
  liveRunIdsFromChatEvents,
} from "@okouai/api-contracts/contracts/chat-run-state";
import {
  lastAssistantCancelledFromGroups,
  modelSelectionForChatRun,
  queuedEventsFromSemanticEvents,
  type ChatRunModelSelection,
} from "./chat-event-state.ts";

import { resolveChatEventRecommendedFollowups } from "@okouai/api-contracts/validators/chat-threads";
import {
  chatEventCompatibilityRole,
  isChatEventContentTextType,
} from "@okouai/api-contracts/contracts/chat-events";
import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";

export interface RecommendedFollowupSource {
  readonly eventId: string;
  readonly followups: readonly ChatRecommendedFollowup[];
}

function latestRecommendedFollowupsFromGroups(
  groups: SemanticChatGroups<SemanticChatEventState>,
): RecommendedFollowupSource | null {
  const { activeGroups } = groups;
  for (
    let groupIndex = activeGroups.length - 1;
    groupIndex >= 0;
    groupIndex--
  ) {
    const group = activeGroups[groupIndex];
    if (!group) {
      continue;
    }
    if (group.role !== "assistant") {
      return null;
    }
    for (
      let eventIndex = group.events.length - 1;
      eventIndex >= 0;
      eventIndex--
    ) {
      const event = group.events[eventIndex]?.event;
      if (
        !event ||
        chatEventCompatibilityRole(event.eventType) !== "assistant"
      ) {
        continue;
      }
      if (event.eventType === "output.followups") {
        // Video generation is retired, so an older run's video suggestion is
        // not offered as a next step.
        const followups = resolveChatEventRecommendedFollowups(event).filter(
          (followup) => {
            return followup.generationType !== "video";
          },
        );
        if (followups.length > 0) {
          return { eventId: event.id, followups };
        }
        return null;
      }
      if (
        isChatEventContentTextType(event.eventType) &&
        event.content?.trim()
      ) {
        return null;
      }
    }
  }
  return null;
}

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
    recommendedFollowupSource$: computed((get) => {
      return latestRecommendedFollowupsFromGroups(get(semanticGroups$));
    }),
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
