import type { ChatEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatEventRunlessInputPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  notExists,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { ChildAutonomyBudget } from "./autonomy-budget.service";

export type QueuedUserMessageContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;
export type QueuedUserMessageTriggerSource =
  | "web"
  | "agent"
  | "slack"
  | "discord"
  | "wechat"
  | "feishu"
  | "lark"
  | "teams"
  | "telegram"
  | "email"
  | "agentphone";

export function isWebChatContextType(
  contextType: QueuedUserMessageContextType,
): contextType is Extract<QueuedUserMessageContextType, "web" | "agent_run"> {
  return contextType === "web" || contextType === "agent_run";
}

export interface QueuedUserMessage {
  readonly id: string;
  readonly contextType: Exclude<QueuedUserMessageContextType, "automation">;
  readonly autonomyBudget:
    | ChildAutonomyBudget
    | { readonly kind: "unavailable"; readonly message: string };
}

const queuedChatEvent = alias(chatEvents, "queued_chat_event");
const queuedChatEventRevoker = alias(chatEvents, "queued_chat_event_revoker");

export function queuedThreadInputCondition(threadId: string) {
  return and(
    eq(chatEvents.chatThreadId, threadId),
    chatEventRunlessInputPredicate(chatEvents.runId, chatEvents.eventType),
    inArray(chatEvents.eventType, ["input.prompt", "input.automation"]),
    notExists(
      new QueryBuilder()
        .select({ id: queuedChatEventRevoker.id })
        .from(queuedChatEventRevoker)
        .where(eq(queuedChatEventRevoker.revokesEventId, chatEvents.id)),
    ),
  );
}

/** Whether the outer ChatEvent row is an unclaimed, unrevoked prompt. */
export function queuedUserMessageExists(): SQL {
  return exists(
    new QueryBuilder()
      .select({ id: queuedChatEvent.id })
      .from(queuedChatEvent)
      .where(
        and(
          eq(queuedChatEvent.id, chatEvents.id),
          eq(queuedChatEvent.eventType, "input.prompt" satisfies ChatEventType),
          isNull(queuedChatEvent.runId),
          notExists(
            new QueryBuilder()
              .select({ id: queuedChatEventRevoker.id })
              .from(queuedChatEventRevoker)
              .where(
                eq(queuedChatEventRevoker.revokesEventId, queuedChatEvent.id),
              ),
          ),
        ),
      ),
  );
}
