import { and, eq, exists, gte, isNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatEvents,
  chatEventTerminalPredicate,
} from "@okouai/db/schema/chat-event";

/** Exact, user-owned unread reminders, independent of the sidebar's display limits. */
export function unreadIosNotificationThreadCondition(
  userId: string,
  badgeClearedAt: Date | null = null,
) {
  const unreadTerminal = new QueryBuilder()
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreads.id),
        chatEventTerminalPredicate(chatEvents.eventType),
        badgeClearedAt === null
          ? undefined
          : gte(
              chatEvents.createdAt,
              sql`date_trunc('milliseconds', ${badgeClearedAt.toISOString()}::timestamp) + interval '1 millisecond'`,
            ),
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
    eq(chatThreads.hidden, false),
    eq(chatThreads.muted, false),
    eq(chatThreads.archived, false),
    exists(unreadTerminal),
  );
}
