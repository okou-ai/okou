import type { ChatEventRow } from "./chat-event-rows";
import { chatEventSchema, type ChatEvent } from "./chat-threads";
import { visibleChatEventRowContent } from "./retired-goal-archive";

function requiredRowField<T>(
  value: T | null,
  eventType: string,
  field: string,
): T {
  if (value === null) {
    throw new Error(`${eventType} chat event is missing ${field}`);
  }
  return value;
}

/**
 * Projects one canonical row into the public ChatEvent response shape. This
 * projection must stay field-for-field equivalent to the API's own row
 * projection, and the contract test suite pins every supported event type. A
 * control.interrupt target is emitted as interruptsRunId, never as run
 * ownership.
 */
export function chatEventFromRow(row: ChatEventRow): ChatEvent {
  const payload = row.payload;
  const visibleContent = visibleChatEventRowContent(row);
  const base = {
    id: row.id,
    threadId: row.chatThreadId,
    content: visibleContent,
    runId:
      row.eventType === "control.interrupt"
        ? undefined
        : (row.runId ?? undefined),
    runEventId: row.runEventId ?? undefined,
    revokesEventId: row.revokesEventId ?? undefined,
    seqId: row.seqId,
    sequenceNumber: row.runEventSequenceNumber,
    createdAt: row.createdAt,
  };
  const reducedBase = {
    id: row.id,
    threadId: row.chatThreadId,
    seqId: row.seqId,
    createdAt: row.createdAt,
  };

  const candidates: Record<ChatEventRow["eventType"], () => unknown> = {
    "input.prompt": () => {
      return {
        ...base,
        eventType: "input.prompt",
        content: null,
        userMessage: requiredRowField(
          payload?.userMessage ?? null,
          row.eventType,
          "userMessage",
        ),
      };
    },
    "input.automation": () => {
      return {
        ...base,
        eventType: "input.automation",
        content: null,
        userMessage: payload?.userMessage ?? undefined,
      };
    },
    "input.goal": () => {
      return {
        ...reducedBase,
        eventType: "input.goal",
        content: null,
        userMessage: requiredRowField(
          payload?.userMessage ?? null,
          row.eventType,
          "userMessage",
        ),
      };
    },
    "input.budget": () => {
      return {
        ...base,
        eventType: "input.budget",
        content: null,
        userMessage: requiredRowField(
          payload?.userMessage ?? null,
          row.eventType,
          "userMessage",
        ),
      };
    },
    "input.rejected": () => {
      return {
        ...base,
        eventType: "input.rejected",
        content: null,
        userMessage: requiredRowField(
          payload?.userMessage ?? null,
          row.eventType,
          "userMessage",
        ),
        error: requiredRowField(payload?.error ?? null, row.eventType, "error"),
      };
    },
    "output.message": () => {
      return {
        ...base,
        eventType: "output.message",
        content: requiredRowField(visibleContent, row.eventType, "content"),
      };
    },
    "output.error": () => {
      return {
        ...base,
        eventType: "output.error",
        error: requiredRowField(payload?.error ?? null, row.eventType, "error"),
      };
    },
    "output.thinking": () => {
      return {
        ...base,
        eventType: "output.thinking",
        content: null,
        thinking: requiredRowField(
          payload?.thinking ?? null,
          row.eventType,
          "thinking",
        ),
      };
    },
    "output.followups": () => {
      return {
        ...base,
        eventType: "output.followups",
        content: requiredRowField(visibleContent, row.eventType, "content"),
      };
    },
    "run.queued": () => {
      return {
        ...base,
        eventType: "run.queued",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        content: requiredRowField(
          payload?.content ?? null,
          row.eventType,
          "content",
        ),
      };
    },
    "run.dequeued": () => {
      return {
        ...base,
        eventType: "run.dequeued",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        content: null,
        revokesEventId: requiredRowField(
          row.revokesEventId,
          row.eventType,
          "revokesEventId",
        ),
      };
    },
    "run.completed": () => {
      return {
        ...base,
        eventType: "run.completed",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        runLifecycleEvent: "completed",
      };
    },
    "run.failed": () => {
      return {
        ...base,
        eventType: "run.failed",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        error: payload?.error ?? undefined,
        ...(row.failureReason === undefined
          ? {}
          : { failureReason: row.failureReason }),
        runLifecycleEvent: "failed",
      };
    },
    "run.cancelled": () => {
      return {
        ...base,
        eventType: "run.cancelled",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        error: payload?.error ?? undefined,
        runLifecycleEvent: "cancelled",
      };
    },
    "control.interrupt": () => {
      return {
        ...base,
        eventType: "control.interrupt",
        content: null,
        interruptsRunId: requiredRowField(
          row.runId,
          row.eventType,
          "interruptsRunId",
        ),
      };
    },
    "control.revoke": () => {
      return {
        ...base,
        eventType: "control.revoke",
        content: null,
        revokesEventId: requiredRowField(
          row.revokesEventId,
          row.eventType,
          "revokesEventId",
        ),
      };
    },
    "browser.open": () => {
      return { ...base, eventType: "browser.open", content: null };
    },
    "browser.close": () => {
      return { ...base, eventType: "browser.close", content: null };
    },
    "goal.open": () => {
      return {
        ...reducedBase,
        eventType: "goal.open",
        content: requiredRowField(
          payload?.content ?? null,
          row.eventType,
          "content",
        ),
      };
    },
    "goal.close": () => {
      return { ...reducedBase, eventType: "goal.close", content: null };
    },
    "usage.recorded": () => {
      return {
        ...base,
        eventType: "usage.recorded",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        content: null,
        usage: requiredRowField(payload?.usage ?? null, row.eventType, "usage"),
      };
    },
  };

  return chatEventSchema.parse(candidates[row.eventType]());
}
