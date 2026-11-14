import {
  chatEventCompatibilityRole,
  isChatRunTerminalEventType,
  revokedChatEventIds,
  terminatedChatRunIds,
  type ChatEventType,
} from "./chat-events";

/** The canonical event facts used by both persisted and optimistic run indicators. */
interface ChatRunEvent {
  readonly id: string;
  readonly eventType: ChatEventType;
  readonly runId?: string;
  readonly revokesEventId?: string;
  readonly interruptsRunId?: string;
}

// "running" means a run is live or a sent prompt is still optimistic; "queued"
// means the server holds input without a run.
export type RunIndicatorState = "running" | "queued" | null;
type ActiveRunIndicatorState = "running" | null;

export interface ChatRunEventContext {
  readonly revokedEventIds: ReadonlySet<string>;
  readonly terminatedRunIds: ReadonlySet<string>;
}

export function chatRunEventContextFromChatEvents(
  events: readonly ChatRunEvent[],
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
  event: ChatRunEvent,
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
  event: ChatRunEvent,
): ActiveRunIndicatorState | undefined {
  const { runId } = event;
  return runId === undefined
    ? undefined
    : runActivityIndicatorState(context, runId);
}

function visibleRunStartIndexByRunId(
  events: readonly ChatRunEvent[],
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
  events: readonly ChatRunEvent[],
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
      event.eventType === "usage.recorded"
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
  events: readonly ChatRunEvent[],
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
    if (event.eventType === "usage.recorded") {
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
  events: readonly ChatRunEvent[],
  context: ChatRunEventContext,
): ActiveRunIndicatorState {
  return activeRunIndicatorStateFromChatEvents(
    events,
    context.revokedEventIds,
    context,
  );
}

function hasRunlessInput(
  events: readonly ChatRunEvent[],
  revokedEventIds: ReadonlySet<string>,
): boolean {
  return events.some((event) => {
    return (
      (event.eventType === "input.prompt" ||
        event.eventType === "input.automation") &&
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
  events: readonly ChatRunEvent[],
): RunIndicatorState {
  const context = chatRunEventContextFromChatEvents(events);
  const state = deriveRunIndicatorStateFromChatEvents(events, context);
  if (state !== null) {
    return state;
  }
  return hasRunlessInput(events, context.revokedEventIds) ? "queued" : null;
}
