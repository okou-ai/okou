import {
  chatEventCompatibilityRole,
  isBrowserLifecycleEventType,
  isChatGoalMarkerEventType,
  isChatInputEventType,
} from "./chat-events";
import type { ChatEvent as PersistedChatEvent } from "./chat-threads";

type UnsequencedChatEvent<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

// Local optimistic events use the same business shape without server ordering.
// Persisted-only callers retain their required seqId through the overload below.
type ChatEvent = (
  | PersistedChatEvent
  | UnsequencedChatEvent<PersistedChatEvent>
) & {
  readonly optimisticUserMessageAssociation?: "run" | "queue";
};

type RecallControlEvent = Extract<
  ChatEvent,
  { eventType: "control.revoke" | "run.dequeued" }
>;

export function isRecallControlEvent(
  event: ChatEvent,
): event is RecallControlEvent {
  return (
    event.eventType === "control.revoke" || event.eventType === "run.dequeued"
  );
}

export function isQueueMarkerEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "run.queued" }> {
  return event.eventType === "run.queued";
}

export function isGoalMarkerEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "goal.open" | "goal.close" }> {
  return isChatGoalMarkerEventType(event.eventType);
}

export function isFollowupsEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "output.followups" }> {
  return event.eventType === "output.followups";
}

export function isGoalQueueEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "input.goal" }> {
  return event.eventType === "input.goal";
}

export function isUsageEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "usage.recorded" }> {
  return event.eventType === "usage.recorded";
}

export function isInterruptControlEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "control.interrupt" }> {
  return event.eventType === "control.interrupt";
}

function createInterruptedAssistantProjection(
  event: Extract<ChatEvent, { eventType: "control.interrupt" }>,
  runId: string,
): ChatEvent {
  const { interruptsRunId, ...rest } = event;
  void interruptsRunId;
  return {
    ...rest,
    eventType: "run.cancelled" as const,
    content: "Run cancelled",
    runId,
    error: "Run cancelled",
    runLifecycleEvent: "cancelled",
  };
}

export function isInterruptedAssistantCancellation(
  event: ChatEvent,
  interruptedRunIds: ReadonlySet<string>,
): boolean {
  const runId = event.runId;
  return (
    runId !== undefined &&
    event.eventType === "run.cancelled" &&
    interruptedRunIds.has(runId)
  );
}

export interface SemanticChatEventState<TEvent extends ChatEvent = ChatEvent> {
  readonly event: TEvent;
  readonly isQueued: boolean;
  readonly inputCreatedAt?: string;
}

export interface SemanticChatEventGroup<
  T extends SemanticChatEventState = SemanticChatEventState,
> {
  readonly role: "user" | "assistant";
  readonly events: T[];
}

export interface SemanticChatGroups<
  T extends SemanticChatEventState = SemanticChatEventState,
> {
  readonly activeGroups: SemanticChatEventGroup<T>[];
  readonly allGroups: SemanticChatEventGroup<T>[];
}

function isHiddenSemanticChatEvent(
  event: ChatEvent,
  context: {
    readonly interruptedRunIds: ReadonlySet<string>;
    readonly automationInputIds: ReadonlySet<string>;
    readonly recalledIds: ReadonlySet<string>;
    readonly replacedIds: ReadonlySet<string>;
  },
): boolean {
  return (
    isRecallControlEvent(event) ||
    isQueueMarkerEvent(event) ||
    isGoalQueueEvent(event) ||
    event.eventType === "input.budget" ||
    isGoalMarkerEvent(event) ||
    isBrowserLifecycleEventType(event.eventType) ||
    isInterruptedAssistantCancellation(event, context.interruptedRunIds) ||
    (event.eventType === "input.rejected" &&
      event.revokesEventId !== undefined &&
      context.automationInputIds.has(event.revokesEventId)) ||
    context.recalledIds.has(event.id) ||
    context.replacedIds.has(event.id)
  );
}

