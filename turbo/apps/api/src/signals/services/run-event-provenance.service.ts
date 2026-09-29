import { command } from "ccstate";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { readChatEventSnapshotObject } from "./chat-event-history.service";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";
import { READABLE_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSIONS } from "./chat-event-snapshot-upgrade.service";

function archiveHeadQuery(threadId: string) {
  return new QueryBuilder()
    .select({
      objectKey: chatEventSnapshots.objectKey,
      lastSeqId: chatEventSnapshots.lastSeqId,
      terminalSeqId: chatEventSnapshots.terminalSeqId,
      terminalEventId: chatEventSnapshots.terminalEventId,
      archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, threadId),
        inArray(chatEventSnapshots.archiveSchemaVersion, [
          ...READABLE_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSIONS,
        ]),
      ),
    )
    .orderBy(desc(chatEventSnapshots.archiveSchemaVersion))
    .limit(1)
    .as("run_usage_archive_head");
}

/** Resolve usage provenance from an immutable archive and the latest hot row. */
export const runEventHistory$ = command(
  async (
    { get, set },
    threadId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<readonly ChatEventRow[] | undefined> => {
    const db = set(writeDb$);
    // Preparation owns no SQL transaction. Validate the archive pointer across
    // its object read and hot lookup so retention cannot erase provenance.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [before] = await db.select().from(archiveHeadQuery(threadId));
      signal.throwIfAborted();
      if (before === undefined) {
        return undefined;
      }
      const [initialClaim] = await db
        .select({ seqId: chatEvents.seqId })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.id, runId),
            eq(chatEvents.runId, runId),
            eq(chatEvents.chatThreadId, threadId),
            eq(chatEvents.eventType, "input.prompt"),
            isNotNull(chatEvents.revokesEventId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      // The launch identity proves this run is newer than the archived prefix.
      // The publication command revalidates its captured head before appending.
      if (initialClaim !== undefined && initialClaim.seqId > before.lastSeqId) {
        return undefined;
      }
      if (before.lastSeqId <= 0 || before.objectKey.trim().length === 0) {
        throw new Error("Chat event snapshot head is not reusable");
      }
      const snapshot = await get(
        readChatEventSnapshotObject(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          threadId,
          before,
          signal,
        ),
      );
      signal.throwIfAborted();
      // Only the latest usage record can be the replacement target. Do not
      // paginate the entire thread just to recover this run's provenance.
      const [hot] = await db
        .select()
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.chatThreadId, threadId),
            eq(chatEvents.runId, runId),
            eq(chatEvents.eventType, "usage.recorded"),
          ),
        )
        .orderBy(desc(chatEvents.seqId))
        .limit(1);
      signal.throwIfAborted();
      const [after] = await db.select().from(archiveHeadQuery(threadId));
      signal.throwIfAborted();
      if (
        before.objectKey === after?.objectKey &&
        before.lastSeqId === after?.lastSeqId
      ) {
        const archived = [...snapshot].reverse().find((event) => {
          return event.runId === runId && event.eventType === "usage.recorded";
        });
        const latest =
          hot && (!archived || hot.seqId > archived.seqId)
            ? chatEventRowFromDbRow(hot)
            : archived;
        return latest ? [latest] : [];
      }
    }
    throw new Error("Chat event history changed during provenance read");
  },
);
