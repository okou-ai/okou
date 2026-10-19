import { QueryBuilder } from "drizzle-orm/pg-core";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { command } from "ccstate";
import { and, eq, exists, isNotNull, ne, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishThreadListChangedSafely } from "../external/realtime";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { metadataCommitWithEventsSql } from "./chat-thread-metadata-write-plan";
import { readAcceptedOfficialWorkflowCatalog$ } from "./official-workflow-catalog-read.service";
import { OfficialWorkflowRunAdmissionError } from "./official-workflow-run.service";

function officialThreadSettingsCondition(
  owner: OfficialWorkflowThreadOwner,
  threadId: string,
  definitionName: string,
  releaseId: string,
) {
  return and(
    eq(chatThreads.id, threadId),
    eq(chatThreads.userId, owner.userId),
    exists(
      new QueryBuilder()
        .select({ id: workflows.id })
        .from(workflows)
        .innerJoin(
          workflowUserAutomationThreads,
          eq(workflowUserAutomationThreads.workflowId, workflows.id),
        )
        .where(
          and(
            eq(workflows.id, owner.workflowId),
            eq(workflows.orgId, owner.orgId),
            eq(workflows.ownerUserId, owner.userId),
            eq(workflows.officialDefinitionName, definitionName),
            eq(workflowUserAutomationThreads.orgId, owner.orgId),
            eq(workflowUserAutomationThreads.userId, owner.userId),
            eq(workflowUserAutomationThreads.chatThreadId, threadId),
          ),
        ),
    ),
    exists(
      new QueryBuilder()
        .select({ id: officialWorkflowCatalogState.acceptedReleaseId })
        .from(officialWorkflowCatalogState)
        .where(
          and(
            eq(officialWorkflowCatalogState.authority, "official"),
            eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
          ),
        ),
    ),
  );
}

interface OfficialWorkflowThreadOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}

const readOfficialWorkflowThread$ = command(
  async ({ get }, owner: OfficialWorkflowThreadOwner, signal: AbortSignal) => {
    const [thread] = await get(db$)
      .select({
        id: chatThreads.id,
        agentId: chatThreads.agentId,
        hidden: chatThreads.hidden,
        selectedModel: chatThreads.selectedModel,
        codexServiceTier: chatThreads.codexServiceTier,
        lastMessageAt: chatThreads.lastMessageAt,
        definitionName: workflows.officialDefinitionName,
      })
      .from(workflowUserAutomationThreads)
      .innerJoin(
        workflows,
        eq(workflows.id, workflowUserAutomationThreads.workflowId),
      )
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, workflowUserAutomationThreads.chatThreadId),
      )
      .where(
        and(
          eq(workflowUserAutomationThreads.orgId, owner.orgId),
          eq(workflowUserAutomationThreads.userId, owner.userId),
          eq(workflows.id, owner.workflowId),
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          eq(chatThreads.userId, owner.userId),
          isNotNull(workflows.officialDefinitionName),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread;
  },
);

/**
 * Reconcile the binding without replacing its identity or conversation.
 * Returns whether this is an Official binding, including an already-current one.
 */
export const synchronizeOfficialWorkflowThread$ = command(
  async (
    { set },
    owner: OfficialWorkflowThreadOwner,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const thread = await set(readOfficialWorkflowThread$, owner, signal);
    if (!thread?.definitionName || !thread.agentId) {
      return false;
    }
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    if (
      !catalog ||
      !catalog.payload.definitions.some((definition) => {
        return definition.name === thread.definitionName;
      })
    ) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    const hidden = catalog.hiddenThreadDefinitionNames.includes(
      thread.definitionName,
    );
    const visibilityChanged = thread.hidden !== hidden;
    const modelChanged =
      thread.selectedModel !== AUTO_SELECTED_MODEL ||
      thread.codexServiceTier !== null;
    const database = set(writeDb$);
    // Recheck the installation binding and accepted policy in the owning write.
    const current = officialThreadSettingsCondition(
      owner,
      thread.id,
      thread.definitionName,
      catalog.releaseId,
    );
    if (visibilityChanged) {
      const changed = database
        .update(chatThreads)
        .set({ hidden, updatedAt: nowDate() })
        .where(and(current, ne(chatThreads.hidden, hidden)))
        .returning({ id: chatThreads.id, agentId: chatThreads.agentId });
      await database.execute(
        chatThreadEventInsertSql(
          {
            kind: "sort_touched",
            hidden,
            userId: owner.userId,
            orgId: owner.orgId,
            chatThreadId: thread.id,
            createdAt: thread.lastMessageAt,
          },
          {
            cte: sql`changed_thread AS (${changed.getSQL()})`,
            gate: sql`EXISTS (SELECT 1 FROM changed_thread)`,
            agentId: sql`(SELECT agent_id FROM changed_thread)`,
          },
        ),
      );
      signal.throwIfAborted();
    }
    if (modelChanged) {
      const updated = database
        .update(chatThreads)
        .set({
          selectedModel: AUTO_SELECTED_MODEL,
          codexServiceTier: null,
          updatedAt: nowDate(),
        })
        .where(
          and(
            current,
            or(
              ne(chatThreads.selectedModel, AUTO_SELECTED_MODEL),
              isNotNull(chatThreads.codexServiceTier),
            ),
          ),
        )
        .returning();
      await database.execute(
        metadataCommitWithEventsSql({
          updated: updated.getSQL(),
          userId: owner.userId,
          orgId: owner.orgId,
          events: [
            { kind: "model_selection_updated" },
            { kind: "service_tier_updated" },
          ],
        }),
      );
      signal.throwIfAborted();
    }
    if (visibilityChanged || modelChanged) {
      await publishThreadListChangedSafely({
        userId: owner.userId,
        orgId: owner.orgId,
      });
      signal.throwIfAborted();
    }
    return true;
  },
);
