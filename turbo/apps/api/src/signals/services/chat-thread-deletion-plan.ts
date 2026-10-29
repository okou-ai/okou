import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { and, asc, count, eq, gte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { array, boolean, object, string, unknown } from "zod";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";

interface ThreadDeletion {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly eventId?: string;
  readonly updatedAt: Date;
}

export const chatThreadDeletionRowSchema = object({
  deleted: boolean(),
  activeRuns: array(object({ runId: string(), orgId: string() })),
  disabledAutomations: array(
    object({
      orgId: string(),
      ownerUserId: string(),
      eventType: string().nullable(),
      eventConfig: unknown().transform((value) => {
        return typeof value === "string"
          ? workflowAutomations.eventConfig.mapFromDriverValue(value)
          : value;
      }),
      eventConnectorId: string().nullable(),
    }),
  ),
});

/** Keep the existing Run -> event sequence -> thread lock order. */
function threadDeletionFences(args: ThreadDeletion) {
  const ownedThread = and(
    eq(chatThreads.id, args.threadId),
    eq(chatThreads.userId, args.userId),
    chatThreadOrganizationPredicate(args.orgId),
  );
  const runFence = new QueryBuilder()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, args.threadId),
        sql`EXISTS (SELECT 1 FROM authorized_thread)`,
      ),
    )
    .orderBy(asc(agentRuns.id))
    .for("no key update");
  const sequenceFence = new QueryBuilder()
    .select({ id: chatEventSequences.chatThreadId })
    .from(chatEventSequences)
    .where(
      and(
        eq(chatEventSequences.chatThreadId, args.threadId),
        sql`EXISTS (SELECT 1 FROM authorized_thread)`,
        gte(sql`(SELECT ${count()} FROM run_fence)`, sql`0`),
      ),
    )
    .for("update");
  const attachedRunFence = new QueryBuilder()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, args.threadId),
        sql`EXISTS (SELECT 1 FROM owned_thread)`,
      ),
    )
    .orderBy(asc(agentRuns.id))
    .for("no key update");
  return sql`authorized_thread AS MATERIALIZED (
      ${new QueryBuilder().select({ id: chatThreads.id }).from(chatThreads).where(ownedThread)}
    ), run_fence AS MATERIALIZED (
      ${runFence}
    ), sequence_fence AS MATERIALIZED (
      ${sequenceFence}
    ), owned_thread AS MATERIALIZED (
      ${new QueryBuilder()
        .select({ id: chatThreads.id, agentId: chatThreads.agentId })
        .from(chatThreads)
        .where(
          and(
            ownedThread,
            gte(sql`(SELECT ${count()} FROM run_fence)`, sql`0`),
            gte(sql`(SELECT ${count()} FROM sequence_fence)`, sql`0`),
          ),
        )
        .for("update")}
    ), attached_run_fence AS MATERIALIZED (
      ${attachedRunFence}
    )`;
}

/** RETURNING carries the rows actually detached, including updated winners. */
function threadDeletionReferences(args: ThreadDeletion) {
  return sql`detached_runs AS (
      UPDATE ${agentRuns}
      SET ${sql.identifier(agentRuns.chatThreadId.name)} = NULL
      WHERE ${eq(agentRuns.chatThreadId, args.threadId)}
        AND EXISTS (SELECT 1 FROM owned_thread)
        AND ${gte(sql`(SELECT ${count()} FROM attached_run_fence)`, sql`0`)}
      RETURNING ${agentRuns.id} AS run_id, ${agentRuns.orgId} AS org_id,
        ${agentRuns.userId} AS user_id, ${agentRuns.status} AS status,
        ${agentRuns.triggerSource} AS trigger_source
    ), detached_bindings AS (
      UPDATE ${workflowUserAutomationThreads}
      SET ${sql.identifier(workflowUserAutomationThreads.chatThreadId.name)} = NULL
      WHERE ${eq(workflowUserAutomationThreads.chatThreadId, args.threadId)}
        AND EXISTS (SELECT 1 FROM owned_thread)
        AND ${gte(sql`(SELECT ${count()} FROM detached_runs)`, sql`0`)}
      RETURNING ${workflowUserAutomationThreads.workflowId} AS workflow_id,
        ${workflowUserAutomationThreads.userId} AS user_id
    ), disabled_automations AS (
      UPDATE ${workflowAutomations}
      SET ${sql.identifier(workflowAutomations.enabled.name)} = false,
        ${sql.identifier(workflowAutomations.nextRunAt.name)} = NULL,
        ${sql.identifier(workflowAutomations.updatedAt.name)} = ${args.updatedAt.toISOString()}::timestamp
      WHERE ${eq(workflowAutomations.ownerUserId, args.userId)}
        AND ${eq(workflowAutomations.enabled, true)}
        AND ${workflowAutomations.workflowId} IN (
          SELECT workflow_id FROM detached_bindings
          WHERE ${eq(sql`user_id`, args.userId)}
        )
      RETURNING ${workflowAutomations.orgId} AS "orgId",
        ${workflowAutomations.ownerUserId} AS "ownerUserId",
        ${workflowAutomations.eventType} AS "eventType",
        ${workflowAutomations.eventConfig} AS "eventConfig",
        ${workflowAutomations.eventConnectorId} AS "eventConnectorId"
    )`;
}

