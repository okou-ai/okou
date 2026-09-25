import {
  chatEventSchema,
  serializeChatFollowupsContent,
  type ChatEvent,
  type ChatRecommendedFollowup,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";

type UnionKeys<T> = T extends unknown ? keyof T : never;
type UnionValue<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

type OptionalUnionFields<T> = {
  [K in UnionKeys<T>]?: UnionValue<T, K>;
};

type UserMessageFilePart = Extract<
  UserMessageDocument["parts"][number],
  { readonly type: "file" }
>;

export type MockChatEventInput = OptionalUnionFields<ChatEvent> & {
  id?: string;
  role?: "user" | "assistant";
  content: string | null;
  createdAt: string;
  fileParts?: readonly UserMessageFilePart[];
  followups?: readonly ChatRecommendedFollowup[];
};

function inferredEventType(
  message: MockChatEventInput,
): ChatEvent["eventType"] {
  if (message.eventType !== undefined) {
    return message.eventType;
  }
  if (message.role === "user") {
    if (message.interruptsRunId !== undefined) {
      return "control.interrupt";
    }
    if (message.revokesEventId !== undefined && message.content === null) {
      return "control.revoke";
    }
    return message.error === undefined ? "input.prompt" : "input.rejected";
  }
  if (message.runLifecycleEvent === "completed") {
    return "run.completed";
  }
  if (message.runLifecycleEvent === "failed") {
    return "run.failed";
  }
  if (message.runLifecycleEvent === "cancelled") {
    return "run.cancelled";
  }
  if (message.runEventId === "queue:queued") {
    return "run.queued";
  }
  if (message.runEventId === "queue:dequeued") {
    return "run.dequeued";
  }
  if (message.usage !== undefined) {
    return "usage.recorded";
  }
  if (message.followups !== undefined) {
    return "output.followups";
  }
  if (message.thinking !== undefined || message.content === null) {
    return "output.thinking";
  }
  return message.error === undefined ? "output.message" : "output.error";
}

function baseEvent(
  message: MockChatEventInput,
  threadId: string,
  id: string,
  content: string | null,
  fallbackSeqId: number,
) {
  return {
    id,
    threadId,
    content,
    runId: message.runId,
    runEventId: message.runEventId,
    revokesEventId: message.revokesEventId,
    seqId: message.seqId ?? fallbackSeqId,
    sequenceNumber: message.sequenceNumber,
    createdAt: message.createdAt,
  };
}

type MockChatEventOverrides = (
  message: MockChatEventInput,
  id: string,
) => Record<string, unknown>;

function requiredMockUserMessage(
  message: MockChatEventInput,
): UserMessageDocument {
  if (message.userMessage !== undefined) {
    return message.userMessage;
  }
  const parts: UserMessageDocument["parts"] = [
    ...(message.fileParts ?? []),
    ...(message.content
      ? [{ type: "text" as const, text: message.content }]
      : []),
  ];
  if (parts.length === 0) {
    throw new Error("Mock user-input events require a userMessage");
  }
  return { version: 1, parts };
}

const mockChatEventOverrides = {
  "input.prompt": (message) => {
    return {
      content: null,
      userMessage: requiredMockUserMessage(message),
    };
  },
  "input.automation": (message, id) => {
    return {
      content: null,
      userMessage:
        message.userMessage ??
        ({
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "mock-workflow",
              automationBrief: `Automation event ${id}`,
            },
          ],
        } satisfies UserMessageDocument),
    };
  },
  "input.goal": (message) => {
    return {
      content: null,
      userMessage:
        message.userMessage ??
        ({
          version: 1,
          parts: [{ type: "goal", goalBrief: "Mock queued goal" }],
        } satisfies UserMessageDocument),
    };
  },
  "input.budget": (message) => {
    return {
      content: null,
      userMessage: requiredMockUserMessage(message),
    };
  },
  "input.rejected": (message) => {
    return {
      content: null,
      error: message.error ?? "Mock input rejected",
      userMessage: requiredMockUserMessage(message),
    };
  },
  "output.message": (message) => {
    return { content: message.content ?? "" };
  },
  "output.error": (message) => {
    return { error: message.error ?? "Mock output error" };
  },
  "output.thinking": (message) => {
    return {
      content: null,
      thinking: message.thinking ?? "",
    };
  },
  "output.followups": (message) => {
    return {
      content:
        message.content ??
        serializeChatFollowupsContent(message.followups ?? []),
    };
  },
  "run.queued": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      content: message.content ?? "Waiting in queue...",
    };
  },
  "run.dequeued": (message, id) => {
    const revokesEventId = message.revokesEventId ?? `mock-queued-${id}`;
    return {
      runId: message.runId ?? `mock-run-${id}`,
      content: null,
      revokesEventId,
    };
  },
  "run.completed": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      runLifecycleEvent: "completed",
    };
  },
  "run.failed": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      error: message.error,
      failureReason: message.failureReason,
      runLifecycleEvent: "failed",
    };
  },
  "run.cancelled": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      error: message.error,
      runLifecycleEvent: "cancelled",
    };
  },
  "control.interrupt": (message, id) => {
    return {
      content: null,
      interruptsRunId: message.interruptsRunId ?? `mock-interrupted-run-${id}`,
    };
  },
  "control.revoke": (message, id) => {
    const revokesEventId = message.revokesEventId ?? `mock-revoked-${id}`;
    return {
      content: null,
      revokesEventId,
    };
  },
  "browser.open": () => {
    return { content: null };
  },
  "browser.close": () => {
    return { content: null };
  },
  "goal.open": (message) => {
    return { content: message.content ?? "Mock active goal" };
  },
  "goal.close": () => {
    return { content: null };
  },
  "usage.recorded": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      content: null,
      usage: message.usage,
    };
  },
} satisfies Record<ChatEvent["eventType"], MockChatEventOverrides>;

