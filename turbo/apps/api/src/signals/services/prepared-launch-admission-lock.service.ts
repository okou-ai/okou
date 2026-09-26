import { sql } from "drizzle-orm";
import type { Db } from "../external/db";

/**
 * Final admission for an official workflow run. The org lock is the
 * lock-order fence against official workflow reconciliation, which locks the
 * org plan row before workflow and automation rows under this key, while this
 * admission locks workflow and automation rows before the plan row.
 */
export async function lockPreparedLaunchAdmission(
  db: Pick<Db, "execute">,
  orgId: string,
): Promise<void> {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
}
