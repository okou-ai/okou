import {
  chatEventCompatibilityRole,
  isChatRunTerminalEventType,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "@okouai/api-contracts/contracts/chat-events";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import type { ChatEvent } from "./chat-event-types.ts";

import {
  isUsageEvent,
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

export function lastAssistantCancelledFromGroups(
  groups: SemanticChatGroups,
): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastEvent = lastGroup?.events.at(-1)?.event;
  return lastEvent ? isCancelledRunEvent(lastEvent) : false;
}

// "running" means a run is live or a sent prompt is still optimistic; "queued"
// means the server holds input without a run.
export type RunIndicatorState = "running" | "queued" | null;
type ActiveRunIndicatorState = "running" | null;

interface ChatRunEventContext {
  readonly revokedEventIds: ReadonlySet<string>;
  readonly terminatedRunIds: ReadonlySet<string>;
}

export function chatRunEventContextFromChatEvents(
  events: readonly ChatEvent[],
): ChatRunEventContext {
  return {
    revokedEventIds: revokedChatEventIds(events),
    terminatedRunIds: terminatedChatRunIds(events),
  };
}

function runActivityIndicatorState(
  context: ChatRunEventContext,
  runId: string,
): ActiveRunIndicatorState | undefined {
  if (context.terminatedRunIds.has(runId)) {
    return undefined;
  }
  return "running";
}

function assistantRunIndicatorState(
  context: ChatRunEventContext,
  event: ChatEvent,
): ActiveRunIndicatorState | undefined {
  const runId = event.runId;
  if (isChatRunTerminalEventType(event.eventType)) {
    return null;
  }
  if (runId === undefined) {
    return undefined;
  }
  return runActivityIndicatorState(context, runId);
}

function nonAssistantRunIndicatorState(
  context: ChatRunEventContext,
  event: ChatEvent,
): ActiveRunIndicatorState | undefined {
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
  context: ChatRunEventContext,
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
      isUsageEvent(event)
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
  context: ChatRunEventContext,
): ActiveRunIndicatorState {
  const runStartIndexByRunId = visibleRunStartIndexByRunId(
    events,
    revokedEventIds,
  );
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isUsageEvent(event)) {
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
        return null;
      }
      if (state === "running") {
        return state;
      }
      if (
        event.runId === undefined &&
        (event.eventType === "output.message" ||
          event.eventType === "output.error")
      ) {
        return null;
      }
      continue;
    }
    if (nonAssistantRunIndicatorState(context, event) === "running") {
      return "running";
    }
  }
  return null;
}

export function deriveRunIndicatorStateFromChatEvents(
  events: readonly ChatEvent[],
  context: ChatRunEventContext,
): ActiveRunIndicatorState {
  return activeRunIndicatorStateFromChatEvents(
    events,
    context.revokedEventIds,
    context,
  );
}

function hasRunlessInput(
  events: readonly ChatEvent[],
  revokedEventIds: ReadonlySet<string>,
): boolean {
  return events.some((event) => {
    return (
      isQueuedChatEvent(event) &&
      event.runId === undefined &&
      !revokedEventIds.has(event.id)
    );
  });
}

/**
 * Run state of the thread as the server has persisted it. Pass only persisted
 * events: optimistic input has not reached the server queue yet. Input that no
 * run has consumed while no run is live waits in the server queue.
 */
export function deriveServerRunStateFromChatEvents(
  events: readonly ChatEvent[],
): RunIndicatorState {
  const context = chatRunEventContextFromChatEvents(events);
  const state = deriveRunIndicatorStateFromChatEvents(events, context);
  if (state !== null) {
    return state;
  }
  return hasRunlessInput(events, context.revokedEventIds) ? "queued" : null;
}

export function liveRunIdsFromChatEvents(
  events: readonly ChatEvent[],
  { terminatedRunIds, revokedEventIds }: ChatRunEventContext,
): string[] {
  const liveRunIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const event of events) {
    const runId = event.runId;
    if (
      runId !== undefined &&
      !revokedEventIds.has(event.id) &&
      !terminatedRunIds.has(runId) &&
      !isUsageEvent(event) &&
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

export function modelSelectionForChatRun(
  events: readonly ChatEvent[],
  runningRunId: string | null,
  revokedEventIds: ReadonlySet<string>,
): ChatRunModelSelection | null {
  if (runningRunId === null) {
    return null;
  }

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