/** Derive visible semantic events from a complete ordered canonical history. */
export function semanticChatEventsFromChatEvents(
  events: readonly PersistedChatEvent[],
): SemanticChatEventState<PersistedChatEvent>[];
export function semanticChatEventsFromChatEvents(
  events: readonly ChatEvent[],
): SemanticChatEventState[];
export function semanticChatEventsFromChatEvents(
  events: readonly ChatEvent[],
): SemanticChatEventState[] {
  const interruptedRunIds = new Set(
    events.flatMap((event) => {
      return isInterruptControlEvent(event) && event.interruptsRunId
        ? [event.interruptsRunId]
        : [];
    }),
  );
  const recalledIds = new Set(
    events.flatMap((event) => {
      return isRecallControlEvent(event) && event.revokesEventId
        ? [event.revokesEventId]
        : [];
    }),
  );
  const replacedIds = new Set(
    events.flatMap((event) => {
      return !isRecallControlEvent(event) && event.revokesEventId
        ? [event.revokesEventId]
        : [];
    }),
  );
  const automationInputIds = new Set(
    events.flatMap((event) => {
      return event.eventType === "input.automation" ? [event.id] : [];
    }),
  );

  // Resolve submission times before hiding replaced inputs. Delivery appends a
  // new event, but does not start another user-facing work interval.
  const inputCreatedAtById = new Map<string, string>();
  for (const event of events) {
    if (isChatInputEventType(event.eventType)) {
      const previousCreatedAt = event.revokesEventId
        ? inputCreatedAtById.get(event.revokesEventId)
        : undefined;
      inputCreatedAtById.set(event.id, previousCreatedAt ?? event.createdAt);
    }
  }

  return events.flatMap((event): SemanticChatEventState[] => {
    if (
      isHiddenSemanticChatEvent(event, {
        interruptedRunIds,
        automationInputIds,
        recalledIds,
        replacedIds,
      })
    ) {
      return [];
    }
    if (isInterruptControlEvent(event) && event.interruptsRunId) {
      return [
        {
          event: createInterruptedAssistantProjection(
            event,
            event.interruptsRunId,
          ),
          isQueued: false,
        },
      ];
    }

    const isUnassociatedUser =
      chatEventCompatibilityRole(event.eventType) === "user" &&
      event.runId === undefined;
    const optimisticAssociation = event.optimisticUserMessageAssociation;
    const isQueued =
      isUnassociatedUser &&
      optimisticAssociation !== "run" &&
      event.eventType === "input.automation";
    return [
      { event, isQueued, inputCreatedAt: inputCreatedAtById.get(event.id) },
    ];
  });
}

export function orderSemanticEventsByRunTurn<T extends SemanticChatEventState>(
  events: readonly T[],
): T[] {
  const items: { order: number; events: T[] }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const semanticEvent of events) {
    const runId = semanticEvent.event.runId;
    if (runId === undefined) {
      items.push({ order: items.length, events: [semanticEvent] });
      continue;
    }
    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.events.push(semanticEvent);
      continue;
    }
    const item = { order: items.length, events: [semanticEvent] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((left, right) => {
      return left.order - right.order;
    })
    .flatMap((item) => {
      return item.events;
    });
}

function shouldMergeSemanticEvent<T extends SemanticChatEventState>(
  group: SemanticChatEventGroup<T>,
  semanticEvent: T,
): boolean {
  if (
    group.role !== chatEventCompatibilityRole(semanticEvent.event.eventType)
  ) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }
  const groupRunId = group.events.find((entry) => {
    return entry.event.runId !== undefined;
  })?.event.runId;
  const eventRunId = semanticEvent.event.runId;
  return (
    groupRunId === undefined ||
    eventRunId === undefined ||
    groupRunId === eventRunId
  );
}

function groupSemanticEvents<T extends SemanticChatEventState>(
  events: readonly T[],
): SemanticChatEventGroup<T>[] {
  const groups: SemanticChatEventGroup<T>[] = [];
  for (const semanticEvent of events) {
    const lastGroup = groups.at(-1);
    if (lastGroup && shouldMergeSemanticEvent(lastGroup, semanticEvent)) {
      lastGroup.events.push(semanticEvent);
      continue;
    }
    groups.push({
      role: chatEventCompatibilityRole(semanticEvent.event.eventType),
      events: [semanticEvent],
    });
  }
  return groups;
}

export function groupSemanticChatEvents<T extends SemanticChatEventState>(
  semanticEvents: readonly T[],
): SemanticChatGroups<T> {
  const activeEvents: T[] = [];
  const queuedEvents: T[] = [];
  for (const semanticEvent of semanticEvents) {
    if (isUsageEvent(semanticEvent.event)) {
      continue;
    }
    if (
      chatEventCompatibilityRole(semanticEvent.event.eventType) === "user" &&
      semanticEvent.isQueued
    ) {
      queuedEvents.push(semanticEvent);
      continue;
    }
    activeEvents.push(semanticEvent);
  }
  const activeGroups = groupSemanticEvents(
    orderSemanticEventsByRunTurn(activeEvents),
  );
  return {
    activeGroups,
    allGroups: [...activeGroups, ...groupSemanticEvents(queuedEvents)],
  };
}
