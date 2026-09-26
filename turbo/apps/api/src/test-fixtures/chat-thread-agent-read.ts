import { randomUUID } from "node:crypto";

import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, inArray, max } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure exception: a terminal run event is appended by a claimed
 * Runner's completion callback, and driving hundreds of real Runner round trips
 * would replace the concurrency this suite measures with fixture latency. The
 * threads themselves are always created through the production endpoint; this
 * appends exactly the immutable terminal row that makes each of them unread,
 * and it writes nothing else.
 */
export async function appendTerminalChatEventsFixture(args: {
  readonly threadIds: readonly string[];
}): Promise<void> {
  if (args.threadIds.length === 0) {
    return;
  }
  const threadIds = [...args.threadIds];
  const lastSeqIds = await db()
    .select({
      chatThreadId: chatEvents.chatThreadId,
      lastSeqId: max(chatEvents.seqId),
    })
    .from(chatEvents)
    .where(inArray(chatEvents.chatThreadId, threadIds))
    .groupBy(chatEvents.chatThreadId);
  const nextSeqId = new Map(
    lastSeqIds.map((row) => {
      return [row.chatThreadId, (row.lastSeqId ?? 0) + 1];
    }),
  );
  const inserted = await db()
    .insert(chatEvents)
    .values(
      threadIds.map((chatThreadId) => {
        return {
          chatThreadId,
          // Attribution only, and terminal uniqueness is keyed on it.
          runId: randomUUID(),
          eventType: "run.completed" as const,
          seqId: nextSeqId.get(chatThreadId) ?? 1,
        };
      }),
    )
    .returning({ id: chatEvents.id, createdAt: chatEvents.createdAt });
  if (inserted.length !== threadIds.length) {
    throw new Error("Expected one terminal event per seeded chat thread");
  }
  // A finished Run's output also moves the thread's sort time, which is what
  // the unread candidate filter compares with the read cursor.
  const latest = inserted.reduce(
    (newest, row) => {
      return row.createdAt > newest ? row.createdAt : newest;
    },
    inserted[0]?.createdAt ?? new Date(0),
  );
  await db()
    .update(chatThreads)
    .set({ lastMessageAt: latest })
    .where(inArray(chatThreads.id, threadIds));
}

/**
 * Moves seeded threads' sort time into the past. Infrastructure exception: no
 * API sets `last_message_at` to an arbitrary time, and the bulk read cursor's
 * seven-day window can only be exercised with a thread that old.
 */
export async function ageChatThreadsFixture(args: {
  readonly threadIds: readonly string[];
  readonly lastMessageAt: Date;
}): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ lastMessageAt: args.lastMessageAt })
    .where(inArray(chatThreads.id, [...args.threadIds]));
}

/** Every persisted read cursor of one thread set, as a size-independent
 * snapshot a test can compare before and after a denied or failed write. */
export async function readChatThreadCursorsFixture(
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  if (threadIds.length === 0) {
    return new Map();
  }
  const rows = await db()
    .select({ id: chatThreads.id, lastReadAt: chatThreads.lastReadAt })
    .from(chatThreads)
    .where(inArray(chatThreads.id, [...threadIds]));
  return new Map(
    rows.map((row) => {
      return [row.id, row.lastReadAt?.toISOString() ?? null];
    }),
  );
}

/**
 * Complete unread state for the terminal rows seeded by this fixture. The
 * public indicators endpoint intentionally returns only the latest 50 unread
 * threads from seven days and cannot verify a 100+ thread bulk update. This
 * fixture reads only the known test thread ids; the write under test still
 * enters through the production API.
 */
export async function readSeededUnreadThreadIdsFixture(
  threadIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (threadIds.length === 0) {
    return new Set();
  }
  const [cursors, terminalEvents] = await Promise.all([
    readChatThreadCursorsFixture(threadIds),
    db()
      .select({
        threadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          inArray(chatEvents.chatThreadId, [...threadIds]),
          eq(chatEvents.eventType, "run.completed"),
        ),
      ),
  ]);
  const unreadThreadIds = new Set<string>();
  for (const event of terminalEvents) {
    const lastReadAt = cursors.get(event.threadId);
    if (
      lastReadAt !== undefined &&
      (lastReadAt === null ||
        event.createdAt.getTime() > Date.parse(lastReadAt))
    ) {
      unreadThreadIds.add(event.threadId);
    }
  }
  return unreadThreadIds;
}
