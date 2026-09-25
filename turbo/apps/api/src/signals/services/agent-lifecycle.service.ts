import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Tx } from "../../lib/db-types";
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
import { revokeMorningBriefDeliveryOwnership } from "./morning-brief-delivery.service";

export const AGENT_LIFECYCLE_LOCK_TIMEOUT = "100ms";

type ClerkDeletionScope =
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "user"; readonly userId: string };

async function deleteStableContextGenerations(
  tx: Tx,
  condition: SQL,
): Promise<void> {
  await tx
    .select({
      orgId: piStableContextGenerations.orgId,
      agentId: piStableContextGenerations.agentId,
      subject: piStableContextGenerations.subject,
    })
    .from(piStableContextGenerations)
    .where(condition)
    .orderBy(
      asc(piStableContextGenerations.orgId),
      asc(piStableContextGenerations.agentId),
      asc(piStableContextGenerations.subject),
    )
    .for("update");
  await tx.delete(piStableContextGenerations).where(condition);
}

async function deleteStableContextHeads(tx: Tx, condition: SQL): Promise<void> {
  await tx
    .select({ id: piStableContextHeads.id })
    .from(piStableContextHeads)
    .where(condition)
    .orderBy(asc(piStableContextHeads.id))
    .for("update");
  await tx.delete(piStableContextHeads).where(condition);
}

export async function deleteAgentStableContextLifecycleData(
  tx: Tx,
  agentId: string,
): Promise<void> {
  await deleteStableContextGenerations(
    tx,
    eq(piStableContextGenerations.agentId, agentId),
  );
  await tx
    .delete(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  await deleteStableContextHeads(tx, eq(piStableContextHeads.agentId, agentId));
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.agentId, agentId));
}

export async function deleteClerkStableContextLifecycleData(
  tx: Tx,
  scope: ClerkDeletionScope,
  agentIds: readonly string[],
): Promise<void> {
  if (scope.kind === "organization") {
    // Publication fences deliberately have no Agent FK, so organization
    // deletion also removes any fence left by an interrupted Agent lifecycle.
    await deleteStableContextGenerations(
      tx,
      eq(piStableContextGenerations.orgId, scope.orgId),
    );
    await tx
      .delete(piStableContextPublications)
      .where(eq(piStableContextPublications.orgId, scope.orgId));
    // The Agent FK cascade has no deterministic row order. Remove its complete
    // head set explicitly after generation locks so archive repair and every
    // lifecycle writer acquire heads in the same UUID order.
    await deleteStableContextHeads(
      tx,
      eq(piStableContextHeads.orgId, scope.orgId),
    );
    return;
  }
  const ownedAgentGenerationCondition =
    agentIds.length === 0
      ? undefined
      : eq(
          piStableContextGenerations.agentId,
          sql`ANY(${sql.param(agentIds)}::uuid[])`,
        );
  const userGenerationCondition = eq(
    piStableContextGenerations.subject,
    scope.userId,
  );
  const generationCondition = ownedAgentGenerationCondition
    ? or(userGenerationCondition, ownedAgentGenerationCondition)
    : userGenerationCondition;
  if (!generationCondition) {
    throw new Error("Stable-context generation cleanup condition is empty");
  }
  await deleteStableContextGenerations(tx, generationCondition);
  await tx
    .delete(piStableContextPublications)
    .where(
      or(
        eq(piStableContextPublications.subject, scope.userId),
        agentIds.length === 0
          ? undefined
          : eq(
              piStableContextPublications.agentId,
              sql`ANY(${sql.param(agentIds)}::uuid[])`,
            ),
      ),
    );
  const ownedAgentHeadCondition =
    agentIds.length === 0
      ? undefined
      : eq(
          piStableContextHeads.agentId,
          sql`ANY(${sql.param(agentIds)}::uuid[])`,
        );
  const userHeadCondition = eq(piStableContextHeads.userId, scope.userId);
  const headCondition = ownedAgentHeadCondition
    ? or(userHeadCondition, ownedAgentHeadCondition)
    : userHeadCondition;
  if (!headCondition) {
    throw new Error("Stable-context head cleanup condition is empty");
  }
  // Stable artifacts are bound to the executing user even when the Agent is
  // public or owned by somebody else. Generation locks come before the full
  // head set. Explicitly delete every audience of an owned Agent in UUID order
  // before its FK cascade; the cascade retains ownership of their artifacts.
  await deleteStableContextHeads(tx, headCondition);
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.userId, scope.userId));
}

