import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, exists, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";

export const PLATFORM_TASK_THREAD_READ_ONLY_MESSAGE =
  "Platform task threads only accept platform-generated task inputs";

export function platformTaskThreadCondition(owner: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  // Archived installations can still own threads that have no standalone schedule.
  const installed = exists(
    new QueryBuilder()
      .select({ id: workflows.id })
      .from(workflowUserAutomationThreads)
      .innerJoin(
        workflows,
        eq(workflows.id, workflowUserAutomationThreads.workflowId),
      )
      .where(
        and(
          eq(workflowUserAutomationThreads.chatThreadId, owner.threadId),
          eq(workflowUserAutomationThreads.orgId, owner.orgId),
          eq(workflowUserAutomationThreads.userId, owner.userId),
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          isNotNull(workflows.officialDefinitionName),
        ),
      ),
  );
  return sql`(
    EXISTS (SELECT 1 FROM proactive_schedules
      WHERE chat_thread_id = ${owner.threadId}::uuid AND org_id = ${owner.orgId} AND user_id = ${owner.userId})
    OR EXISTS (SELECT 1 FROM proactive_occurrences
      WHERE chat_thread_id = ${owner.threadId}::uuid AND org_id = ${owner.orgId} AND user_id = ${owner.userId})
    OR EXISTS (SELECT 1 FROM archived_proactive_workflows
      WHERE chat_thread_id = ${owner.threadId}::uuid AND org_id = ${owner.orgId} AND owner_user_id = ${owner.userId})
    OR ${installed}
  )`.mapWith(pgBooleanDecoder);
}

export const isPlatformTaskThread$ = command(
  async (
    { set },
    owner: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const [row] = await set(writeDb$)
      .select({ readOnly: platformTaskThreadCondition(owner) })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, owner.threadId),
          eq(chatThreads.userId, owner.userId),
          eq(chatThreads.orgId, owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.readOnly === true;
  },
);
