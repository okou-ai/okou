import { sql } from "drizzle-orm";
import type { Db } from "../external/db";

type UsageEventCompactionLockDb = Pick<Db, "execute">;

export async function lockUsageEventCompaction(
  db: UsageEventCompactionLockDb,
  mode: "shared" | "exclusive" = "exclusive",
): Promise<void> {
  await db.execute(
    mode === "shared"
      ? // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock_shared(
      hashtext('vm0'),
      hashtext('usage_event_compaction')
    )`
      : // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(
      hashtext('vm0'),
      hashtext('usage_event_compaction')
    )`,
  );
}
