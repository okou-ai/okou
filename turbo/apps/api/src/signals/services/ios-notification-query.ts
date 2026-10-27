import { and, eq, exists, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatEvents,
  chatEventTerminalPredicate,
} from "@okouai/db/schema/chat-event";

/** Exact, user-owned unread conversations, independent of the sidebar's display limits. */
export function unreadIosNotificationThreadCondition(userId: string) {
  const unreadTerminal = new QueryBuilder()
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreads.id),
        chatEventTerminalPredicate(chatEvents.eventType),
        // Read cursors are published through JavaScript Dates, at millisecond precision.
        or(
          isNull(chatThreads.lastReadAt),
          gte(
            chatEvents.createdAt,
            sql`date_trunc('milliseconds', ${chatThreads.lastReadAt}) + interval '1 millisecond'`,
          ),
        ),
      ),
    );
  return and(
    eq(chatThreads.userId, userId),
    isNotNull(chatThreads.agentId),
    eq(chatThreads.hidden, false),
    eq(chatThreads.muted, false),
    exists(unreadTerminal),
  );
}
