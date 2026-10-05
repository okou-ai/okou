import { command, computed, state, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { compareCreatedAt } from "./compare-created-at.ts";
import type { ChatEventGroup } from "./chat-event.ts";
import type { ThreadScrollPosition } from "./chat-thread-scroll.ts";

export interface ChatLastReadMarker {
  readonly eventId: string;
  readonly previouslyRead: boolean;
}

function firstUnreadGroup(
  groups: readonly ChatEventGroup[],
  readAt: string | null,
): ChatEventGroup | undefined {
  const unreadGroup = groups.find((group) => {
    return group.events.some((event) => {
      return (
        event.seqId !== undefined &&
        !event.isQueued &&
        (readAt === null || compareCreatedAt(event.createdAt, readAt) > 0)
      );
    });
  });
  const runId = unreadGroup?.events.find((event) => {
    return !event.isQueued && event.runId !== undefined;
  })?.runId;
  // Keep the divider outside folded work and do not split a Run's reply.
  return runId === undefined
    ? unreadGroup
    : groups.find((group) => {
        return group.events.some((event) => {
          return !event.isQueued && event.runId === runId;
        });
      });
}

export function createChatLastReadMarkerSignals({
  threadDetail$,
  allChatGroups$,
  threadScrollPosition$,
}: {
  readonly threadDetail$: Computed<
    Promise<{ readonly lastReadAt: string | null } | null>
  >;
  readonly allChatGroups$: Computed<ChatEventGroup[]>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
}) {
  const entryReadAt$ = state<string | null | undefined>(undefined);
  const initialScrollPending$ = state(true);
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ChatLastReadMarker];
  });
  const initialize$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(enabled$)) {
      return;
    }
    // Capture before event setup can invoke the existing mark-read action.
    // Later detail reloads and cross-tab read updates must not move this line.
    const detail = await get(threadDetail$);
    signal.throwIfAborted();
    set(entryReadAt$, detail?.lastReadAt);
  });
  const marker$ = computed((get): ChatLastReadMarker | null => {
    const readAt = get(entryReadAt$);
    if (!get(enabled$) || readAt === undefined) {
      return null;
    }
    const group = firstUnreadGroup(get(allChatGroups$), readAt);
    const event = group?.events.find((candidate) => {
      return candidate.seqId !== undefined && !candidate.isQueued;
    });
    return event
      ? { eventId: event.id, previouslyRead: readAt !== null }
      : null;
  });
  const initialScrollPosition$ = command(
    (
      { get, set },
      position: ThreadScrollPosition | null,
      hasOptimisticUserMessage: boolean,
    ): ThreadScrollPosition | null => {
      if (!get(enabled$) || !get(initialScrollPending$)) {
        return position;
      }
      if (hasOptimisticUserMessage) {
        set(initialScrollPending$, false);
        return position;
      }
      // A message-link jump can acquire its anchor while rich content is
      // being prepared. Do not overwrite that newer navigation request.
      const heldPosition = get(threadScrollPosition$) ?? position;
      if (heldPosition !== null) {
        set(initialScrollPending$, false);
        return heldPosition;
      }
      const marker = get(marker$);
      if (!marker) {
        return position;
      }
      set(initialScrollPending$, false);
      return {
        targetEventId: marker.eventId,
        viewportOffsetTop: 16,
        anchor: "last-read-marker",
      };
    },
  );
  const finishInitialScroll$ = command(({ set }) => {
    // An already-read thread must not jump when new messages arrive later.
    set(initialScrollPending$, false);
  });
  return { initialize$, marker$, initialScrollPosition$, finishInitialScroll$ };
}
