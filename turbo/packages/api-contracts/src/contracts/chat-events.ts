import { z } from "zod";

/** Row-level event catalog for chat event schema V8. */
export const CHAT_EVENT_TYPES = [
  "input.prompt",
  "input.automation",
  "input.budget",
  "input.rejected",
  "output.message",
  "output.error",
  "output.followups",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "control.interrupt",
  "control.revoke",
  "usage.recorded",
] as const;

/** Chat event context types stored in the chat_events.context_type column. */
export const CHAT_EVENT_CONTEXT_TYPES = [
  "web",
  "slack",
  "discord",
  "feishu",
  "teams",
  "telegram",
  "agentphone",
  "automation",
  "agent_run",
] as const;

export const chatEventContextTypeSchema = z.enum(CHAT_EVENT_CONTEXT_TYPES);

export type ChatEventContextType = z.infer<typeof chatEventContextTypeSchema>;

export const chatEventTypeSchema = z.enum(CHAT_EVENT_TYPES);

export type ChatEventType = z.infer<typeof chatEventTypeSchema>;
export type ChatEventCompatibilityRole = "user" | "assistant";
export type ChatEventRunLifecycle = "completed" | "failed" | "cancelled";
export type ChatRunFoldState = ChatEventRunLifecycle;

export const CHAT_EVENT_USER_MESSAGE_TEXT_TYPES = [
  "input.prompt",
  "input.rejected",
] as const satisfies readonly ChatEventType[];

