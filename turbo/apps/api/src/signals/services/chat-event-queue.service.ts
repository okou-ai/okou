import { chatEvents } from "@okouai/db/schema/chat-event";
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
} from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { chatEventTypeIn } from "./chat-event-type.service";

type ChatQueueReadDb = Pick<Db, "select">;
type ChatQueueEventContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

const queueEventRevoker = alias(chatEvents, "queue_event_revoker");
const log = logger("ChatEventQueue");

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

interface QueueEventIdentityColumns {
  readonly id: AnyPgColumn;
  readonly eventType: AnyPgColumn;
  readonly runId: AnyPgColumn;
}

function unrevokedQueueEventCondition(
  db: ChatQueueReadDb,
  event: QueueEventIdentityColumns = chatEvents,
) {
  return and(
    notExists(
      db
        .select({ id: queueEventRevoker.id })
        .from(queueEventRevoker)
        .where(eq(queueEventRevoker.revokesEventId, event.id)),
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
            eq(activeInputDeliveryItems.sourceEventId, event.id),
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
  return pendingChatQueueEventConditionFor(db, chatEvents);
}

/** Apply the authoritative pending-queue predicate to a queue-event alias. */
function pendingChatQueueEventConditionFor(
  db: ChatQueueReadDb,
  event: QueueEventIdentityColumns,
) {
  return and(
    inArray(event.eventType, ["input.prompt", "input.automation"]),
    isNull(event.runId),
    unrevokedQueueEventCondition(db, event),
  );
}

const SLOW_PENDING_INPUT_READ_MS = 250;

export interface PendingChatInput {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: "input.prompt" | "input.automation" | "input.budget";
  readonly seqId: number;
  readonly createdAt: Date;
}

/**
 * One thread's pending (run-less, unrevoked) input in sequence order, read in
 * two bounded steps scoped to the thread: its run-less input rows through the
 * (chat_thread_id, seq_id) index, then the revocations of exactly those rows
 * through the revokes_event_id index. The revoked rows are dropped here, so
 * the read needs no transaction, CTE or subquery. `budgetForRunId` adds the
 * budget input that targets that run.
 */
export async function listPendingChatInputs(
  db: ChatQueueReadDb,
  args: {
    readonly chatThreadId: string;
    readonly eventTypes: readonly ("input.prompt" | "input.automation")[];
    readonly budgetForRunId?: string;
  },
): Promise<readonly PendingChatInput[]> {
  const startedAt = performance.now();
  const candidates = await db
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
        eq(chatEvents.chatThreadId, args.chatThreadId),
        isNull(chatEvents.runId),
        or(
          inArray(chatEvents.eventType, [...args.eventTypes]),
          args.budgetForRunId === undefined
            ? undefined
            : and(
                eq(chatEvents.eventType, "input.budget"),
                eq(chatEvents.contextType, "agent_run"),
                eq(chatEvents.contextId, args.budgetForRunId),
              ),
        ),
      ),
    );
  const revoked = await revokedChatEventIds(
    db,
    candidates.map(({ id }) => {
      return id;
    }),
  );
  const durationMs = performance.now() - startedAt;
  if (durationMs >= SLOW_PENDING_INPUT_READ_MS) {
    log.warn("Pending chat input read exceeded 250 ms", {
      chatThreadId: args.chatThreadId,
      scannedRows: candidates.length,
      durationMs,
    });
  }
  return candidates
    .flatMap((event): PendingChatInput[] => {
      if (
        revoked.has(event.id) ||
        (event.eventType !== "input.prompt" &&
          event.eventType !== "input.automation" &&
          event.eventType !== "input.budget")
      ) {
        return [];
      }
      return [{ ...event, eventType: event.eventType }];
    })
    .sort((left, right) => {
      return left.seqId - right.seqId;
    });
}

/**
 * Load one thread's pending queue head. The queue is strict FIFO by the
 * thread's event sequence: user messages and automation events interleave in
 * the order they were appended.
 */
export async function loadChatQueueHead(
  db: ChatQueueReadDb,
  chatThreadId: string,
): Promise<PendingChatQueueEvent | null> {
  const pending = await listPendingChatInputs(db, {
    chatThreadId,
    eventTypes: ["input.prompt", "input.automation"],
  });
  const [head] = pending;
  if (!head || head.eventType === "input.budget") {
    return null;
  }
  return { ...head, eventType: head.eventType };
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
