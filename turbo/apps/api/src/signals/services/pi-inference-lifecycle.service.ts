import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../external/db";

/**
 * Match an organization's direct runs plus the actual Agent -> Session -> Run
 * deletion cascade of the organization's Agents.
 */
export function organizationAgentRunScopePredicate(
  db: Pick<Db, "select">,
  orgId: string,
): SQL {
  const predicate = or(
    eq(agentRuns.orgId, orgId),
    inArray(
      agentRuns.sessionId,
      db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .innerJoin(agents, eq(agents.id, agentSessions.agentId))
        .where(eq(agents.orgId, orgId)),
    ),
  );
  return sql`(${predicate})`;
}
