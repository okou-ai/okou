import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../external/db";

/**
 * Match an organization's direct Runs and Runs attributed to its Agents.
 */
export function organizationAgentRunScopePredicate(
  db: Pick<Db, "select">,
  orgId: string,
): SQL {
  const predicate = or(
    eq(agentRuns.orgId, orgId),
    inArray(
      agentRuns.agentId,
      db.select({ id: agents.id }).from(agents).where(eq(agents.orgId, orgId)),
    ),
  );
  return sql`(${predicate})`;
}
