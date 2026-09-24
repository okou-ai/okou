import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** Final OAuth token admission after provider exchange and KMS preparation.
 * Both builtin and custom callbacks must enter before connector account locks.
 */
export async function assertConnectorTokenWriteOpen(
  tx: Tx,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  await assertErasureSubjectWritable(tx, [
    { subjectKind: "user", subjectId: userId },
  ]);
  // The committed webhook task may predate B1 projection. It is a separate
  // read after shared admission; the B1 exclusive lock then prevents a later
  // capture from missing this transaction's token write.
  const [deletion] = await tx
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.kind, "clerk-user-deletion"),
        eq(backgroundJobs.userId, userId),
      ),
    )
    .limit(1);
  if (deletion) {
    throw new Error("account_erasure:subject_closed");
  }
  signal.throwIfAborted();
}
