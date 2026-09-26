import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Serializes initial Plan and usage-pack subscription creation per org. */
export async function lockBillingPurchaseOrg(
  tx: Pick<WriteTx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(
    // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing_purchase:${orgId}`}, 0))`,
  );
}