export const CHAT_EVENT_CONTENT_TEXT_TYPES = [
  "output.message",
  "output.error",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly ChatEventType[];

const VALID_CHAT_EVENT_REVOCATION_TARGETS = {
  "input.prompt": ["input.prompt", "input.automation", "output.followups"],
  "input.automation": [],
  "input.budget": ["input.budget"],
  "input.rejected": ["input.prompt", "input.automation", "output.followups"],
  "output.message": [],
  "output.error": [],
  "output.followups": [],
  "run.completed": [],
  "run.failed": [],
  "run.cancelled": [],
  "control.interrupt": [],
  "control.revoke": [
    "input.prompt",
    "input.automation",
    "input.budget",
    "input.rejected",
  ],
  "usage.recorded": ["usage.recorded"],
} satisfies Record<ChatEventType, readonly ChatEventType[]>;

const CHAT_RUN_FOLD_STATES = {
  "input.prompt": null,
  "input.automation": null,
  "input.budget": null,
  "input.rejected": null,
  "output.message": null,
  "output.error": null,
  "output.followups": null,
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "control.interrupt": null,
  "control.revoke": null,
  "usage.recorded": null,
} satisfies Record<ChatEventType, ChatRunFoldState | null>;

interface ChatEventFoldInput {
  readonly id?: string;
  readonly eventType: ChatEventType;
  readonly runId?: string | null;
  readonly interruptsRunId?: string;
  readonly revokesEventId?: string | null;
}

export interface ChatQueueFoldInput extends ChatEventFoldInput {
  readonly id: string;
  readonly createdAt: string;
}

interface ChatUsageFoldInput extends ChatEventFoldInput {
  readonly usage?: {
    readonly settledAt: string;
  };
}

const CHAT_EVENT_COMPATIBILITY_ROLES = {
  "input.prompt": "user",
  "input.automation": "user",
  "input.budget": "user",
  "input.rejected": "user",
  "output.message": "assistant",
  "output.error": "assistant",
  "output.followups": "assistant",
  "run.completed": "assistant",
  "run.failed": "assistant",
  "run.cancelled": "assistant",
  "control.interrupt": "user",
  "control.revoke": "user",
  "usage.recorded": "assistant",
} satisfies Record<ChatEventType, ChatEventCompatibilityRole>;

export function chatEventCompatibilityRole(
  eventType: ChatEventType,
): ChatEventCompatibilityRole {
  return CHAT_EVENT_COMPATIBILITY_ROLES[eventType];
}

export function isChatRunTerminalEventType(
  eventType: ChatEventType,
): eventType is "run.completed" | "run.failed" | "run.cancelled" {
  return (
    eventType === "run.completed" ||
    eventType === "run.failed" ||
    eventType === "run.cancelled"
  );
}

export function isChatInputEventType(
  eventType: ChatEventType,
): eventType is
  | "input.prompt"
  | "input.automation"
  | "input.budget"
  | "input.rejected" {
  return (
    eventType === "input.prompt" ||
    eventType === "input.automation" ||
    eventType === "input.budget" ||
    eventType === "input.rejected"
  );
}

export function isChatUserMessageEventType(
  eventType: ChatEventType,
): eventType is "input.prompt" | "input.budget" | "input.rejected" {
  return (
    eventType === "input.prompt" ||
    eventType === "input.budget" ||
    eventType === "input.rejected"
  );
}

export function isChatOutputEventType(
  eventType: ChatEventType,
): eventType is "output.message" | "output.error" | "output.followups" {
  return eventType.startsWith("output.");
}

export function isChatEventUserMessageTextType(
  eventType: ChatEventType,
): eventType is (typeof CHAT_EVENT_USER_MESSAGE_TEXT_TYPES)[number] {
  return (
    CHAT_EVENT_USER_MESSAGE_TEXT_TYPES as readonly ChatEventType[]
  ).includes(eventType);
}

export function isChatEventContentTextType(
  eventType: ChatEventType,
): eventType is (typeof CHAT_EVENT_CONTENT_TEXT_TYPES)[number] {
  return (CHAT_EVENT_CONTENT_TEXT_TYPES as readonly ChatEventType[]).includes(
    eventType,
  );
}

export function isValidChatEventRevocation(
  sourceType: ChatEventType,
  targetType: ChatEventType,
): boolean {
  const targets: readonly ChatEventType[] =
    VALID_CHAT_EVENT_REVOCATION_TARGETS[sourceType];
  return targets.includes(targetType);
}

export function revokedChatEventIds(
  events: readonly ChatEventFoldInput[],
): Set<string> {
  return new Set(
    events.flatMap((event) => {
      return event.revokesEventId === undefined || event.revokesEventId === null
        ? []
        : [event.revokesEventId];
    }),
  );
}

export function terminatedChatRunIds(
  events: readonly ChatEventFoldInput[],
): Set<string> {
  const runIds = new Set<string>();
  for (const event of events) {
    if (event.eventType === "control.interrupt") {
      if (event.interruptsRunId !== undefined) {
        runIds.add(event.interruptsRunId);
      }
      continue;
    }
    if (
      event.runId !== undefined &&
      event.runId !== null &&
      isChatRunTerminalEventType(event.eventType)
    ) {
      runIds.add(event.runId);
    }
  }
  return runIds;
}

export function foldChatRunStates(
  events: readonly ChatEventFoldInput[],
): Map<string, ChatRunFoldState> {
  const states = new Map<string, ChatRunFoldState>();
  for (const event of events) {
    if (event.runId === undefined || event.runId === null) {
      continue;
    }
    const state = CHAT_RUN_FOLD_STATES[event.eventType];
    if (state !== null) {
      states.set(event.runId, state);
    }
  }
  return states;
}

export function isPendingChatQueueEvent(
  event: ChatQueueFoldInput,
  revokedEventIds: ReadonlySet<string>,
): boolean {
  return (
    (event.eventType === "input.prompt" ||
      event.eventType === "input.automation") &&
    (event.runId === undefined || event.runId === null) &&
    !revokedEventIds.has(event.id)
  );
}

function compareChatQueueEvents(
  left: ChatQueueFoldInput,
  right: ChatQueueFoldInput,
): number {
  const priority = (eventType: ChatEventType): number => {
    if (eventType === "input.prompt") {
      return 0;
    }
    return 1;
  };
  const leftPriority = priority(left.eventType);
  const rightPriority = priority(right.eventType);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

export function foldPendingChatQueueEvents<TEvent extends ChatQueueFoldInput>(
  events: readonly TEvent[],
): TEvent[] {
  const revokedEventIds = revokedChatEventIds(events);
  return events
    .filter((event) => {
      return isPendingChatQueueEvent(event, revokedEventIds);
    })
    .sort(compareChatQueueEvents);
}

export function foldRunnableChatQueueEvents<TEvent extends ChatQueueFoldInput>(
  events: readonly TEvent[],
): TEvent[] {
  return foldPendingChatQueueEvents(events);
}

export function foldLatestChatUsageByRunId<
  TUsage extends { readonly settledAt: string },
>(
  events: readonly (ChatUsageFoldInput & { readonly usage?: TUsage })[],
): Map<string, TUsage> {
  const usageByRunId = new Map<string, TUsage>();
  for (const event of events) {
    if (
      event.eventType !== "usage.recorded" ||
      event.runId === undefined ||
      event.runId === null ||
      event.usage === undefined
    ) {
      continue;
    }
    const existing = usageByRunId.get(event.runId);
    if (
      existing === undefined ||
      chatUsageSettledAtMs(event.usage) >= chatUsageSettledAtMs(existing)
    ) {
      usageByRunId.set(event.runId, event.usage);
    }
  }
  return usageByRunId;
}

function chatUsageSettledAtMs(usage: { readonly settledAt: string }): number {
  const timestamp = Date.parse(usage.settledAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
