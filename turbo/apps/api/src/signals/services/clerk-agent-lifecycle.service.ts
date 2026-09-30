import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import { usageCleanupTargets } from "./usage-event-cleanup.service";
import { logCommittedConversationDeletion } from "./conversation-history-deletion.service";
import {
  clerkStableContextCleanupSql,
  conversationFreeRunDeleteSql,
  deletedRunCountSchema,
  emptyConversationDeletionReceipt,
  releaseRunConversationsSql,
  releasedConversationSweepSchema,
  requireReleasedConversationReferences,
  revokeAgentDeliveriesSql,
  runCatalogCleanupSql,
  runFreeAgentDeleteSql,
  runFreeUserSessionDeleteSql,
  throwClerkLifecycleFailure,
  throwLateRunConversation,
  type ClerkDeletionScope,
  type ConversationDeletionReceipt,
} from "./clerk-lifecycle-plan";

/**
 * Delete one snapshot of target Runs conversation-first, in a single pass.
 *
 * The conversations and their blob references go in one statement, then the
 * catalog, then only conversation-free Runs. A Run that gained a conversation
 * in between survives that DELETE; the short count rolls the whole deletion
 * back for the job's existing attempt schedule instead of re-sweeping here.
 */
async function deleteTargetRunsConversationFirst(
  tx: Tx,
  runIds: readonly string[],
): Promise<ConversationDeletionReceipt> {
  if (runIds.length === 0) {
    return emptyConversationDeletionReceipt();
  }
  const receipt = requireReleasedConversationReferences(
    parseRawRows(
      releasedConversationSweepSchema,
      await tx.execute(releaseRunConversationsSql(runIds)),
    ),
  );
  for (const statement of runCatalogCleanupSql(runIds)) {
    await tx.execute(statement);
  }
  const [deleted] = parseRawRows(
    deletedRunCountSchema,
    await tx.execute(conversationFreeRunDeleteSql(runIds)),
  );
  if (deleted?.deletedRuns !== runIds.length) {
    throwLateRunConversation();
  }
  return receipt;
}

function idsOf(rows: readonly { readonly id: string }[]) {
  return rows.map((row) => {
    return row.id;
  });
}

const deleteClerkUserLifecycleData$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const outcome = await settle(
      db.transaction(async (tx) => {
        const [jobs, ...usage] = usageCleanupTargets({
          scope: "user",
          id: userId,
        });
        await tx.delete(jobs.table).where(jobs.condition);
        // Raw usage goes before hourly rows so a concurrent compaction cannot
        // republish a rollup behind this deletion's READ COMMITTED snapshot.
        // Usage Run references are SET NULL, so they need no Run ordering.
        for (const target of usage) {
          await tx.delete(target.table).where(target.condition);
        }
        const userSessions = tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(eq(agentSessions.userId, userId));
        // UNION deduplicates the user's direct runs and runs in the user's sessions.
        const runIds = idsOf(
          await tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.userId, userId))
            .union(
              tx
                .select({ id: agentRuns.id })
                .from(agentRuns)
                .where(inArray(agentRuns.sessionId, userSessions)),
            ),
        );
        const receipt = await deleteTargetRunsConversationFirst(tx, runIds);
        await tx.execute(runFreeUserSessionDeleteSql(userId));
        const [lateSession] = await tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(eq(agentSessions.userId, userId))
          .limit(1);
        if (lateSession) {
          throwLateRunConversation();
        }
        await tx
          .delete(chatThreadDrafts)
          .where(eq(chatThreadDrafts.userId, userId));
        await tx.delete(chatThreads).where(eq(chatThreads.userId, userId));
        for (const statement of clerkStableContextCleanupSql(
          { kind: "user", userId },
          [],
        )) {
          await tx.execute(statement);
        }
        return receipt;
      }),
    );
    signal.throwIfAborted();
    if (!outcome.ok) {
      throwClerkLifecycleFailure(outcome.error);
    }
    const receipt = outcome.value;
    logCommittedConversationDeletion("clerk_user", receipt);
    signal.throwIfAborted();
  },
);

const deleteClerkOrganizationLifecycleData$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const outcome = await settle(
      db.transaction(async (tx) => {
        // Match Social settlement's job-before-parent mutations.
        const [jobs, ...usage] = usageCleanupTargets({
          scope: "organization",
          id: orgId,
        });
        await tx.delete(jobs.table).where(jobs.condition);
        // Raw and hourly usage go first because hourly rollups reference
        // allowance windows; the entitlement (and its window cascade) is then
        // deleted by the loop's ordinary DELETE, with no explicit row lock.
        for (const target of usage) {
          await tx.delete(target.table).where(target.condition);
        }
        const agentScope = eq(agents.orgId, orgId);
        // The Agent set is this deletion's snapshot; an Agent created later is
        // not our evidence and survives, as on the locked path before.
        const agentIds = idsOf(
          await tx.select({ id: agents.id }).from(agents).where(agentScope),
        );
        const ownedSessions = tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            eq(agentSessions.agentId, sql`ANY(${sql.param(agentIds)}::uuid[])`),
          );
        // UNION deduplicates direct and cross-org Agent -> Session -> Run ownership.
        const runIds = idsOf(
          await tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.orgId, orgId))
            .union(
              tx
                .select({ id: agentRuns.id })
                .from(agentRuns)
                .where(inArray(agentRuns.sessionId, ownedSessions)),
            ),
        );
        const receipt = await deleteTargetRunsConversationFirst(tx, runIds);
        const scope = { kind: "organization", orgId } as const;
        for (const statement of clerkStableContextCleanupSql(scope, agentIds)) {
          await tx.execute(statement);
        }
        if (agentIds.length > 0) {
          await tx.execute(revokeAgentDeliveriesSql(agentIds));
          // Only Agents with no Run left under their Sessions; a late Run
          // (and its conversation) is never removed by the Agent cascade.
          await tx.execute(runFreeAgentDeleteSql(orgId, agentIds));
          const [lateAgent] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                agentScope,
                eq(agents.id, sql`ANY(${sql.param(agentIds)}::uuid[])`),
              ),
            )
            .limit(1);
          if (lateAgent) {
            throwLateRunConversation();
          }
          // Agent cascades drain child-row writers that could initialize non-FK
          // lifecycle metadata after the first sweep. The Agent DELETE waits for
          // those writers, so this second sweep removes their late state.
          for (const statement of clerkStableContextCleanupSql(
            scope,
            agentIds,
          )) {
            await tx.execute(statement);
          }
        }
        return receipt;
      }),
    );
    signal.throwIfAborted();
    if (!outcome.ok) {
      throwClerkLifecycleFailure(outcome.error);
    }
    const receipt = outcome.value;
    logCommittedConversationDeletion("clerk_organization", receipt);
    signal.throwIfAborted();
  },
);

export const deleteClerkAgentLifecycleData$ = command(
  async (
    { set },
    scope: ClerkDeletionScope,
    signal: AbortSignal,
  ): Promise<void> => {
    if (scope.kind === "organization") {
      await set(deleteClerkOrganizationLifecycleData$, scope.orgId, signal);
    } else {
      await set(deleteClerkUserLifecycleData$, scope.userId, signal);
    }
  },
);

export const deleteStableContextLifecycleAfterAuthorityRemoval$ = command(
  async (
    { set },
    scope: ClerkDeletionScope,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      for (const statement of clerkStableContextCleanupSql(scope, [])) {
        await tx.execute(statement);
      }
    });
    signal.throwIfAborted();
  },
);
