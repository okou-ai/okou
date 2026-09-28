import { createStore } from "ccstate";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { env } from "../../lib/env";
import type { Db } from "../external/db";
import { readCurrentChatEventHistoryAtSnapshot } from "./chat-event-history.service";
import { READABLE_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSIONS } from "./chat-event-snapshot-upgrade.service";

/** Resolve archived provenance after a hot-row lookup.
 * Undefined means no archive read was needed, not a resolved empty history.
 */
export async function runEventHistory(
  db: Pick<Db, "select">,
  threadId: string,
  runId: string,
  signal: AbortSignal,
): Promise<readonly ChatEventRow[] | undefined> {
  const head = async () => {
    const [row] = await db
      .select({
        objectKey: chatEventSnapshots.objectKey,
        lastSeqId: chatEventSnapshots.lastSeqId,
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
      // Chat Event V8 transition (removed in PR-3): the same head that
      // readCurrentChatEventHistoryAtSnapshot reads, preferring V8.
      .orderBy(desc(chatEventSnapshots.archiveSchemaVersion))
      .limit(1);
    signal.throwIfAborted();
    return row;
  };
  // A usage writer holds its existing per-run advisory lock in READ COMMITTED.
  // Validate the immutable snapshot pointer across the read so concurrent
  // snapshot publication + hot retention cannot erase provenance between queries.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await head();
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
    // Only the launch transaction writes this identity (before inserting the
    // run). A later input/output cannot prove absence from an older archive.
    // Older runs without this witness still require canonical history. Use the
    // physical watermark, never the logical cursor or publication timestamp.
    const events =
      initialClaim !== undefined && initialClaim.seqId > before.lastSeqId
        ? undefined
        : await createStore().get(
            readCurrentChatEventHistoryAtSnapshot(
              { db, bucket: env("R2_USER_STORAGES_BUCKET_NAME") },
              threadId,
              signal,
            ),
          );
    const after = await head();
    if (
      before?.objectKey === after?.objectKey &&
      before?.lastSeqId === after?.lastSeqId
    ) {
      return events;
    }
  }
  throw new Error("Chat event history changed during provenance read");
}
