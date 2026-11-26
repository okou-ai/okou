import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import {
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { writeDb$ } from "../external/db";

export const OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE =
  "Official Workflow threads only accept platform-generated task inputs";

export function officialWorkflowThreadCondition(owner: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
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
  return sql`(${installed} OR EXISTS (
    SELECT 1 FROM proactive_schedules WHERE chat_thread_id = ${owner.threadId}::uuid
      AND org_id = ${owner.orgId} AND user_id = ${owner.userId}
    ) OR EXISTS (SELECT 1 FROM proactive_occurrences WHERE org_id=${owner.orgId} AND user_id=${owner.userId} AND chat_thread_id=${owner.threadId}::uuid))`.mapWith(
    pgBooleanDecoder,
  );
}

export const isOfficialWorkflowThread$ = command(
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
      .select({ readOnly: officialWorkflowThreadCondition(owner) })
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

/** Resource admission expires with the Run; settlement retains the captured waiver. */
export function officialWorkflowCreditAccessSql(owner: {
  readonly runId?: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  if (!owner.runId) {
    return sql`'standard'::text`.mapWith(pgTextDecoder);
  }
  const free = exists(
    new QueryBuilder()
      .select({ id: billingRunAttribution.runId })
      .from(billingRunAttribution)
      .where(
        and(
          eq(billingRunAttribution.runId, owner.runId),
          eq(billingRunAttribution.orgId, owner.orgId),
          eq(billingRunAttribution.userId, owner.userId),
          inArray(billingRunAttribution.creditChargePolicy, [
            "platform_proactive",
            "official_workflow_free",
          ]),
        ),
      ),
  );
  const active = exists(
    new QueryBuilder()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, owner.runId),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.status, "running"),
        ),
      ),
  );
  return sql`CASE WHEN ${free} THEN CASE WHEN ${active} THEN 'free' ELSE 'closed' END ELSE 'standard' END`.mapWith(
    pgTextDecoder,
  );
}

/** Retained billing identity survives content deletion and delayed usage. */
export const officialWorkflowCreditAccess$ = command(
  async (
    { set },
    owner: {
      readonly runId?: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    if (!owner.runId) {
      return "standard";
    }
    const [row] = await set(writeDb$)
      .select({ access: officialWorkflowCreditAccessSql(owner) })
      .from(billingRunAttribution)
      .where(
        and(
          eq(billingRunAttribution.runId, owner.runId),
          eq(billingRunAttribution.orgId, owner.orgId),
          eq(billingRunAttribution.userId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row?.access ?? "standard";
  },
);
