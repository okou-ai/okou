import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import { chatEventTypeIn } from "./chat-event-type.service";

type ChatQueueReadDb = Pick<Db, "select">;
type ChatQueueEventContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

const queueEventRevoker = alias(chatEvents, "queue_event_revoker");

export const CHAT_QUEUE_STALE_AFTER_MS = 5 * 60 * 1000;
export const CHAT_QUEUE_STALE_RECHECK_WINDOW_MS = 10 * 60 * 1000;
export const CHAT_QUEUE_SCAN_PAGE_SIZE = 1000;

interface PendingChatQueueEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.automation";
  readonly seqId: number;
  readonly createdAt: Date;
}

export interface ChatQueueEventScanCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ChatQueueEventScanCandidate extends ChatQueueEventScanCursor {
  readonly chatThreadId: string;
  readonly contextType: ChatQueueEventContextType | null;
  readonly contextId: string | null;
}

export interface RecentStaleChatQueueWindow {
  readonly createdAtOrAfter: Date;
  readonly createdBefore: Date;
}

/**
 * Bound best-effort queue repair to events that became stale recently. Each
 * event remains eligible during a ten-minute recheck window after the
 * five-minute grace period, while older event history is intentionally left to
 * normal per-thread admission and callback paths.
 */
export function recentStaleChatQueueWindow(
  currentTime: number,
): RecentStaleChatQueueWindow {
  const createdBefore = new Date(currentTime - CHAT_QUEUE_STALE_AFTER_MS);
  return {
    createdAtOrAfter: new Date(
      createdBefore.getTime() - CHAT_QUEUE_STALE_RECHECK_WINDOW_MS,
    ),
    createdBefore,
  };
}

export async function listChatQueueEventScanCandidatePage(
  db: ChatQueueReadDb,
  args: RecentStaleChatQueueWindow & {
    readonly cursor?: ChatQueueEventScanCursor;
    readonly limit: number;
    readonly eventIds?: readonly string[];
    readonly chatThreadIds?: readonly string[];
    readonly contextTypes?: readonly ChatQueueEventContextType[];
  },
): Promise<readonly ChatQueueEventScanCandidate[]> {
  if (
    args.limit <= 0 ||
    args.eventIds?.length === 0 ||
    args.chatThreadIds?.length === 0 ||
    args.contextTypes?.length === 0
  ) {
    return [];
  }

  return await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        gte(chatEvents.createdAt, args.createdAtOrAfter),
        lt(chatEvents.createdAt, args.createdBefore),
        chatEventTypeIn(["input.prompt", "input.automation"]),
        isNull(chatEvents.runId),
        args.cursor === undefined
          ? undefined
          : or(
              gt(chatEvents.createdAt, args.cursor.createdAt),
              and(
                eq(chatEvents.createdAt, args.cursor.createdAt),
                gt(chatEvents.id, args.cursor.id),
              ),
            ),
        args.eventIds === undefined
          ? undefined
          : inArray(chatEvents.id, [...args.eventIds]),
        args.chatThreadIds === undefined
          ? undefined
          : inArray(chatEvents.chatThreadId, [...args.chatThreadIds]),
        args.contextTypes === undefined
          ? undefined
          : inArray(chatEvents.contextType, [...args.contextTypes]),
      ),
    )
    .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id))
    .limit(Math.min(args.limit, CHAT_QUEUE_SCAN_PAGE_SIZE));
}

export async function revokedChatEventIds(
  db: ChatQueueReadDb,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ eventId: chatEvents.revokesEventId })
    .from(chatEvents)
    .where(inArray(chatEvents.revokesEventId, [...eventIds]));
  return new Set(
    rows.flatMap(({ eventId }) => {
      return eventId === null ? [] : [eventId];
    }),
  );
}

async function openActiveInputDeliveryEventIds(
  db: ChatQueueReadDb,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ eventId: activeInputDeliveryItems.sourceEventId })
    .from(activeInputDeliveryItems)
    .innerJoin(
      activeInputDeliveries,
      eq(activeInputDeliveries.id, activeInputDeliveryItems.deliveryId),
    )
    .where(
      and(
        inArray(activeInputDeliveryItems.sourceEventId, [...eventIds]),
        isNull(activeInputDeliveryItems.disposition),
        eq(activeInputDeliveries.status, "open"),
      ),
    );
  return new Set(
    rows.map(({ eventId }) => {
      return eventId;
    }),
  );
}

function unrevokedQueueEventCondition(db: ChatQueueReadDb) {
  return and(
    notExists(
      db
        .select({ id: queueEventRevoker.id })
        .from(queueEventRevoker)
        .where(eq(queueEventRevoker.revokesEventId, chatEvents.id)),
    ),
    notExists(
      db
        .select({ deliveryId: activeInputDeliveryItems.deliveryId })
        .from(activeInputDeliveryItems)
        .innerJoin(
          activeInputDeliveries,
          eq(activeInputDeliveries.id, activeInputDeliveryItems.deliveryId),
        )
        .where(
          and(
            eq(activeInputDeliveryItems.sourceEventId, chatEvents.id),
            isNull(activeInputDeliveryItems.disposition),
            eq(activeInputDeliveries.status, "open"),
          ),
        ),
    ),
  );
}

