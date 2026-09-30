import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import { usageCleanupTargets } from "./usage-event-cleanup.service";
import { usageEventCompactionLockSql } from "./usage-event-compaction-lock.service";
import { logCommittedConversationDeletion } from "./conversation-history-deletion.service";
import {
  clerkStableContextCleanupSql,
  throwClerkLifecycleFailure,
  conversationDeletionReceipt,
  conversationBlobHashes,
  conversationReleasePlan,
  lockedRunCatalogCleanupSql,
  lockedRunDeleteCondition,
  removeRunConversationsSql,
  releaseConversationBlobsSql,
  removedConversationGroupSchema,
  requireConversationReferences,
  requireDeletedRunCount,
  revokeAgentDeliveriesSql,
  type ClerkDeletionScope,
} from "./clerk-lifecycle-plan";

const deleteClerkUserLifecycleData$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const outcome = await settle(
      db.transaction(async (tx) => {
        // Outgoing maintenance still owns ledger rows before parents. Release 1
        // keeps its barrier, but every current writer takes jobs and parents first.
        await tx.execute(usageEventCompactionLockSql());
        const [jobs, ...usage] = usageCleanupTargets({
          scope: "user",
          id: userId,
        });
        await tx.delete(jobs.table).where(jobs.condition);
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
        // Run parents precede their usage/allocation FK children. Delete raw rows
        // before hourly rows so a concurrent compaction cannot republish a rollup
        // behind this deletion's READ COMMITTED snapshot.
        for (const target of usage) {
          await tx.delete(target.table).where(target.condition);
        }
        const removed = parseRawRows(
          removedConversationGroupSchema,
          await tx.execute(removeRunConversationsSql(runIds)),
        );
        for (const statement of lockedRunCatalogCleanupSql(runIds)) {
          await tx.execute(statement);
        }
        const deleted = await tx
          .delete(agentRuns)
          .where(lockedRunDeleteCondition(runIds));
        requireDeletedRunCount(deleted.rowCount ?? 0, runIds);
        await tx.delete(agentSessions).where(eq(agentSessions.userId, userId));
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
        const release = conversationReleasePlan(removed);
        if (release.references.length > 0) {
          const locked = await tx
            .select({ hash: blobs.hash })
            .from(blobs)
            .where(inArray(blobs.hash, conversationBlobHashes(release)))
            .orderBy(asc(blobs.hash))
            .for("update", { noWait: true });
          requireConversationReferences(locked.length, release);
          const { rowCount } = await tx.execute(
            releaseConversationBlobsSql(release),
          );
          requireConversationReferences(rowCount ?? 0, release);
        }
        return conversationDeletionReceipt(release);
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
        // Match Social settlement's job-before-parent ownership. Acquire every
        // Session/Run parent before the entitlement and its ledger children below.
        await tx.execute(usageEventCompactionLockSql());
        const [jobs, ...usage] = usageCleanupTargets({
          scope: "organization",
          id: orgId,
        });
        await tx.delete(jobs.table).where(jobs.condition);
        const agentScope = eq(agents.orgId, orgId);
        const ownedAgents = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(agentScope)
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
        // Raw and hourly usage go first because hourly rollups reference
        // allowance windows; the entitlement (and its window cascade) is then
        // deleted by the loop's ordinary DELETE, with no explicit row lock.
        for (const target of usage) {
          await tx.delete(target.table).where(target.condition);
        }
        const removed = parseRawRows(
          removedConversationGroupSchema,
          await tx.execute(removeRunConversationsSql(runIds)),
        );
        for (const statement of lockedRunCatalogCleanupSql(runIds)) {
          await tx.execute(statement);
        }
        const deleted = await tx
          .delete(agentRuns)
          .where(lockedRunDeleteCondition(runIds));
        requireDeletedRunCount(deleted.rowCount ?? 0, runIds);
        const scope = { kind: "organization", orgId } as const;
        for (const statement of clerkStableContextCleanupSql(scope, agentIds)) {
          await tx.execute(statement);
        }
        if (agentIds.length > 0) {
          await tx.execute(revokeAgentDeliveriesSql(agentIds));
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
          // the Agent rows remain locked for deletion.
          for (const statement of clerkStableContextCleanupSql(
            scope,
            agentIds,
          )) {
            await tx.execute(statement);
          }
        }
        const release = conversationReleasePlan(removed);
        if (release.references.length > 0) {
          const locked = await tx
            .select({ hash: blobs.hash })
            .from(blobs)
            .where(inArray(blobs.hash, conversationBlobHashes(release)))
            .orderBy(asc(blobs.hash))
            .for("update", { noWait: true });
          requireConversationReferences(locked.length, release);
          const { rowCount } = await tx.execute(
            releaseConversationBlobsSql(release),
          );
          requireConversationReferences(rowCount ?? 0, release);
        }
        return conversationDeletionReceipt(release);
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
