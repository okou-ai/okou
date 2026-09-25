import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../external/db";
import { activePendingRunPredicate } from "./agent-run-activity.service";

/** Organization Sandbox capacity: running plus still-active pending runs. */
export function sandboxCapacityPredicate(
  db: Pick<Db, "select">,
  orgId: string,
  staleThreshold: Date,
): SQL {
  const active = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            activePendingRunPredicate(staleThreshold),
          ),
        ),
      ),
    );
  return inArray(agentRuns.id, active);
}

type OwnedAgentRunScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string };

/** Match direct runs plus the actual Agent -> Session -> Run deletion cascade. */
export function ownedAgentRunScopePredicate(
  db: Pick<Db, "select">,
  scope: OwnedAgentRunScope,
): SQL {
  const predicate = or(
    scope.kind === "user"
      ? eq(agentRuns.userId, scope.userId)
      : eq(agentRuns.orgId, scope.orgId),
    inArray(
      agentRuns.sessionId,
      db
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .innerJoin(agents, eq(agents.id, agentSessions.agentId))
        .where(
          scope.kind === "user"
            ? eq(agents.owner, scope.userId)
            : eq(agents.orgId, scope.orgId),
        ),
    ),
  );
  return sql`(${predicate})`;
}
