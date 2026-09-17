import { lockErasureSubjects } from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { removeAgentInstructionsStorageInTransaction } from "./agent-instructions-storage-transaction.service";
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";
import {
  deleteLockedRuns,
  deleteRunConversations,
  logCommittedConversationDeletion,
  releaseDeletedConversationReferences,
} from "./conversation-history-deletion.service";
import {
  deleteOrgUsageData,
  deleteUserUsageData,
} from "./usage-event-cleanup.service";
import { closePiStableContextErasureSubject } from "./pi-stable-context-erasure.service";
import { lockXResourceAdmission } from "./x-resource-usage-lifecycle";

export const AGENT_LIFECYCLE_LOCK_TIMEOUT = "100ms";

type ClerkDeletionScope =
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "user"; readonly userId: string };

export async function deleteAgentStableContextLifecycleData(
  tx: Tx,
  agentId: string,
): Promise<void> {
  await tx
    .delete(piStableContextHeads)
    .where(eq(piStableContextHeads.agentId, agentId));
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.agentId, agentId));
  await tx
    .delete(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  await tx
    .delete(piStableContextGenerations)
    .where(eq(piStableContextGenerations.agentId, agentId));
}

async function deleteStableContextLifecycleData(
  tx: Tx,
  scope: ClerkDeletionScope,
  agentIds: readonly string[],
): Promise<void> {
  if (scope.kind === "organization") {
    // Publication fences deliberately have no Agent FK, so organization
    // erasure also removes any fence left by an interrupted Agent lifecycle.
    await tx
      .delete(piStableContextPublications)
      .where(eq(piStableContextPublications.orgId, scope.orgId));
    await tx
      .delete(piStableContextGenerations)
      .where(eq(piStableContextGenerations.orgId, scope.orgId));
    return;
  }
  // Stable artifacts are bound to the executing user even when the Agent is
  // public or owned by somebody else. Remove heads before their artifacts;
  // owned-Agent deletion separately cascades every other audience.
  await tx
    .delete(piStableContextHeads)
    .where(eq(piStableContextHeads.userId, scope.userId));
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.userId, scope.userId));
  await tx
    .delete(piStableContextPublications)
    .where(eq(piStableContextPublications.subject, scope.userId));
  await tx
    .delete(piStableContextGenerations)
    .where(eq(piStableContextGenerations.subject, scope.userId));
  if (agentIds.length > 0) {
    const ownedAgentCondition = eq(
      piStableContextGenerations.agentId,
      sql`ANY(${sql.param(agentIds)}::uuid[])`,
    );
    await tx
      .delete(piStableContextPublications)
      .where(
        eq(
          piStableContextPublications.agentId,
          sql`ANY(${sql.param(agentIds)}::uuid[])`,
        ),
      );
    await tx.delete(piStableContextGenerations).where(ownedAgentCondition);
  }
}

export async function deleteStableContextLifecycleAfterAuthorityRemoval(
  db: NodePgDatabase,
  scope: ClerkDeletionScope,
): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteStableContextLifecycleData(tx, scope, []);
  });
}

async function deleteScopedUsageData(
  db: NodePgDatabase,
  scope: ClerkDeletionScope,
): Promise<void> {
  if (scope.kind === "organization") {
    await deleteOrgUsageData(db, scope.orgId);
  } else {
    await deleteUserUsageData(db, scope.userId);
  }
}

export async function deleteClerkAgentLifecycleData(
  db: NodePgDatabase,
  scope: ClerkDeletionScope,
): Promise<void> {
  const resourceBillingEnabled =
    env("X_RESOURCE_BILLING_START_DATE") !== undefined;
  if (!resourceBillingEnabled) {
    // Keep the existing separately committed cleanup during the API rollout.
    // Activation requires settlers and ordinary Run deleters to share admission.
    await deleteScopedUsageData(db, scope);
  }
  const receipt = await db.transaction(async (tx) => {
    if (resourceBillingEnabled) {
      // Drain compute admission before retaining entitlement locks: creators
      // and queue promotion hold Agent locks before accessing allowances.
      await lockErasureSubjects(tx, [
        {
          subjectKind: scope.kind,
          subjectId: scope.kind === "organization" ? scope.orgId : scope.userId,
        },
      ]);
      // Subjects -> X admission -> compaction -> ledger/entitlements -> parents/Run.
      // The helper uses a savepoint on this same connection; both deletion
      // stages commit atomically and retain their locks through that commit.
      await lockXResourceAdmission(tx, "exclusive");
      await deleteScopedUsageData(tx, scope);
    }
    await closePiStableContextErasureSubject(tx, {
      subjectKind: scope.kind,
      subjectId: scope.kind === "organization" ? scope.orgId : scope.userId,
    });
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
    await deleteStableContextLifecycleData(tx, scope, agentIds);
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
