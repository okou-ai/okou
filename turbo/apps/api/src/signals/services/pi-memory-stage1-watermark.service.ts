import { and, eq, lt } from "drizzle-orm";
import { piMemoryStage1Watermarks } from "@okouai/db/schema/pi-memory-stage1-schedule";

export function piMemoryStage1WatermarkPlan(
  source: typeof piMemoryStage1Watermarks.$inferInsert,
) {
  return {
    values: source,
    conflict: {
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
    },
  };
}
