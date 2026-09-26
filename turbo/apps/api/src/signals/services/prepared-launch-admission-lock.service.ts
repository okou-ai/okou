import { sql } from "drizzle-orm";
import type { Db } from "../external/db";

/**
 * Final admission for an official workflow run. The org lock is the
 * rollout fence for outgoing admission writers that lock Workflow/Automation
 * rows before the plan row. New admission uses plan-before-Workflow order,
 * matching reconciliation. Retire this key after old writers have drained.
 */
export async function lockPreparedLaunchAdmission(
  db: Pick<Db, "execute">,
  orgId: string,
): Promise<void> {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
}
