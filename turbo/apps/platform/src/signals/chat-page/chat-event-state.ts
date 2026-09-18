import {
  chatEventCompatibilityRole,
  foldChatRunStates,
  isChatRunTerminalEventType,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "@okouai/api-contracts/contracts/chat-events";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import type { ChatEvent } from "./chat-event-types.ts";

import {
  isGoalMarkerEvent,
  isQueueMarkerEvent,
  isUsageEvent,
  semanticChatEventsFromChatEvents,
  type SemanticChatEventState,
  type SemanticChatGroups,
} from "@okouai/api-contracts/contracts/chat-event-semantics";

type QueuedChatEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.automation" }
>;

function isQueuedChatEvent(event: ChatEvent): event is QueuedChatEvent {
  return (
    event.eventType === "input.prompt" || event.eventType === "input.automation"
  );
}

export function queuedEventsFromSemanticEvents(
  semanticEvents: readonly SemanticChatEventState[],
): QueuedChatEvent[] {
  return semanticEvents.flatMap((entry) => {
    const { event } = entry;
    return chatEventCompatibilityRole(event.eventType) === "user" &&
      entry.isQueued &&
      isQueuedChatEvent(event)
      ? [event]
      : [];
  });
}

export function queuedEventsFromChatEvents(
  events: readonly ChatEvent[],
): QueuedChatEvent[] {
  return queuedEventsFromSemanticEvents(
    semanticChatEventsFromChatEvents(events),
  );
}

export function lastAssistantCancelledFromGroups(
  groups: SemanticChatGroups,
): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastEvent = lastGroup?.events.at(-1)?.event;
  return lastEvent ? isCancelledRunEvent(lastEvent) : false;
}

export type RunIndicatorState = "pending" | "running" | "queued" | null;
type ActiveRunIndicatorState = "pending" | "running" | null;

interface RunIndicatorContext {
  readonly terminatedRunIds: ReadonlySet<string>;
  readonly queuedRunIds: ReadonlySet<string>;
}

function runActivityIndicatorState(
  context: RunIndicatorContext,
  runId: string,
): ActiveRunIndicatorState | undefined {
  if (context.terminatedRunIds.has(runId) || context.queuedRunIds.has(runId)) {
    return undefined;
  }
  return "running";
}

function assistantRunIndicatorState(
  context: RunIndicatorContext,
  event: ChatEvent,
): ActiveRunIndicatorState | undefined {
  const runId = event.runId;
  if (isQueueMarkerEvent(event)) {
    return undefined;
  }
  if (isChatRunTerminalEventType(event.eventType)) {
    return null;
  }
  if (runId === undefined) {
    return undefined;
  }
  return runActivityIndicatorState(context, runId);
}

function nonAssistantRunIndicatorState(
  context: RunIndicatorContext,
  event: ChatEvent,
): ActiveRunIndicatorState | undefined {
  if (event.eventType === "input.prompt" && event.runId === undefined) {
    return "pending";
  }
  const { runId } = event;
  return runId === undefined
    ? undefined
    : runActivityIndicatorState(context, runId);
}

function visibleRunStartIndexByRunId(
  events: readonly ChatEvent[],
  revokedEventIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const runStartIndexByRunId = new Map<string, number>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const runId = event.runId;
    if (
      (event.eventType !== "input.prompt" &&
        event.eventType !== "input.rejected") ||
      runId === undefined ||
      runStartIndexByRunId.has(runId) ||
      revokedEventIds.has(event.id)
    ) {
      continue;
    }
    runStartIndexByRunId.set(runId, index);
  }
  return runStartIndexByRunId;
}

function laterStartedRunIndicatorState(
  events: readonly ChatEvent[],
  terminatedRunId: string,
  context: RunIndicatorContext,
  revokedEventIds: ReadonlySet<string>,
  runStartIndexByRunId: ReadonlyMap<string, number>,
): "running" | undefined {
  const terminatedRunStartIndex = runStartIndexByRunId.get(terminatedRunId);
  if (terminatedRunStartIndex === undefined) {
    return undefined;
  }

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const runId = event.runId;
    if (
      runId === undefined ||
      (runStartIndexByRunId.get(runId) ?? -1) <= terminatedRunStartIndex ||
      revokedEventIds.has(event.id) ||
      isUsageEvent(event) ||
      isGoalMarkerEvent(event)
    ) {
      continue;
    }
    const state =
      chatEventCompatibilityRole(event.eventType) === "assistant"
        ? assistantRunIndicatorState(context, event)
        : nonAssistantRunIndicatorState(context, event);
    if (state === "running") {
      return state;
    }
  }
  return undefined;
}