export async function deleteStableContextLifecycleAfterAuthorityRemoval(
  db: NodePgDatabase,
  scope: ClerkDeletionScope,
): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteClerkStableContextLifecycleData(tx, scope, []);
  });
}

async function revokeOwnedAgentMorningBriefDeliveries(
  tx: Tx,
  agentIds: readonly string[],
): Promise<void> {
  for (const agentId of agentIds) {
    // Revoke unsent Morning Brief mail ownership before the Agent cascade.
    await revokeMorningBriefDeliveryOwnership(tx, {
      kind: "agent",
      agentId,
    });
  }
}

/**
 * User deletion removes only the user's own rows. Agents the user owns are
 * retained with their `owner` unchanged, together with everything attached to
 * them (sessions and runs of other members, instructions Storage, Morning Brief
 * deliveries and stable context), so another member's work is never cascaded
 * away through an Agent.
 */
async function deleteClerkUserLifecycleData(
  db: NodePgDatabase,
  userId: string,
): Promise<void> {
  const receipt = await db.transaction(async (tx) => {
    // Compaction -> ledger/entitlements -> sessions/Run. The helper uses a
    // savepoint on this same connection; both deletion stages commit
    // atomically and retain their locks through that commit.
    await deleteUserUsageData(tx, userId);
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
    const userSessions = tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));
    await tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(inArray(agentSessions.id, userSessions))
      .orderBy(asc(agentSessions.id))
      .for("update");
    // UNION deduplicates the user's direct runs and runs in the user's sessions.
    const targetRuns = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, userId))
      .union(
        tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(inArray(agentRuns.sessionId, userSessions)),
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
    await tx.delete(agentSessions).where(eq(agentSessions.userId, userId));
    await tx
      .delete(chatThreadDrafts)
      .where(eq(chatThreadDrafts.userId, userId));
    await tx.delete(chatThreads).where(eq(chatThreads.userId, userId));
    await deleteClerkStableContextLifecycleData(
      tx,
      { kind: "user", userId },
      [],
    );
    return await releaseDeletedConversationReferences(tx, removed);
  });
  logCommittedConversationDeletion("clerk_user", receipt);
}

async function deleteClerkOrganizationLifecycleData(
  db: NodePgDatabase,
  orgId: string,
): Promise<void> {
  const receipt = await db.transaction(async (tx) => {
    // Compaction -> ledger/entitlements -> parents/Run. The helper uses a
    // savepoint on this same connection; both deletion stages commit
    // atomically and retain their locks through that commit.
    await deleteOrgUsageData(tx, orgId);
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
    const agentScope = eq(agents.orgId, orgId);
    const candidates = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(agentScope)
      .orderBy(asc(agents.id));
    for (const agent of candidates) {
      await lockCanonicalAgentMutation(tx, agent.id);
    }
    // Revalidate locked ownership before children can escape the accounted cascade.
    const ownedAgents =
      candidates.length === 0
        ? []
        : await tx
            .select({ id: agents.id })
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
    // UNION deduplicates direct and cross-org Agent -> Session -> Run ownership.
    const targetRuns = tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, orgId))
      .union(
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
    const scope = { kind: "organization", orgId } as const;
    await deleteClerkStableContextLifecycleData(tx, scope, agentIds);
    if (agentIds.length > 0) {
      await revokeOwnedAgentMorningBriefDeliveries(tx, agentIds);
      await tx
        .delete(agents)
        .where(
          and(
            agentScope,
            eq(agents.id, sql`ANY(${sql.param(agentIds)}::uuid[])`),
          ),
        );
      // Agent cascades drain child-row writers that could initialize non-FK
      // lifecycle metadata after the first sweep. Remove that late state while
      // the canonical Agent locks are still held.
      await deleteClerkStableContextLifecycleData(tx, scope, agentIds);
    }
    return await releaseDeletedConversationReferences(tx, removed);
  });
  logCommittedConversationDeletion("clerk_organization", receipt);
}

export async function deleteClerkAgentLifecycleData(
  db: NodePgDatabase,
  scope: ClerkDeletionScope,
): Promise<void> {
  if (scope.kind === "organization") {
    await deleteClerkOrganizationLifecycleData(db, scope.orgId);
  } else {
    await deleteClerkUserLifecycleData(db, scope.userId);
  }
}
