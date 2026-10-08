import type { ChatEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { and, eq, exists, isNull, notExists, type SQL } from "drizzle-orm";
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
  | "feishu"
  | "lark"
  | "teams"
  | "telegram"
  | "agentphone"
  | "automation-schedule";

function unreachableQueuedContextType(contextType: never): never {
  throw new Error(`Unsupported queued context type: ${String(contextType)}`);
}

export function queuedUserMessageTriggerSource(
  contextType: Exclude<QueuedUserMessageContextType, "feishu">,
): QueuedUserMessageTriggerSource {
  switch (contextType) {
    case "web":
    case "slack":
    case "discord":
    case "teams":
    case "telegram":
    case "agentphone": {
      return contextType;
    }
    case "agent_run": {
      return "agent";
    }
    case "automation": {
      throw new Error(
        `${contextType} context cannot be routed as a queued user message`,
      );
    }
    default: {
      return unreachableQueuedContextType(contextType);
    }
  }
}

export function isWebChatContextType(
  contextType: QueuedUserMessageContextType,
): contextType is Extract<QueuedUserMessageContextType, "web" | "agent_run"> {
  return contextType === "web" || contextType === "agent_run";
}

export interface QueuedUserMessage {
  readonly id: string;
  readonly createdAt: Date;
  readonly userMessage: ChatEventUserMessage;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly selectedModel: string | null;
  readonly contextType: QueuedUserMessageContextType;
  readonly contextId: string | null;
  readonly autonomyBudget:
    | ChildAutonomyBudget
    | { readonly kind: "unavailable"; readonly message: string };
}

/** Captured candidate identity; the launch owner revalidates the FIFO head. */
export interface QueueFirstRunAssociation {
  readonly threadId: string;
  readonly eventId: string;
}
export type QueueFirstRunClaimResult =
  | { readonly kind: "claimed"; readonly createdAt: Date }
  | { readonly kind: "lost" };

const queuedChatEvent = alias(chatEvents, "queued_chat_event");
const queuedChatEventRevoker = alias(chatEvents, "queued_chat_event_revoker");

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
