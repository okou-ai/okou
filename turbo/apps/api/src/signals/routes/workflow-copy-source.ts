import {
  workflows,
  workflowWebhookAutomations,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, asc, eq, inArray, getTableColumns, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { WorkflowRow } from "../services/workflow-data.service";
import { userWorkflowCondition } from "../services/workflow-visibility";

interface WorkflowCopyObservation {
  readonly workflowXmin: string;
  readonly automations: readonly {
    readonly id: string;
    readonly xmin: string;
  }[];
}

export interface WorkflowCopySource {
  readonly observation: WorkflowCopyObservation;
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceAutomations: readonly (typeof workflowAutomations.$inferSelect)[];
  readonly webhooks: readonly {
    readonly automationId: string;
    readonly encryptedSecret: string;
    readonly secretLastFour: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

export interface WorkflowCopyInput {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowXmin: string;
  readonly sourceWorkflow: WorkflowRow;
  readonly sourceFiles: WorkflowCopySource["files"];
}

const WORKFLOW_COPY_CHANGED_MESSAGE =
  "Workflow copy source or target changed during preparation; retry the copy";
export function workflowCopyConflict(message = WORKFLOW_COPY_CHANGED_MESSAGE) {
  return { kind: "conflict" as const, message };
}

/** Capture permissions, content and its version from the same visible row. */
export function workflowCopyVisibleQuery(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}) {
  return new QueryBuilder()
    .select({
      workflow: getTableColumns(workflows),
      observedXmin: sql`${workflows}.xmin::text`
        .mapWith(pgTextDecoder)
        .as("observed_xmin"),
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        userWorkflowCondition(args.userId),
      ),
    )
    .limit(1)
    .as("copy_visible");
}

export function copyAutomationsQuery(args: WorkflowCopyInput) {
  return new QueryBuilder()
    .select({
      ...getTableColumns(workflowAutomations),
      observedXmin: sql`${workflowAutomations}.xmin::text`
        .mapWith(pgTextDecoder)
        .as("observed_xmin"),
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.workflowId, args.sourceWorkflow.id),
      ),
    )
    .orderBy(asc(workflowAutomations.id))
    .as("copy_automations");
}

export function copyWebhooksQuery(
  rows: WorkflowCopySource["sourceAutomations"],
) {
  const query = new QueryBuilder()
    .select({
      automationId: workflowWebhookAutomations.automationId,
      encryptedSecret: workflowWebhookAutomations.encryptedSecret,
      secretLastFour: workflowWebhookAutomations.secretLastFour,
    })
    .from(workflowWebhookAutomations)
    .where(
      inArray(
        workflowWebhookAutomations.automationId,
        rows.map((row) => {
          return row.id;
        }),
      ),
    )
    .orderBy(asc(workflowWebhookAutomations.automationId));
  return query.as("copy_webhooks");
}