function pendingActiveInputPromptCondition(db: ChatQueueReadDb) {
  return and(
    chatEventTypeIn(["input.prompt"]),
    isNull(chatEvents.runId),
    unrevokedQueueEventCondition(db),
  );
}

export function pendingActiveInputCondition(
  db: ChatQueueReadDb,
  runId: string,
) {
  return or(
    pendingActiveInputPromptCondition(db),
    and(
      chatEventTypeIn(["input.budget"]),
      isNull(chatEvents.runId),
      eq(chatEvents.contextType, "agent_run"),
      eq(chatEvents.contextId, runId),
      unrevokedQueueEventCondition(db),
    ),
  );
}

export function pendingChatQueueEventCondition(db: ChatQueueReadDb) {
  return and(
    chatEventTypeIn(["input.prompt", "input.automation"]),
    isNull(chatEvents.runId),
    unrevokedQueueEventCondition(db),
  );
}

export function chatQueueEventPriority(): SQL {
  return sql`CASE ${chatEvents.eventType}
    WHEN 'input.prompt' THEN 0
    WHEN 'input.automation' THEN 1
    ELSE 2
  END`;
}

/**
 * List one thread's pending queue in its authoritative database order. User
 * input keeps absolute priority over automation input. Each
 * class is FIFO by the original event timestamp and id. Keep the sort in
 * PostgreSQL so sub-millisecond timestamp precision matches the final
 * queue-claim queries.
 */
export async function listPendingChatQueueEvents(
  db: ChatQueueReadDb,
  chatThreadId: string,
  createdBefore?: Date,
): Promise<readonly PendingChatQueueEvent[]> {
  const rows = await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      eventType: chatEvents.eventType,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        pendingChatQueueEventCondition(db),
        createdBefore ? lt(chatEvents.createdAt, createdBefore) : undefined,
      ),
    )
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    );

  return rows.flatMap((event) => {
    if (
      event.eventType !== "input.prompt" &&
      event.eventType !== "input.automation"
    ) {
      return [];
    }
    return [
      {
        id: event.id,
        chatThreadId: event.chatThreadId,
        eventType: event.eventType,
        seqId: event.seqId,
        createdAt: event.createdAt,
      },
    ];
  });
}

export async function loadPendingChatQueueEvent(
  db: ChatQueueReadDb,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<PendingChatQueueEvent | null> {
  const [event] = await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      eventType: chatEvents.eventType,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        pendingChatQueueEventCondition(db),
      ),
    )
    .limit(1);
  if (
    !event ||
    (event.eventType !== "input.prompt" &&
      event.eventType !== "input.automation")
  ) {
    return null;
  }
  return { ...event, eventType: event.eventType };
}

/** Shared row lock for every authoritative queue claim or revocation. */
export async function lockChatQueueThread(
  db: ChatQueueReadDb,
  chatThreadId: string,
): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .for("update");
  return thread !== undefined;
}

/** Threads with recently stale runnable queue work for the safety sweep. */
export async function staleChatEventQueueThreadIds(
  db: ChatQueueReadDb,
  args: RecentStaleChatQueueWindow & {
    readonly limit: number;
    readonly chatThreadIds?: readonly string[];
  },
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (args.limit <= 0 || args.chatThreadIds?.length === 0) {
    return [];
  }

  const chatThreadIds = new Set<string>();
  let cursor: ChatQueueEventScanCursor | undefined;
  while (chatThreadIds.size < args.limit) {
    const candidates = await listChatQueueEventScanCandidatePage(db, {
      createdAtOrAfter: args.createdAtOrAfter,
      createdBefore: args.createdBefore,
      cursor,
      limit: CHAT_QUEUE_SCAN_PAGE_SIZE,
      chatThreadIds: args.chatThreadIds,
    });
    signal.throwIfAborted();
    if (candidates.length === 0) {
      break;
    }

    const eventIds = candidates.map(({ id }) => {
      return id;
    });
    const [revokedEventIds, activeDeliveryEventIds] = await Promise.all([
      revokedChatEventIds(db, eventIds),
      openActiveInputDeliveryEventIds(db, eventIds),
    ]);
    signal.throwIfAborted();
    for (const candidate of candidates) {
      if (
        !revokedEventIds.has(candidate.id) &&
        !activeDeliveryEventIds.has(candidate.id)
      ) {
        chatThreadIds.add(candidate.chatThreadId);
        if (chatThreadIds.size === args.limit) {
          break;
        }
      }
    }

    if (candidates.length < CHAT_QUEUE_SCAN_PAGE_SIZE) {
      break;
    }
    const lastCandidate = candidates.at(-1);
    if (!lastCandidate) {
      break;
    }
    cursor = lastCandidate;
  }
  return [...chatThreadIds];
}
