import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** Serialize canonical mutations with the retained Stage 6 legacy bridge. */
export async function lockCanonicalAgentMutation(
  tx: Pick<Tx, "execute">,
  agentId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent:' || ${agentId}::text, 0))`,
  );
}

/**
 * Serialize the seven-public-Agent check, including an initially empty org.
 * Keep this key compatible with deployed writers. The quota needs no locks on
 * sibling Agent rows, whose KEY SHARE readers admit unrelated run content.
 */
export async function lockCanonicalAgentPublicLimit(
  tx: Pick<Tx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent-public-limit:' || ${orgId}::text, 0))`,
  );
}
