import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "../external/db";

/** Count occupied compute slots, not queued rows. A started terminal run keeps
 * its slot while its runner is still finishing; its active row is removed only
 * on completion or cleanup. */
export function sandboxCapacityPredicate(staleThreshold: Date): SQL {
  return or(
    eq(agentRuns.status, "running"),
    isNotNull(agentRuns.startedAt),
    and(
      eq(agentRuns.status, "pending"),
      gt(activeAgentRuns.lastHeartbeatAt, staleThreshold),
    ),
  ) as SQL;
}

type InferenceErasureScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string };

/** Match direct runs plus the actual Agent -> Session -> Run deletion cascade. */
export function piInferenceErasureScopePredicate(
  db: Pick<Db, "select">,
  scope: InferenceErasureScope,
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
