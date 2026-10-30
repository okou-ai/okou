import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";

const L = logger("ConversationHistoryDeletion");

export function conversationDeletionDatabaseError(error: unknown) {
  return new Error("Conversation history deletion database operation failed", {
    cause: { code: safeSqlStateCode(error) },
  });
}

/** Only call after the owning transaction promise resolves successfully. */
export function logCommittedConversationDeletion(
  source: "agent" | "threadless",
  receipt: {
    readonly deletedRuns: number;
    readonly releasedReferences: number;
    readonly releasedHashes: number;
  },
) {
  if (receipt.deletedRuns > 0 || receipt.releasedReferences > 0) {
    L.debug("Run history deletion committed", { source, ...receipt });
  }
}
