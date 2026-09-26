import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";

type UsageEventCompactionLockDb = Pick<Db, "execute">;

const scopedUsageEventCompactionLock = singleton(() => {
  return new AsyncLocalStorage<string | undefined>();
});

/** Keep owned test scenarios independent while retaining real lock contention. */
export async function withUsageEventCompactionLockScopeForTest<T>(
  scope: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedUsageEventCompactionLock().run(scope, work);
}

const scopedUsageEventCompactionLockAttempt = singleton(() => {
  return new AsyncLocalStorage<() => Promise<void> | void>();
});

export async function withUsageEventCompactionLockAttemptTrackingForTest<T>(
  onAttempt: () => Promise<void> | void,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedUsageEventCompactionLockAttempt().run(onAttempt, work);
}

export async function lockUsageEventCompaction(
  db: UsageEventCompactionLockDb,
  mode: "shared" | "exclusive" = "exclusive",
): Promise<void> {
  const onAttempt = scopedUsageEventCompactionLockAttempt.peek()?.getStore();
  if (onAttempt) {
    await onAttempt();
  }
  const scope = scopedUsageEventCompactionLock.peek()?.getStore();
  const lockKey =
    scope === undefined
      ? "usage_event_compaction"
      : `usage_event_compaction:test:${scope}`;
  await db.execute(
    mode === "shared"
      ? // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock_shared(
      hashtext('vm0'),
      hashtext(${lockKey})
    )`
      : // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(
      hashtext('vm0'),
      hashtext(${lockKey})
    )`,
  );
}
