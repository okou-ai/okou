import { usageChatProjectionWork } from "@okouai/db/schema/usage-chat-projection-work";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

const databaseNow = sql`timezone('UTC', clock_timestamp())`;

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

  // A single set-based write per settlement, not a per-event or per-run query.
  // The same DB transaction commits the work revision and the financial ledger.
  const updated = await tx
    .insert(usageChatProjectionWork)
    .values(
      runIds.map((runId) => {
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
  if (updated.length !== runIds.length) {
    throw new Error("A committed run projection obligation was not persisted");
  }
}
