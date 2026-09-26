import { usageChatProjectionWork } from "@okouai/db/schema/usage-chat-projection-work";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

const databaseNow = sql`timezone('UTC', clock_timestamp())`;
// Keep each parameterized INSERT well below PostgreSQL's bind-parameter limit.
// All chunks remain inside the caller's single financial transaction.
const MAX_RUNS_PER_WRITE = 1024;

/** Append only an opaque projection obligation to an already locked settlement. */
export async function enqueueSettledRunUsageProjection(
  tx: Tx,
  events: readonly { readonly runId: string | null }[],
): Promise<void> {
  // One run may carry usage charged to more than one owner or organization;
  // the cursor is not a financial attribution record or a chat identity.
  const runIds = [
    ...new Set(
      events.flatMap(({ runId }) => {
        return runId ? [runId] : [];
      }),
    ),
  ].sort((left, right) => {
    return left.localeCompare(right);
  });
  if (runIds.length === 0) {
    return;
  }

  // One set-based write for ordinary settlements; only very large distinct-run
  // sets need extra statements. A failed chunk rolls back every charge and
  // obligation in the same transaction rather than committing partial work.
  for (let offset = 0; offset < runIds.length; offset += MAX_RUNS_PER_WRITE) {
    const chunk = runIds.slice(offset, offset + MAX_RUNS_PER_WRITE);
    const updated = await tx
      .insert(usageChatProjectionWork)
      .values(
        chunk.map((runId) => {
          return {
            runId,
            availableAt: databaseNow,
            updatedAt: databaseNow,
          };
        }),
      )
      .onConflictDoUpdate({
        target: usageChatProjectionWork.runId,
        set: {
          desiredRevision: sql`${usageChatProjectionWork.desiredRevision} + 1`,
          // A settlement racing an active claimant leaves it leased until
          // expiry; the claimant's acknowledgement wakes any newer revision.
          availableAt: sql`CASE WHEN ${usageChatProjectionWork.leaseExpiresAt} > ${databaseNow} THEN ${usageChatProjectionWork.leaseExpiresAt} ELSE ${databaseNow} END`,
          updatedAt: databaseNow,
        },
      })
      .returning({ runId: usageChatProjectionWork.runId });
    if (updated.length !== chunk.length) {
      throw new Error(
        "A committed run projection obligation was not persisted",
      );
    }
  }
}
