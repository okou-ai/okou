import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { artifacts } from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import { usageCleanupTargets } from "./usage-event-cleanup.service";
import { logCommittedConversationDeletion } from "./conversation-history-deletion.service";
import {
  artifactFileOwnershipConditions,
  artifactCatalogFileBatchCondition,
} from "./artifact-catalog-deletion.service";
import {
  clerkPublicationFenceCleanupSql,
  conversationFreeRunDeleteSql,
  deletedRunCountSchema,
  emptyConversationDeletionReceipt,
  releaseRunConversationsSql,
  releasedConversationSweepSchema,
  requireReleasedConversationReferences,
  runFreeAgentDeleteSql,
  runFreeUserSessionDeleteSql,
  throwClerkLifecycleFailure,
  throwLateRunConversation,
  type ClerkDeletionScope,
  type ConversationDeletionReceipt,
} from "./clerk-lifecycle-plan";
import { purgeRetiredMorningBriefEmailSql } from "./retired-morning-brief-email";

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
        const ownership = artifactFileOwnershipConditions({
          kind: "user",
          userId,
        });
        // File-first locks fence the projector; catalog ownership must remain
        // available until its files and their queue/media children are erased.
        for (;;) {
          const files = await tx
            .select({ id: runUploadedFiles.id })
            .from(runUploadedFiles)
            .where(ownership.fileScope)
            .orderBy(asc(runUploadedFiles.id))
            .limit(500)
            .for("update");
          signal.throwIfAborted();
          if (files.length === 0) {
            break;
          }
          const fileIds = idsOf(files);
          await tx
            .delete(artifacts)
            .where(artifactCatalogFileBatchCondition(fileIds));
          signal.throwIfAborted();
          await tx
            .delete(runUploadedFiles)
            .where(inArray(runUploadedFiles.id, fileIds));
          signal.throwIfAborted();
        }
        await tx.delete(artifacts).where(ownership.catalogScope);
        signal.throwIfAborted();
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
        // Release this Run snapshot's references before deleting only its
        // conversation-free Runs; a short count rolls the whole cleanup back.
        let receipt: ConversationDeletionReceipt;
        if (runIds.length === 0) {
          receipt = emptyConversationDeletionReceipt();
        } else {
          receipt = requireReleasedConversationReferences(
            parseRawRows(
              releasedConversationSweepSchema,
              await tx.execute(releaseRunConversationsSql(runIds)),
            ),
          );
          const [deleted] = parseRawRows(
            deletedRunCountSchema,
            await tx.execute(conversationFreeRunDeleteSql(runIds)),
          );
          if (deleted?.deletedRuns !== runIds.length) {
            throwLateRunConversation();
          }
        }
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
        for (const statement of clerkPublicationFenceCleanupSql(
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
        // Raw deletion precedes hourly cleanup so a winning compaction's
        // committed fragments are visible to the following DELETE.
        for (const target of usage) {
          await tx.delete(target.table).where(target.condition);
        }
        const ownership = artifactFileOwnershipConditions({
          kind: "organization",
          orgId,
        });
        // Keep the same file-first projector fence inside the account-erasure
        // transaction; never pass tx to a helper or independently commit files.
        for (;;) {
          const files = await tx
            .select({ id: runUploadedFiles.id })
            .from(runUploadedFiles)
            .where(ownership.fileScope)
            .orderBy(asc(runUploadedFiles.id))
            .limit(500)
            .for("update");
          signal.throwIfAborted();
          if (files.length === 0) {
            break;
          }
          const fileIds = idsOf(files);
          await tx
            .delete(artifacts)
            .where(artifactCatalogFileBatchCondition(fileIds));
          signal.throwIfAborted();
          await tx
            .delete(runUploadedFiles)
            .where(inArray(runUploadedFiles.id, fileIds));
          signal.throwIfAborted();
        }
        await tx.delete(artifacts).where(ownership.catalogScope);
        signal.throwIfAborted();
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
        // Release this Run snapshot's references before deleting only its
        // conversation-free Runs; a short count rolls the whole cleanup back.
        let receipt: ConversationDeletionReceipt;
        if (runIds.length === 0) {
          receipt = emptyConversationDeletionReceipt();
        } else {
          receipt = requireReleasedConversationReferences(
            parseRawRows(
              releasedConversationSweepSchema,
              await tx.execute(releaseRunConversationsSql(runIds)),
            ),
          );
          const [deleted] = parseRawRows(
            deletedRunCountSchema,
            await tx.execute(conversationFreeRunDeleteSql(runIds)),
          );
          if (deleted?.deletedRuns !== runIds.length) {
            throwLateRunConversation();
          }
        }
        const scope = { kind: "organization", orgId } as const;
        for (const statement of clerkPublicationFenceCleanupSql(
          scope,
          agentIds,
        )) {
          await tx.execute(statement);
        }
        if (agentIds.length > 0) {
          await tx.execute(purgeRetiredMorningBriefEmailSql());
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
          for (const statement of clerkPublicationFenceCleanupSql(
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

export const deletePublicationFencesAfterAuthorityRemoval$ = command(
  async (
    { set },
    scope: ClerkDeletionScope,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      for (const statement of clerkPublicationFenceCleanupSql(scope, [])) {
        await tx.execute(statement);
      }
    });
    signal.throwIfAborted();
  },
);
