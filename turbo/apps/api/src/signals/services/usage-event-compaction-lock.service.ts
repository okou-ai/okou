import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";

const scopedUsageEventCompactionLock = singleton(() => {
  return new AsyncLocalStorage<string | undefined>();
});

/** Isolate owned compaction data without changing other tests' admission. */
export async function withUsageEventCompactionLockScopeForTest<T>(
  scope: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedUsageEventCompactionLock().run(scope, work);
}

// DB/API rollout: pre-Release-1 compaction retains ledger rows before Run FK
// parents, and account deletion removes hourly rows before raw rows. Keep this
// barrier until those serving/in-flight/rollback writers are gone. Release 2
// removes it after all supported writers use parent-before-ledger ownership and
// raw-before-hourly deletion; settlement must also use the pending-state CAS.
export function usageEventCompactionLockSql(
  mode: "shared" | "exclusive" = "exclusive",
) {
  const scope = scopedUsageEventCompactionLock.peek()?.getStore();
  const lockKey =
    scope === undefined
      ? "usage_event_compaction"
      : `usage_event_compaction:test:${scope}`;
  return mode === "shared"
    ? // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
      sql`SELECT pg_advisory_xact_lock_shared(
      hashtext('vm0'),
      hashtext(${lockKey})
    )`
    : // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
      sql`SELECT pg_advisory_xact_lock(
      hashtext('vm0'),
      hashtext(${lockKey})
    )`;
}
