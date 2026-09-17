import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";

type UsageEventCompactionLockDb = Pick<Db, "execute">;

const scopedUsageEventCompactionLockAttempt = singleton(() => {
  return new AsyncLocalStorage<() => void>();
});

export async function withUsageEventCompactionLockAttemptTrackingForTest<T>(
  onAttempt: () => void,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedUsageEventCompactionLockAttempt().run(onAttempt, work);
}

export async function lockUsageEventCompaction(
  db: UsageEventCompactionLockDb,
  mode: "shared" | "exclusive" = "exclusive",
): Promise<void> {
  scopedUsageEventCompactionLockAttempt.peek()?.getStore()?.();
  await db.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(
      hashtext('vm0'),
      hashtext('usage_event_compaction')
    )`
      : sql`SELECT pg_advisory_xact_lock(
      hashtext('vm0'),
      hashtext('usage_event_compaction')
    )`,
  );
}