function threadDeletionRows(args: ThreadDeletion) {
  return sql`deleted_watermarks AS (
      DELETE FROM ${chatEventSearchMessageWatermarks}
      WHERE ${eq(chatEventSearchMessageWatermarks.chatThreadId, args.threadId)}
        AND EXISTS (SELECT 1 FROM owned_thread)
        AND ${gte(sql`(SELECT ${count()} FROM disabled_automations)`, sql`0`)}
      RETURNING ${chatEventSearchMessageWatermarks.chatThreadId}
    ), deleted_search_messages AS (
      DELETE FROM ${chatEventSearchMessages}
      WHERE ${eq(chatEventSearchMessages.chatThreadId, args.threadId)}
        AND EXISTS (SELECT 1 FROM owned_thread)
        AND ${gte(sql`(SELECT ${count()} FROM deleted_watermarks)`, sql`0`)}
      RETURNING ${chatEventSearchMessages.chatThreadId}
    ), deleted_thread AS (
      DELETE FROM ${chatThreads}
      WHERE ${eq(chatThreads.id, args.threadId)}
        AND EXISTS (SELECT 1 FROM owned_thread)
        AND ${gte(sql`(SELECT ${count()} FROM detached_runs)`, sql`0`)}
        AND ${gte(sql`(SELECT ${count()} FROM detached_bindings)`, sql`0`)}
        AND ${gte(sql`(SELECT ${count()} FROM deleted_search_messages)`, sql`0`)}
      RETURNING ${chatThreads.id}, ${chatThreads.agentId} AS agent_id
    )`;
}

/**
 * Single-statement candidate. Requires NO ACTION Run/binding FKs and cascading
 * search FKs; SET NULL would silently discard a late Run's cancellation receipt.
 * The rollout and cascade/event lock frontier must be qualified before shipping.
 */
export function chatThreadDeletionSql(args: ThreadDeletion) {
  return chatThreadEventInsertSql(
    {
      kind: "deleted",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: args.threadId,
      eventId: args.eventId,
    },
    {
      cte: sql`${threadDeletionFences(args)}, ${threadDeletionReferences(args)}, ${threadDeletionRows(args)}`,
      gate: sql`EXISTS (SELECT 1 FROM deleted_thread)`,
      agentId: sql`(SELECT agent_id FROM deleted_thread)`,
      result: sql`SELECT
        EXISTS (SELECT 1 FROM deleted_thread) AS deleted,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('runId', run_id, 'orgId', org_id))
          FROM detached_runs
          WHERE ${eq(sql`user_id`, args.userId)}
            AND status IN ('pending', 'running') AND trigger_source IS NOT NULL
        ), '[]'::jsonb) AS "activeRuns",
        COALESCE((
          SELECT jsonb_agg(to_jsonb(disabled_automations)) FROM disabled_automations
        ), '[]'::jsonb) AS "disabledAutomations"
        FROM (SELECT ${count()} FROM inserted) publication`,
    },
  );
}
