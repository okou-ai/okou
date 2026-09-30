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
import { usageEventCompactionLockSql } from "./usage-event-compaction-lock.service";
import { logCommittedConversationDeletion } from "./conversation-history-deletion.service";
import {
  addConversationDeletionReceipts,
  clerkStableContextCleanupSql,
  conversationFreeRunDeleteSql,
  emptyConversationDeletionReceipt,
  releaseRunConversationsSql,
  releasedConversationSweepSchema,
  requireReleasedConversationReferences,
  revokeAgentDeliveriesSql,
  runCatalogCleanupSql,
  throwClerkLifecycleFailure,
  throwUnconvergedRunSweep,
  type ClerkDeletionScope,
  type ConversationDeletionReceipt,
} from "./clerk-lifecycle-plan";

// Each sweep re-reads the target Runs, so a Run or conversation written after
// the previous sweep's snapshot is released by the next one. Concurrent
// checkpoints are rare after run cancellation; four sweeps bound the loop and
// a still-moving target set rolls back for the deletion job's retry.
const MAX_RUN_SWEEPS = 4;

async function sweepTargetRuns(
  tx: Tx,
  selectRunIds: () => Promise<readonly string[]>,
): Promise<ConversationDeletionReceipt> {
  let receipt = emptyConversationDeletionReceipt();
  for (let sweep = 0; ; sweep += 1) {
    const runIds = await selectRunIds();
    if (runIds.length === 0) {
      return receipt;
    }
    if (sweep === MAX_RUN_SWEEPS) {
      throwUnconvergedRunSweep();
    }
    const released = requireReleasedConversationReferences(
      parseRawRows(
        releasedConversationSweepSchema,
        await tx.execute(releaseRunConversationsSql(runIds)),
      ),
    );
    receipt = addConversationDeletionReceipts(receipt, released);
    for (const statement of runCatalogCleanupSql(runIds)) {
      await tx.execute(statement);
    }
    await tx.execute(conversationFreeRunDeleteSql(runIds));
  }
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
        // Outgoing maintenance still owns ledger rows before parents. Release 1
        // keeps its barrier, but every current writer takes jobs and parents first.
        await tx.execute(usageEventCompactionLockSql());
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
        const receipt = await sweepTargetRuns(tx, async () => {
          return idsOf(
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
        });
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
        // Match Social settlement's job-before-parent ownership.
        await tx.execute(usageEventCompactionLockSql());
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
        const receipt = await sweepTargetRuns(tx, async () => {
          return idsOf(
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
        });
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
