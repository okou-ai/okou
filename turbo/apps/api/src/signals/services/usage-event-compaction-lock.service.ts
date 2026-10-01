import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";

type UsageEventCompactionLockDb = Pick<Db, "execute">;

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

export async function lockUsageEventCompaction(
  db: UsageEventCompactionLockDb,
  owner?: {
    readonly orgId: string;
    readonly mode: "shared" | "exclusive";
  },
): Promise<void> {
  const mode = owner?.mode ?? "exclusive";
  const scope = scopedUsageEventCompactionLock.peek()?.getStore();
  const lockKey =
    scope === undefined
      ? "usage_event_compaction"
      : `usage_event_compaction:test:${scope}`;
  // The legacy key and modes are unchanged; only the existing entrance moves
  // to its callable SQL boundary. Keep this await separate and first so a call
  // queued behind PR2's activation barrier resolves the new native body after
  // the barrier commits, rather than entering an old body before it waits.
  await db.execute(
    sql`SELECT acquire_usage_event_legacy(${lockKey}, ${mode === "shared"})`,
  );
  // The entry is deliberately inactive in PR1. PR2 activates it only after
  // this prepared serving/rollback floor and the older request drain pass.
  await db.execute(
    sql`SELECT acquire_usage_event_maintenance(
      ${owner?.orgId ?? null},
      ${mode === "exclusive"}
    )`,
  );
}
