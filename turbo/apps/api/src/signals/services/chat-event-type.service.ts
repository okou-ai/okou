import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  eq,
  inArray,
  isNotNull,
  not,
  or,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";

export function chatEventTypeIn(eventTypes: readonly ChatEventType[]): SQL {
  return inArray(chatEvents.eventType, [...eventTypes]);
}

export function chatEventTextCondition(): SQL {
  return or(
    and(
      chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
      isNotNull(canonicalChatEventUserMessage()),
    ),
    and(
      chatEventTypeIn(CHAT_EVENT_CONTENT_TEXT_TYPES),
      isNotNull(canonicalChatEventContent()),
    ),
  ) as SQL;
}

/**
 * Canonical run_id is event-type-sensitive: on control.interrupt it is the
 * target, while every other run-scoped event uses it as ownership.
 */
export function runOwnedChatEventCondition(): SQL {
  return not(chatEventTypeIn(["control.interrupt"]));
}

/** Shared collision-safe run lookup for artifact and thread readers. */
export function runOwnedChatEventForRunCondition(args: {
  readonly runId: string | SQLWrapper;
  readonly chatThreadId?: string;
}): SQL {
  return and(
    eq(chatEvents.runId, args.runId),
    args.chatThreadId === undefined
      ? undefined
      : eq(chatEvents.chatThreadId, args.chatThreadId),
    runOwnedChatEventCondition(),
  ) as SQL;
}
