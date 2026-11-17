import { backgroundJobs } from "@okouai/db/schema/background-job";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { MarketingRewardSourceEvent } from "../../lib/marketing-reward-events";
import {
  MARKETING_REWARD_EVENT_JOB_KIND,
  MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION,
} from "./marketing-reward-event-publication";

const WORKFLOW_REWARD_SOURCE_NAMESPACE = "a2fc9d37-2b91-4ed2-a981-5c4b108ac6f1";

function factId(stage: "queued" | "run" | "completed", id: string) {
  return uuidv5(
    `${stage}:${id.toLowerCase()}`,
    WORKFLOW_REWARD_SOURCE_NAMESPACE,
  );
}

interface WorkflowSourceOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly environment: MarketingRewardSourceEvent["environment"];
  readonly occurredAt: Date;
}

/** The actual queued-input INSERT gates the creator snapshot, independently of campaign caps. */
export function workflowRewardQueuedEventInsert(
  args: WorkflowSourceOwner & {
    readonly sourceEventId: string;
    readonly workflowId: string;
  },
  accepted: SQL,
) {
  const id = factId("queued", args.sourceEventId);
  const input = {
    version: 4,
    id,
    environment: args.environment,
    type: "workflow.input-queued",
    occurredAt: args.occurredAt.toISOString(),
    orgId: args.orgId,
    userId: args.userId,
    sourceEventId: args.sourceEventId,
    workflowId: args.workflowId,
  };
  return sql`INSERT INTO ${backgroundJobs}
    (id, kind, handler_version, user_id, org_id, input, available_at, created_at, updated_at)
    SELECT ${id}::uuid, ${MARKETING_REWARD_EVENT_JOB_KIND}, ${MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION},
      ${args.userId}, ${args.orgId}, ${JSON.stringify(input)}::jsonb || jsonb_build_object('creatorUserId', ${workflows.createdBy}),
      timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
    FROM ${workflows} WHERE ${and(eq(workflows.id, args.workflowId), eq(workflows.orgId, args.orgId), isNull(workflows.officialDefinitionName))}
      AND ${accepted} RETURNING ${backgroundJobs.id}`;
}

/** Primary-key lookup retains immutable provenance after Workflow/input deletion. */
export function workflowRewardRunEventInsert(
  args: WorkflowSourceOwner & {
    readonly runId: string;
    readonly sourceEventId: string;
  },
  accepted: SQL,
) {
  return linkedFactInsert(
    {
      ...args,
      stage: "run",
      type: "workflow.run-created",
      sourceId: factId("queued", args.sourceEventId),
    },
    accepted,
  );
}

export function workflowRewardCompletedEventInsert(
  args: WorkflowSourceOwner & { readonly runId: string },
  accepted: SQL,
) {
  return linkedFactInsert(
    {
      ...args,
      stage: "completed",
      type: "workflow.run-completed",
      sourceId: factId("run", args.runId),
    },
    accepted,
  );
}

function linkedFactInsert(
  args: WorkflowSourceOwner & {
    readonly stage: "run" | "completed";
    readonly type: "workflow.run-created" | "workflow.run-completed";
    readonly runId: string;
    readonly sourceId: string;
  },
  accepted: SQL,
) {
  const id = factId(args.stage, args.runId);
  const changes = {
    id,
    type: args.type,
    runId: args.runId,
    occurredAt: args.occurredAt.toISOString(),
  };
  return sql`INSERT INTO ${backgroundJobs}
    (id, kind, handler_version, user_id, org_id, input, available_at, created_at, updated_at)
    SELECT ${id}::uuid, ${MARKETING_REWARD_EVENT_JOB_KIND}, ${MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION},
      ${backgroundJobs.userId}, ${backgroundJobs.orgId}, ${backgroundJobs.input} || ${JSON.stringify(changes)}::jsonb,
      timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
    FROM ${backgroundJobs} WHERE ${and(eq(backgroundJobs.id, args.sourceId), eq(backgroundJobs.kind, MARKETING_REWARD_EVENT_JOB_KIND), eq(backgroundJobs.handlerVersion, MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION), eq(backgroundJobs.orgId, args.orgId), eq(backgroundJobs.userId, args.userId))}
      AND ${backgroundJobs.input}->>'environment' = ${args.environment}
      AND ${accepted} RETURNING ${backgroundJobs.id}`;
}
