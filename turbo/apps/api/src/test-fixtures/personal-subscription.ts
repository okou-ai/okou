import { sql } from "drizzle-orm";
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