function activeRunIndicatorStateFromChatEvents(
  events: readonly ChatEvent[],
  revokedEventIds: ReadonlySet<string>,
  context: RunIndicatorContext,
): ActiveRunIndicatorState {
  const runStartIndexByRunId = visibleRunStartIndexByRunId(
    events,
    revokedEventIds,
  );
  let newerPendingState: "pending" | null = null;

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isUsageEvent(event) || isGoalMarkerEvent(event)) {
      continue;
    }
    if (chatEventCompatibilityRole(event.eventType) === "assistant") {
      const state = assistantRunIndicatorState(context, event);
      if (state === null && event.runId !== undefined) {
        const laterRunState = laterStartedRunIndicatorState(
          events,
          event.runId,
          context,
          revokedEventIds,
          runStartIndexByRunId,
        );
        if (laterRunState !== undefined) {
          return laterRunState;
        }
      }
      if (state === null) {
        return newerPendingState;
      }
      if (state === "running") {
        return state;
      }
      if (
        event.runId === undefined &&
        (event.eventType === "output.message" ||
          event.eventType === "output.error")
      ) {
        return newerPendingState;
      }
      continue;
    }
    const state = nonAssistantRunIndicatorState(context, event);
    if (state === "running") {
      return state;
    }
    if (state === "pending" && newerPendingState === null) {
      newerPendingState = state;
    }
  }
  return newerPendingState;
}

export function deriveRunIndicatorStateFromChatEvents(
  events: readonly ChatEvent[],
): RunIndicatorState {
  const revokedEventIds = revokedChatEventIds(events);
  const terminatedRunIds = terminatedChatRunIds(events);
  const queuedRunIds = new Set(
    [...foldChatRunStates(events)].flatMap(([runId, state]) => {
      return state === "queued" ? [runId] : [];
    }),
  );
  const activeRunState = activeRunIndicatorStateFromChatEvents(
    events,
    revokedEventIds,
    {
      terminatedRunIds,
      queuedRunIds,
    },
  );
  if (activeRunState === "running") {
    return activeRunState;
  }
  return queuedRunIds.size > 0 ? "queued" : activeRunState;
}

export function liveRunIdsFromChatEvents(
  events: readonly ChatEvent[],
): string[] {
  const terminatedRunIds = terminatedChatRunIds(events);
  const revokedEventIds = revokedChatEventIds(events);
  const liveRunIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const event of events) {
    const runId = event.runId;
    if (
      runId !== undefined &&
      !revokedEventIds.has(event.id) &&
      !terminatedRunIds.has(runId) &&
      !isQueueMarkerEvent(event) &&
      !isUsageEvent(event) &&
      !isGoalMarkerEvent(event) &&
      !seenRunIds.has(runId)
    ) {
      liveRunIds.push(runId);
      seenRunIds.add(runId);
    }
  }
  return liveRunIds;
}

export interface ChatRunModelSelection {
  readonly selectedModel: string;
  readonly serviceTier?: ChatThreadServiceTier;
}

export function runningModelSelectionFromChatEvents(
  events: readonly ChatEvent[],
): ChatRunModelSelection | null {
  const runningRunId = liveRunIdsFromChatEvents(events).at(-1);
  if (runningRunId === undefined) {
    return null;
  }

  const revokedEventIds = revokedChatEventIds(events);
  for (const event of events) {
    if (
      event.eventType !== "input.prompt" ||
      event.runId !== runningRunId ||
      revokedEventIds.has(event.id)
    ) {
      continue;
    }
    const model = event.userMessage.parts.find((part) => {
      return part.type === "model";
    });
    if (model?.type === "model") {
      return {
        selectedModel: model.selectedModel,
        ...(model.serviceTier === undefined
          ? {}
          : { serviceTier: model.serviceTier }),
      };
    }
  }
  return null;
}
