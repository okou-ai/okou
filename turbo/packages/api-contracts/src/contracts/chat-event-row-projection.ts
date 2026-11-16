import type { ChatEventRow } from "./chat-event-rows";
import { formatRunFailureForExternalSurface } from "./errors";
import { normalizeRunFailureReason } from "./run-failure-reasons";
import type { ChatEventType } from "./chat-events";
import type {
  ChatEvent,
  ChatEventUsagePayload,
  UserMessageDocument,
} from "./chat-threads";

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

/** Generate terminal presentation without mutating a retained archive row. */
export function projectRunFailureRow(row: ChatEventRow): ChatEventRow {
  if (row.eventType === "run.failed") {
    const failureReason = normalizeRunFailureReason(row.failureReason);
    const message = formatRunFailureForExternalSurface({ failureReason });
    return {
      ...row,
      failureReason,
      payload: {
        ...row.payload,
        content: message,
        error: message,
      },
    };
  }
  if (row.eventType === "run.cancelled") {
    return {
      ...row,
      failureReason: undefined,
      payload: {
        ...row.payload,
        content: "Run cancelled",
        error: "Run cancelled",
      },
    };
  }
  return row;
}

/**
 * Project a decoded row into the public ChatEvent shape. Message documents stay
 * intact; Run terminal copy comes from structured facts. Writers validate the
 * documents, and snapshot publication checks this projection with chatEventResponse.
 * A control.interrupt target becomes interruptsRunId, never Run ownership.
 */
export function chatEventFromRow(source: ChatEventRow): ChatEvent {
  const row = projectRunFailureRow(source);
  const payload = row.payload;
  const content = payload?.content ?? null;
  const base = {
    id: row.id,
    threadId: row.chatThreadId,
    content,
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
  const userMessage = (): UserMessageDocument => {
    return requiredRowField(
      payload?.userMessage ?? null,
      row.eventType,
      "userMessage",
    ) as UserMessageDocument;
  };
  const candidates: Record<ChatEventType, () => ChatEvent> = {
    "input.prompt": () => {
      return {
        ...base,
        eventType: "input.prompt",
        content: null,
        userMessage: userMessage(),
      };
    },
    "input.automation": () => {
      return {
        ...base,
        eventType: "input.automation",
        content: null,
        userMessage:
          payload?.userMessage === undefined ? undefined : userMessage(),
      };
    },
    "input.budget": () => {
      return {
        ...base,
        eventType: "input.budget",
        content: null,
        userMessage: userMessage(),
      };
    },
    "input.rejected": () => {
      return {
        ...base,
        eventType: "input.rejected",
        content: null,
        userMessage: userMessage(),
        error: requiredRowField(payload?.error ?? null, row.eventType, "error"),
      };
    },
    "output.message": () => {
      return {
        ...base,
        eventType: "output.message",
        content: requiredRowField(content, row.eventType, "content"),
      };
    },
    "output.error": () => {
      return {
        ...base,
        eventType: "output.error",
        error: requiredRowField(payload?.error ?? null, row.eventType, "error"),
      };
    },
    "output.followups": () => {
      return {
        ...base,
        eventType: "output.followups",
        content: requiredRowField(content, row.eventType, "content"),
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
    "usage.recorded": () => {
      return {
        ...base,
        eventType: "usage.recorded",
        runId: requiredRowField(row.runId, row.eventType, "runId"),
        content: null,
        usage: requiredRowField(
          payload?.usage ?? null,
          row.eventType,
          "usage",
        ) as ChatEventUsagePayload,
      };
    },
  };

  return candidates[row.eventType]();
}
