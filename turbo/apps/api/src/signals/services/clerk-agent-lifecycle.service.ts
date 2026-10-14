import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunDeletionMembership } from "@okouai/db/operations/run-history-deletion";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { artifacts } from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
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
  emptyConversationDeletionReceipt,
  releaseRunHistoriesSql,
  releasedConversationSweepSchema,
  requireReleasedConversationReferences,
  runFreeAgentDeleteSql,
  throwClerkLifecycleFailure,
  throwLateRunConversation,
  type ClerkDeletionScope,
  type ConversationDeletionReceipt,
} from "./clerk-lifecycle-plan";

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
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0098; new non-billing transactions are prohibited.
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
        const runIds = idsOf(
          await tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.userId, userId)),
        );
        // Delete this exact Run snapshot and release its held references.
        // A missing Run or reference rolls back the whole cleanup.
        let receipt: ConversationDeletionReceipt;
        if (runIds.length === 0) {
          receipt = emptyConversationDeletionReceipt();
        } else {
          receipt = requireReleasedConversationReferences(
            parseRawRows(
              releasedConversationSweepSchema,
              await tx.execute(releaseRunHistoriesSql(runIds)),
            ),
            runIds.length,
          );
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
        // Observe immutable Run ownership again after Thread/publication cleanup.
        const [lateRun] = await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.userId, userId))
          .limit(1);
        if (lateRun) {
          throwLateRunConversation();
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
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0099; new non-billing transactions are prohibited.
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
        // UNION deduplicates organization, direct Agent and legacy Session ownership.
        const runIds = idsOf(
          await tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.orgId, orgId))
            .union(
              tx
                .select({ id: agentRuns.id })
                .from(agentRuns)
                .where(agentRunDeletionMembership(agentIds)),
            ),
        );
        // Delete this exact Run snapshot and release its held references.
        // A missing Run or reference rolls back the whole cleanup.
        let receipt: ConversationDeletionReceipt;
        if (runIds.length === 0) {
          receipt = emptyConversationDeletionReceipt();
        } else {
          receipt = requireReleasedConversationReferences(
            parseRawRows(
              releasedConversationSweepSchema,
              await tx.execute(releaseRunHistoriesSql(runIds)),
            ),
            runIds.length,
          );
        }
        const scope = { kind: "organization", orgId } as const;
        for (const statement of clerkPublicationFenceCleanupSql(
          scope,
          agentIds,
        )) {
          await tx.execute(statement);
        }
        if (agentIds.length > 0) {
          // Guard both direct and legacy ownership before the Agent cascade.
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
        // Agent's SET NULL FK can clear a late Run's direct binding while its
        // DELETE waits. Immutable org ownership still identifies that Run in
        // this fresh snapshot, so retry instead of acknowledging partial erasure.
        const [lateRun] = await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.orgId, orgId))
          .limit(1);
        if (lateRun) {
          throwLateRunConversation();
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

// Once entered, finish both writes before the caller observes cancellation,
// matching the former transaction callback's cleanup phase.
const deletePublicationFences$ = command(
  async ({ set }, scope: ClerkDeletionScope): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(storagePublicationGenerations)
      .where(
        scope.kind === "organization"
          ? eq(storagePublicationGenerations.orgId, scope.orgId)
          : eq(storagePublicationGenerations.subject, scope.userId),
      );
    // Use a fresh statement snapshot to see tokens committed while the
    // generation DELETE waited for an in-flight publisher. Always clear tokens,
    // even when no generation remains; only both writes complete the cleanup.
    await db
      .delete(storagePublicationTokens)
      .where(
        scope.kind === "organization"
          ? eq(storagePublicationTokens.orgId, scope.orgId)
          : eq(storagePublicationTokens.subject, scope.userId),
      );
  },
);

export const deletePublicationFencesAfterAuthorityRemoval$ = command(
  async (
    { set },
    scope: ClerkDeletionScope,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await set(deletePublicationFences$, scope);
    signal.throwIfAborted();
  },
);
