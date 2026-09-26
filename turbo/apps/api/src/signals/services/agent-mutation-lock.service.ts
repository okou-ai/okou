import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/**
 * Serialize the seven-public-Agent check, including an initially empty org.
 * Only public creation and requests setting public visibility enter here.
 * Keep this key compatible with deployed writers. The quota needs no locks on
 * sibling Agent rows, whose KEY SHARE readers admit unrelated run content.
 */
export async function lockCanonicalAgentPublicLimit(
  tx: Pick<Tx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(
    // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
    sql`SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent-public-limit:' || ${orgId}::text, 0))`,
  );
}
