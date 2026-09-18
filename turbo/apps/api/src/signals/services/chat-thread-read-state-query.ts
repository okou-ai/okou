import { and, desc, eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import type { chatThreads } from "@okouai/db/schema/chat-thread";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";

import type { Db } from "../external/db";

/**
 * The newest instant that can leave one thread unread, or no row at all.
 *
 * Two independent candidates are combined, deliberately as separate indexed
 * lookups rather than one disjunctive scan of `chat_events`:
 *
 * - the latest Run terminal marker, which still matches the partial index
 *   `idx_chat_events_thread_run_terminal_created` exactly as before; and
 * - the latest native Morning Brief delivery for the thread, read from the
 *   delivery's own `(chat_thread_id, delivered_at desc)` index.
 *
 * A native delivery has no Run, so nothing about it can be inferred from the
 * event stream. Resolving it through the durable delivery row also keeps the
 * marker answerable after the generation result, the outbox intent and even
 * the hot chat event itself are gone. Every other run-less output — the
 * welcome message included — keeps exactly its current classification, because
 * only a committed delivery row contributes a candidate.
 *
 * The outer `limit(1)` preserves the original absence semantics: a thread with
 * neither candidate produces no row, so the lateral joins in the four callers
 * keep excluding it instead of surfacing a NULL watermark.
 *
 * Both references are unconditional and precede any feature activation, so the
 * delivery table has to exist before these readers deploy. That ordering is
 * schema-before-reader, not something a default-off switch can provide.
 */
export function latestReadWatermarkEventSubquery(
  db: Pick<Db, "select">,
  threadId: string | typeof chatThreads.id,
) {
  const runTerminal = db
    .select({ createdAt: chatEvents.createdAt })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .orderBy(sql`${desc(chatEvents.createdAt)} NULLS LAST`, desc(chatEvents.id))
    .limit(1);
  const nativeDelivery = db
    .select({ createdAt: morningBriefDeliveries.deliveredAt })
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.chatThreadId, threadId))
    .orderBy(desc(morningBriefDeliveries.deliveredAt))
    .limit(1);
  const candidates = unionAll(runTerminal, nativeDelivery).as(
    "read_watermark_candidates",
  );
  return db
    .select({ createdAt: candidates.createdAt })
    .from(candidates)
    .orderBy(sql`${desc(candidates.createdAt)} NULLS LAST`)
    .limit(1)
    .as("latest_read_watermark_event");
}
