import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { removeAgentInstructionsStorageInTransaction } from "./agent-instructions-storage-transaction.service";
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";
import {
  deleteLockedRuns,
  deleteRunConversations,
  logCommittedConversationDeletion,
  releaseDeletedConversationReferences,
} from "./conversation-history-deletion.service";

export const AGENT_LIFECYCLE_LOCK_TIMEOUT = "100ms";

export async function deleteClerkAgentLifecycleData(
  db: NodePgDatabase,
  scope:
    | { readonly kind: "organization"; readonly orgId: string }
    | { readonly kind: "user"; readonly userId: string },
): Promise<void> {
  const receipt = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
    const agentScope =
      scope.kind === "organization"
        ? eq(agents.orgId, scope.orgId)
        : eq(agents.owner, scope.userId);
    const candidates = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(agentScope)
      .orderBy(asc(agents.id));
    for (const agent of candidates) {
      await lockCanonicalAgentMutation(tx, agent.id);
    }
    // Revalidate ownership after canonical mutation locks. Lock parents before
    // discovering children so FK inserts cannot escape the accounted cascade.
    const ownedAgents =
      candidates.length === 0
        ? []
        : await tx
            .select({ id: agents.id, name: agents.name, orgId: agents.orgId })
            .from(agents)
            .where(
              and(
                agentScope,
                eq(
                  agents.id,
                  sql`ANY(${sql.param(
                    candidates.map((agent) => {
                      return agent.id;
                    }),
                  )}::uuid[])`,
                ),
              ),
            )
            .orderBy(asc(agents.id))
            .for("update");
    const agentIds = ownedAgents.map((agent) => {
      return agent.id;
    });
    const ownedSessions = tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        eq(agentSessions.agentId, sql`ANY(${sql.param(agentIds)}::uuid[])`),
      );
    await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(inArray(agentSessions.id, ownedSessions))
      .orderBy(asc(agentSessions.id))
      .for("update");
    const directRuns = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        scope.kind === "organization"
          ? eq(agentRuns.orgId, scope.orgId)
          : eq(agentRuns.userId, scope.userId),
      );
    // UNION deduplicates direct ownership and indirect, possibly cross-user,
    // Agent -> Session -> Run cascades while retaining indexed scope lookups.
    const targetRuns = directRuns.union(
      tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(inArray(agentRuns.sessionId, ownedSessions)),
    );
    const runs = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(inArray(agentRuns.id, targetRuns))
      .orderBy(asc(agentRuns.id))
      .for("update");
    const runIds = runs.map((run) => {
      return run.id;
    });
    const removed = await deleteRunConversations(tx, runIds);
    await deleteLockedRuns(tx, runIds);
    if (scope.kind === "user") {
      for (const agent of ownedAgents) {
        await removeAgentInstructionsStorageInTransaction(tx, {
          orgId: agent.orgId,
          agentName: agent.name,
        });
      }
    }
    if (agentIds.length > 0) {
      await tx
        .delete(agents)
        .where(
          and(
            agentScope,
            eq(agents.id, sql`ANY(${sql.param(agentIds)}::uuid[])`),
          ),
        );
    }
    return await releaseDeletedConversationReferences(tx, removed);
  });
  logCommittedConversationDeletion(
    scope.kind === "organization" ? "clerk_organization" : "clerk_user",
    receipt,
  );
}
