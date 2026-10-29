import {
  deleteThreadlessRunHistorySql,
  threadlessRunDeletionOutcomeSchema,
} from "@okouai/db/operations/run-history-deletion";
import { command } from "ccstate";
import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  conversationDeletionDatabaseError,
  logCommittedConversationDeletion,
} from "./conversation-history-deletion.service";

export interface ThreadlessRunCandidate {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly error: string | null;
  readonly completedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

const deleteThreadlessRunRows$ = command(async function deleteIfStillEligible(
  { set },
  candidate: ThreadlessRunCandidate,
  quietBefore: Date,
) {
  const db = set(writeDb$);
  const query = deleteThreadlessRunHistorySql({ ...candidate, quietBefore });
  const rowSchema = threadlessRunDeletionOutcomeSchema;
  const deletion = await settle(
    (async () => {
      return parseRawRows(rowSchema, await db.execute(query));
    })(),
  );
  if (!deletion.ok) {
    throw conversationDeletionDatabaseError(deletion.error);
  }
  const [receipt] = deletion.value;
  if (deletion.value.length !== 1 || !receipt) {
    throw new Error("Expected one threadless Run deletion outcome");
  }
  if (receipt.deletedRuns === 0) {
    return null;
  }
  return {
    deletedRuns: receipt.deletedRuns,
    releasedReferences: receipt.releasedReferences,
    releasedHashes: receipt.releasedReferences,
  };
});

// Keep the original indivisible deletion step free of request cancellation.
// The cron sweep observes abort after its counters through its existing settle.
export const deleteThreadlessRunIfStillEligible$ = command(
  async (
    { set },
    candidate: ThreadlessRunCandidate,
    quietBefore: Date,
  ): Promise<boolean> => {
    const receipt = await set(deleteThreadlessRunRows$, candidate, quietBefore);
    if (receipt === null) {
      return false;
    }
    logCommittedConversationDeletion("threadless", receipt);
    return true;
  },
);
