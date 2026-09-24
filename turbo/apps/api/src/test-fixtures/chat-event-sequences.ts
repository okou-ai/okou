import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { sql } from "drizzle-orm";
import type { ApiDb, Tx } from "../lib/db-types";

/** Historical fixture writers must advance the same allocation watermark. */
export async function reserveFixtureChatEventSequence(
  db: ApiDb | Tx,
  chatThreadId: string,
  count: number,
): Promise<number> {
  const [sequence] = await db
    .insert(chatEventSequences)
    .values({
      chatThreadId,
      lastSeqId: count,
    })
    .onConflictDoUpdate({
      target: chatEventSequences.chatThreadId,
      set: { lastSeqId: sql`${chatEventSequences.lastSeqId} + ${count}` },
    })
    .returning({ seqId: chatEventSequences.lastSeqId });
  if (!sequence) {
    throw new Error("Missing fixture event sequence");
  }
  return sequence.seqId;
}
