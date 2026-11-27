import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  proactiveOccurrences,
  proactiveSchedules,
} from "@okouai/db/schema/proactive-schedule";
import { command } from "ccstate";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { prepareChatEventReplacement } from "./chat-event.service";
import type { ProactiveScheduleOwner } from "./proactive-member-preferences.service";

/** Revocation and Run admission compete on the same unique queue-head replacement. */
export const revokeStaleProactiveInputs$ = command(
  async (
    { set },
    owner: ProactiveScheduleOwner | undefined,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const sources = await db
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        modelSelection: chatEvents.modelSelection,
      })
      .from(proactiveOccurrences)
      .innerJoin(chatEvents, eq(chatEvents.id, proactiveOccurrences.id))
      .leftJoin(
        proactiveSchedules,
        and(
          eq(proactiveSchedules.orgId, proactiveOccurrences.orgId),
          eq(proactiveSchedules.userId, proactiveOccurrences.userId),
          eq(proactiveSchedules.task, proactiveOccurrences.task),
        ),
      )
      .where(
        and(
          isNull(proactiveOccurrences.runId),
          isNull(proactiveOccurrences.settledAt),
          owner
            ? and(
                eq(proactiveOccurrences.orgId, owner.orgId),
                eq(proactiveOccurrences.userId, owner.userId),
              )
            : undefined,
          or(
            sql`${proactiveSchedules.preferenceRevision} IS DISTINCT FROM ${proactiveOccurrences.preferenceRevision}`,
            eq(proactiveSchedules.enabled, false),
            eq(proactiveSchedules.intendedEnabled, false),
            sql`${proactiveSchedules.chatThreadId} IS DISTINCT FROM ${proactiveOccurrences.chatThreadId}`,
          ),
          sql`NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id=${chatEvents.id})`,
        ),
      )
      .limit(100);
    signal.throwIfAborted();
    for (const source of sources) {
      signal.throwIfAborted();
      const event = prepareChatEventReplacement(source, {
        chatThreadId: source.chatThreadId,
        eventType: "control.revoke",
      });
      await db.execute(sql`WITH ${canonicalChatEventAppendCtes([event.row], "any")}
      UPDATE proactive_occurrences SET settled_at=timezone('UTC',now()) WHERE id=${source.id}::uuid AND run_id IS NULL AND EXISTS (SELECT 1 FROM inserted)`);
    }
    signal.throwIfAborted();
  },
);
