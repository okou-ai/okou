import { count, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";

const waiterCountSchema = z.object({ waiterCount: z.number() });

// Infrastructure-only observation for the refresh/terminal race. Product state
// is created and asserted through production APIs; no API exposes lock timing.
export async function countWaitingPersonalSubscriptionMutationsFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}): Promise<number> {
  const key = `model_provider_state:${args.orgId}:${args.userId}:${args.type}`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT count(*)::int AS "waiterCount"
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND objid = (hashtext(${key})::bigint & 4294967295)::oid
    `,
    waiterCountSchema,
  );
  if (!rows[0]) {
    throw new Error("Expected the aggregate lock waiter count");
  }
  return rows[0].waiterCount;
}

// Infrastructure-only observation: an old Claude writer ignores the provider
// advisory lock and instead waits for a credential row owned by its holder.
// Count direct waiters of that test-owned holder without inspecting query text
// or product rows; no production API exposes PostgreSQL lock timing.
export async function countBlockedPersonalSubscriptionMutationsFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}): Promise<number> {
  const key = `model_provider_state:${args.orgId}:${args.userId}:${args.type}`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE EXISTS (
        SELECT 1 FROM pg_locks AS holder
        WHERE holder.pid = ANY(pg_blocking_pids(activity.pid))
          AND holder.locktype = 'advisory' AND holder.granted
          AND holder.objsubid = 1
          AND holder.objid = (hashtext(${key})::bigint & 4294967295)::oid
          AND holder.database = (
            SELECT oid FROM pg_database WHERE datname = current_database()
          )
      )
    `,
    waiterCountSchema,
  );
  if (!rows[0]) {
    throw new Error("Expected the aggregate blocked waiter count");
  }
  return rows[0].waiterCount;
}