function normalizeMockChatEvent(
  message: MockChatEventInput,
  threadId: string,
  fallbackId: string,
  fallbackSeqId = 1,
): ChatEvent {
  const id = message.id ?? fallbackId;
  const eventType = inferredEventType(message);
  return chatEventSchema.parse({
    ...baseEvent(message, threadId, id, message.content, fallbackSeqId),
    eventType,
    ...mockChatEventOverrides[eventType](message, id),
  });
}

export function normalizeMockChatEvents(
  messages: readonly MockChatEventInput[],
  threadId: string,
): ChatEvent[] {
  let nextSeqId = 1;
  return messages.flatMap((message, index) => {
    const fallbackId = `mock-chat-event-${index.toString()}`;
    const seqId = message.seqId ?? nextSeqId;
    nextSeqId = Math.max(nextSeqId, seqId + 1);
    if (message.runLifecycleEvent === "completed" && message.content !== null) {
      const output = normalizeMockChatEvent(
        {
          ...message,
          eventType: "output.message",
          runLifecycleEvent: undefined,
          followups: undefined,
        },
        threadId,
        fallbackId,
        seqId,
      );
      const terminal = normalizeMockChatEvent(
        {
          ...message,
          id: `${output.id}:completed`,
          content: null,
          eventType: "run.completed",
          runLifecycleEvent: "completed",
          followups: undefined,
        },
        threadId,
        `${fallbackId}:completed`,
        seqId + 1,
      );
      nextSeqId = Math.max(nextSeqId, seqId + 2);
      if (message.followups === undefined) {
        return [output, terminal];
      }
      const followups = normalizeMockChatEvent(
        {
          ...message,
          id: `${output.id}:followups`,
          seqId: seqId + 2,
          content: serializeChatFollowupsContent(message.followups),
          error: undefined,
          runLifecycleEvent: undefined,
          eventType: "output.followups",
        },
        threadId,
        `${fallbackId}:followups`,
        seqId + 2,
      );
      nextSeqId = Math.max(nextSeqId, seqId + 3);
      return [output, terminal, followups];
    }
    if (
      message.followups !== undefined &&
      message.runLifecycleEvent !== undefined
    ) {
      const terminal = normalizeMockChatEvent(
        { ...message, followups: undefined },
        threadId,
        fallbackId,
        seqId,
      );
      const followups = normalizeMockChatEvent(
        {
          ...message,
          id: `${terminal.id}:followups`,
          seqId: nextSeqId,
          content: serializeChatFollowupsContent(message.followups),
          error: undefined,
          runLifecycleEvent: undefined,
          eventType: "output.followups",
        },
        threadId,
        `${fallbackId}:followups`,
        nextSeqId,
      );
      nextSeqId += 1;
      return [terminal, followups];
    }
    return [normalizeMockChatEvent(message, threadId, fallbackId, seqId)];
  });
}

const NULL_PAYLOAD_EVENT_TYPES = [
  "run.dequeued",
  "run.completed",
  "control.interrupt",
  "control.revoke",
  "browser.open",
  "browser.close",
  "goal.close",
] as const satisfies readonly ChatEvent["eventType"][];

function mockChatEventRowPayload(event: ChatEvent): ChatEventRow["payload"] {
  if (
    NULL_PAYLOAD_EVENT_TYPES.some((eventType) => {
      return eventType === event.eventType;
    })
  ) {
    return null;
  }
  switch (event.eventType) {
    case "input.prompt":
    case "input.goal":
    case "input.budget": {
      return { userMessage: event.userMessage };
    }
    case "input.automation": {
      return event.userMessage ? { userMessage: event.userMessage } : null;
    }
    case "input.rejected": {
      return { userMessage: event.userMessage, error: event.error };
    }
    case "output.message":
    case "output.followups":
    case "run.queued":
    case "goal.open": {
      return { content: event.content };
    }
    case "output.error": {
      return { error: event.error };
    }
    case "output.thinking": {
      return { thinking: event.thinking };
    }
    case "run.failed":
    case "run.cancelled": {
      return event.error === undefined ? null : { error: event.error };
    }
    case "usage.recorded": {
      return { usage: event.usage };
    }
  }
  return null;
}

export function mockChatEventRows(
  events: readonly ChatEvent[],
): ChatEventRow[] {
  return events.map((event) => {
    return chatEventRowSchema.parse({
      id: event.id,
      chatThreadId: event.threadId,
      runId:
        event.eventType === "control.interrupt"
          ? event.interruptsRunId
          : (event.runId ?? null),
      revokesEventId: event.revokesEventId ?? null,
      eventType: event.eventType,
      payload: mockChatEventRowPayload(event),
      contextType: null,
      contextId: null,
      runEventSequenceNumber: event.sequenceNumber ?? null,
      runEventId: event.runEventId ?? null,
      ...(event.eventType === "run.failed" && event.failureReason !== undefined
        ? { failureReason: event.failureReason }
        : {}),
      seqId: event.seqId,
      createdAt: event.createdAt,
    });
  });
}
