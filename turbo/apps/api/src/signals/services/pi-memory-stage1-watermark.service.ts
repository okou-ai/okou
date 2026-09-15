import { and, eq, lt } from "drizzle-orm";
import { piMemoryStage1Watermarks } from "@okouai/db/schema/pi-memory-stage1-schedule";
import type { Tx } from "../../lib/db-types";

export async function advancePiMemoryStage1Watermark(
  tx: Tx,
  source: typeof piMemoryStage1Watermarks.$inferInsert,
): Promise<void> {
  await tx
    .insert(piMemoryStage1Watermarks)
    .values(source)
    .onConflictDoUpdate({
      target: [
        piMemoryStage1Watermarks.memoryStorageId,
        piMemoryStage1Watermarks.chatThreadId,
      ],
      set: {
        sourceActivityAt: source.sourceActivityAt,
        sourceHistoryHash: source.sourceHistoryHash,
      },
      setWhere: and(
        eq(piMemoryStage1Watermarks.orgId, source.orgId),
        eq(piMemoryStage1Watermarks.userId, source.userId),
        lt(piMemoryStage1Watermarks.sourceActivityAt, source.sourceActivityAt),
      ),
    });
}
