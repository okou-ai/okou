import { randomUUID } from "node:crypto";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { DrizzleQueryError, asc, eq, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { number, object, uuid } from "zod";
import {
  canonicalChatEventInsertSql,
  type PreparedChatEventRow,
} from "./chat-event-append.service";
import {
  pendingWorkflowScheduleTickCondition,
  type workflowAutomationQueueEventPlan,
  type WorkflowScheduleClaimPlan,
} from "./workflow-automation-enqueue.service";
import type { WorkflowSourceAdmissionPlan } from "./workflow-input-queue.service";
import type { threadModelReplacementWritePlan } from "./chat-input-model.service";
import { chatThreadServiceTierFromCodex } from "./chat-thread-event.service";
import {
  consumeWorkflowScheduleAnchorSql,
  journalWorkflowScheduleClaimSql,
} from "./workflow-schedule-queue.service";

export const workflowInputCommitRowSchema = object({
  eventId: uuid(),
  tickCount: number().int().nonnegative(),
  guard: number().int(),
});

type ModelEventScope = ReturnType<
  typeof threadModelReplacementWritePlan
>["eventScope"];

/** One input plus SQL-discovered revocations share the existing sequence row. */
function workflowInputCtes(row: PreparedChatEventRow, additionalInput: SQL) {
  const input = JSON.stringify([
    { ...row, ordinal: 0, createdAt: row.createdAt.toISOString() },
  ]);
  return sql`
    input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS event(
        id uuid, "chatThreadId" uuid, "runId" uuid, "revokesEventId" uuid,
        "eventType" text, payload jsonb, "modelSelection" jsonb, "failureReason" text,
        "requiredOfficialWorkflowIds" uuid[], "contextType" text, "contextId" uuid,
        "runEventSequenceNumber" integer, "runEventId" text,
        "createdAt" timestamp, ordinal integer
      )
      ${additionalInput}
    ), counts AS MATERIALIZED (
      SELECT "chatThreadId" AS chat_thread_id, count(*) AS event_count
      FROM input GROUP BY "chatThreadId"
    ), reserved AS (
      INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
      SELECT counts.chat_thread_id, counts.event_count
      FROM counts
      ORDER BY counts.chat_thread_id
      ON CONFLICT (chat_thread_id) DO UPDATE
        SET last_seq_id = chat_event_sequences.last_seq_id + EXCLUDED.last_seq_id
      RETURNING chat_thread_id, last_seq_id
    )
  `;
}

function pendingTicksSql(args: {
  readonly chatThreadId: string;
  readonly automationId: string;
  readonly eventId: string;
}) {
  return new QueryBuilder()
    .select({
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      seqId: chatEvents.seqId,
    })
    .from(chatEvents)
    .innerJoin(
      chatAutomationContext,
      eq(chatAutomationContext.id, chatEvents.contextId),
    )
    .where(pendingWorkflowScheduleTickCondition(args))
    .orderBy(asc(chatEvents.seqId))
    .getSQL();
}

/** Match the existing JS Date truncation and one-millisecond revoke ordering. */
function pendingTickInputSql(chatThreadId: string, currentTime: Date) {
  return sql`SELECT gen_random_uuid(), ${chatThreadId}::uuid,
    NULL::uuid, target.id, 'control.revoke', NULL::jsonb, NULL::jsonb,
    NULL::text, NULL::uuid[], target.context_type, target.context_id,
    NULL::integer, NULL::text,
    greatest(${currentTime.toISOString()}::timestamp,
      date_trunc('milliseconds', target.created_at) + interval '1 millisecond'),
    row_number() OVER (ORDER BY target.seq_id)::integer
    FROM workflow_pending_ticks AS target`;
}

function modelReplacementCtes(statement: SQL, scope: ModelEventScope) {
  const { replacement, updatedAt, tierChanged } = scope;
  const count = tierChanged ? 2 : 1;
  const rows = [
    sql`(${randomUUID()}::uuid, 'model_selection_updated'::chat_thread_event_kind,
    ${replacement.selectedModel}::text, NULL::text, 0)`,
  ];
  if (tierChanged) {
    rows.push(sql`(${randomUUID()}::uuid, 'service_tier_updated'::chat_thread_event_kind,
      NULL::text, ${chatThreadServiceTierFromCodex(replacement.codexServiceTier)}::text, 1)`);
  }
  return [
    sql`workflow_replaced_thread AS (${statement})`,
    sql`workflow_model_reserved AS (
      INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
      SELECT ${replacement.userId}, ${replacement.orgId}, ${count}
      FROM workflow_replaced_thread
      ON CONFLICT (user_id, org_id) DO UPDATE
        SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + EXCLUDED.last_seq_id
      RETURNING last_seq_id
    )`,
    sql`workflow_model_events AS (
      INSERT INTO ${chatThreadEvents} (
        id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
        selected_model, service_tier, cloud_browser_enabled, created_at
      ) SELECT event.id, ${replacement.userId}, ${replacement.orgId},
        reserved.last_seq_id - ${count} + event.ordinal + 1,
        ${replacement.chatThreadId}::uuid, event.kind, ${replacement.agentId}::uuid,
        event.selected_model, event.service_tier, false, ${updatedAt.toISOString()}::timestamp
      FROM workflow_model_reserved AS reserved
      CROSS JOIN (VALUES ${sql.join(rows, sql`, `)})
        AS event(id, kind, selected_model, service_tier, ordinal)
      ON CONFLICT (id) DO NOTHING RETURNING id
    )`,
  ];
}

/**
 * The queue event, receipts, claim, model events and queue row have one statement
 * rollback boundary. A tagged conversion error rolls back every CTE on a lost
 * admission; only this owner's exact marker is translated to a business result.
 */
export function workflowInputCommitSql(args: {
  readonly plan: ReturnType<typeof workflowAutomationQueueEventPlan>;
  readonly source: WorkflowSourceAdmissionPlan;
  readonly replacePendingTicks: boolean;
  readonly automationId: string;
  readonly currentTime: Date;
  readonly scheduleClaim?: WorkflowScheduleClaimPlan;
  readonly queueStatement: SQL;
  readonly replacement?: {
    readonly statement: SQL;
    readonly eventScope: ModelEventScope;
  };
}) {
  const { plan, source, currentTime } = args;
  const chatThreadId = plan.context.chatThreadId;
  const accepted = sql`EXISTS (SELECT 1 FROM inserted)`;
  const ctes: SQL[] = [];
  if (args.replacePendingTicks) {
    ctes.push(
      sql`workflow_pending_ticks AS MATERIALIZED (${pendingTicksSql({
        chatThreadId,
        automationId: args.automationId,
        eventId: plan.row.id,
      })})`,
    );
  }
  ctes.push(
    workflowInputCtes(
      plan.row,
      args.replacePendingTicks
        ? sql`UNION ALL ${pendingTickInputSql(chatThreadId, currentTime)}`
        : sql.empty(),
    ),
  );
  ctes.push(
    sql`inserted AS (${canonicalChatEventInsertSql(plan.conflict, {
      eligibility: sql`input.ordinal = 0`,
      sequenceOffset: sql`input.ordinal + 1`,
    })})`,
  );
  const context = plan.context;
  ctes.push(sql`workflow_context AS (
    INSERT INTO ${chatAutomationContext} (
      id, chat_thread_id, automation_id, workflow_name, event_type,
      event_payload, connector_source_id, trigger_brief, created_at
    ) SELECT ${context.id}::uuid, ${context.chatThreadId}::uuid,
      ${context.automationId}::uuid, ${context.workflowName}, ${context.eventType},
      ${sql.param(context.eventPayload, chatAutomationContext.eventPayload)},
      ${context.connectorSourceId}::uuid, ${context.triggerBrief},
      ${sql.param(context.createdAt, chatAutomationContext.createdAt)}
    FROM inserted ON CONFLICT DO NOTHING RETURNING id
  )`);
  const guards = [sql`WHEN NOT (${accepted}) THEN '__TX0333_V1_DUPLICATE__'`];
  if (args.scheduleClaim) {
    ctes.push(
      sql`workflow_consumed_claim AS (${consumeWorkflowScheduleAnchorSql(args.scheduleClaim, currentTime, accepted)})`,
    );
    ctes.push(
      sql`workflow_journaled_claim AS (${journalWorkflowScheduleClaimSql(
        args.scheduleClaim,
        plan.row.id,
        currentTime,
        sql`EXISTS (SELECT 1 FROM workflow_consumed_claim)`,
      )})`,
    );
    guards.push(
      sql`WHEN NOT EXISTS (SELECT 1 FROM workflow_consumed_claim) THEN '__TX0333_V1_SCHEDULE__'`,
    );
    guards.push(
      sql`WHEN NOT EXISTS (SELECT 1 FROM workflow_journaled_claim) THEN '__TX0333_V1_JOURNAL__'`,
    );
  }
  if (args.replacePendingTicks) {
    ctes.push(
      sql`workflow_revoked_ticks AS (${canonicalChatEventInsertSql("any", {
        eligibility: sql`input.ordinal > 0 AND ${accepted}`,
        sequenceOffset: sql`input.ordinal + 1`,
      })})`,
    );
  }
  for (const [index, step] of source.steps.entries()) {
    ctes.push(...(step.precedingCtes ?? []));
    const name = sql.identifier(`workflow_source_${String(index)}`);
    ctes.push(sql`${name} AS (${step.statement})`);
    if (step.failure) {
      guards.push(
        sql`WHEN NOT EXISTS (SELECT 1 FROM ${name}) THEN ${`__TX0333_V1_SOURCE_${String(index)}__`}`,
      );
    }
  }
  if (args.replacement) {
    ctes.push(
      ...modelReplacementCtes(
        args.replacement.statement,
        args.replacement.eventScope,
      ),
    );
  }
  ctes.push(sql`workflow_queued AS (${args.queueStatement})`);
  return sql`WITH ${sql.join(ctes, sql`, `)}
    SELECT (SELECT id FROM inserted) AS "eventId",
      ${args.replacePendingTicks ? sql`(SELECT count(*)::integer FROM workflow_pending_ticks)` : sql`0`} AS "tickCount",
      (CASE ${sql.join(guards, sql` `)} ELSE '0' END)::integer AS guard`;
}

export function workflowInputRollbackReason(error: unknown) {
  if (
    !(error instanceof DrizzleQueryError) ||
    typeof error.cause !== "object" ||
    error.cause === null ||
    !("code" in error.cause) ||
    error.cause.code !== "22P02" ||
    !("message" in error.cause) ||
    typeof error.cause.message !== "string"
  ) {
    return null;
  }
  return (
    /^invalid input syntax for type integer: "__TX0333_V1_(DUPLICATE|SCHEDULE|JOURNAL|SOURCE_\d+)__"$/.exec(
      error.cause.message,
    )?.[1] ?? null
  );
}
