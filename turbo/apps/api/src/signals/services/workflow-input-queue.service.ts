import { automationWorkflowJoinCondition } from "./workflow-visibility";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  workflows,
  workflowUserAutomationThreads,
  workflowWebhookAutomations,
  workflowWebhookDeliveries,
} from "@okouai/db/schema/workflow";
import { and, eq, not, sql, type SQL } from "drizzle-orm";
import {
  GmailAutomationBindingChangedError,
  GmailAutomationSourceChangedError,
} from "./workflow-gmail-queue.service";
import { GoogleCalendarSourceTransitionChangedError } from "./workflow-google-calendar-queue.service";
import { GoogleFormsSourceTransitionChangedError } from "./workflow-google-forms-queue.service";
import { GoogleMeetAutomationSourceChangedError } from "./workflow-google-meet-queue.service";
import { NotionAutomationSourceChangedError } from "./workflow-notion-queue.service";
import type { RunWorkflowAutomationNowArgs } from "./workflow-automation-enqueue.service";

export class ChatRunFinishedAutomationAlreadyAdmittedError extends Error {}
export class ChatRunFinishedAutomationBindingChangedError extends Error {}

export type WorkflowQueueReceipt =
  | {
      readonly kind: "chat-run-finished";
      readonly sourceCallbackId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "webhook";
      readonly delivery: {
        readonly id: string;
        readonly deliveryKey: string;
        readonly bodySha256: string;
      };
      readonly receivedAt: Date;
    };

export type WorkflowSourceFailure =
  | { readonly kind: "chat-run-finished" }
  | { readonly kind: "chat-run-finished-binding" }
  | { readonly kind: "gmail" }
  | { readonly kind: "gmail-binding" }
  | { readonly kind: "gmail-receipt" }
  | { readonly kind: "google-calendar" }
  | { readonly kind: "google-forms" }
  | { readonly kind: "google-meet" }
  | { readonly kind: "notion" };

/** A finite SQL plan contains neither resources nor executable callbacks. */
export interface WorkflowSourceAdmissionPlan {
  readonly steps: readonly {
    readonly precedingCtes?: readonly SQL[];
    readonly statement: SQL;
    readonly failure?: WorkflowSourceFailure;
  }[];
  readonly callbackDuplicateSql?: SQL;
  readonly gmailDuplicateSql?: SQL;
}

export type WorkflowAutomationBinding = Pick<
  RunWorkflowAutomationNowArgs,
  "automation" | "chatThreadId"
>;

/** Hold the observed binding for the duration of the atomic admission. */
export function currentWorkflowAutomationBindingSql(
  { automation, chatThreadId }: WorkflowAutomationBinding,
  condition: SQL,
  lock: "schedule-claim" | "event-receipt",
) {
  const binding = workflowUserAutomationThreads;
  const lockAutomation =
    lock === "schedule-claim" ? sql`FOR NO KEY UPDATE` : sql`FOR SHARE`;
  return sql`SELECT ${workflowAutomations.id} FROM ${workflowAutomations}
    JOIN ${workflows} ON ${automationWorkflowJoinCondition()}
    JOIN ${binding} ON ${and(
      eq(binding.orgId, workflowAutomations.orgId),
      eq(binding.userId, workflowAutomations.ownerUserId),
      eq(binding.workflowId, workflows.id),
    )}
    JOIN ${chatThreads} ON ${eq(chatThreads.id, binding.chatThreadId)}
    WHERE ${and(
      eq(workflowAutomations.id, automation.id),
      eq(workflowAutomations.enabled, true),
      eq(workflowAutomations.orgId, automation.orgId),
      eq(workflowAutomations.ownerUserId, automation.ownerUserId),
      eq(workflowAutomations.workflowId, automation.workflowId),
      eq(workflows.orgId, automation.orgId),
      eq(chatThreads.id, chatThreadId),
      eq(chatThreads.userId, automation.ownerUserId),
      eq(chatThreads.orgId, automation.orgId),
      condition,
    )}
    ${lockAutomation} OF ${workflowAutomations}
    FOR SHARE OF ${workflows}, ${binding}, ${chatThreads}`;
}

export function workflowSourceAdmissionError(
  failure: WorkflowSourceFailure,
): Error {
  switch (failure.kind) {
    case "chat-run-finished": {
      return new Error("Chat run finished admission lost its source callback");
    }
    case "chat-run-finished-binding": {
      return new ChatRunFinishedAutomationBindingChangedError(
        "Chat run finished automation binding changed before admission",
      );
    }
    case "gmail": {
      return new GmailAutomationSourceChangedError();
    }
    case "gmail-binding": {
      return new GmailAutomationBindingChangedError();
    }
    case "gmail-receipt": {
      return new Error("Gmail admission did not commit a receipt");
    }
    case "google-calendar": {
      return new GoogleCalendarSourceTransitionChangedError();
    }
    case "google-forms": {
      return new GoogleFormsSourceTransitionChangedError();
    }
    case "google-meet": {
      return new GoogleMeetAutomationSourceChangedError();
    }
    case "notion": {
      return new NotionAutomationSourceChangedError();
    }
  }
}

function callbackReceiptCondition(
  source: Extract<WorkflowQueueReceipt, { kind: "chat-run-finished" }>,
) {
  return and(
    eq(agentRunCallbacks.id, source.sourceCallbackId),
    eq(agentRunCallbacks.runId, source.runId),
    eq(agentRunCallbacks.internalKind, "chat"),
  );
}

export function workflowCallbackReceiptPlan(
  source: Extract<WorkflowQueueReceipt, { kind: "chat-run-finished" }>,
  binding: WorkflowAutomationBinding,
): WorkflowSourceAdmissionPlan {
  const { automation } = binding;
  const condition = sql`EXISTS (SELECT 1 FROM inserted)
    AND ${workflowAutomations.kind} = 'event'
    AND ${workflowAutomations.eventType} = 'chat-run-finished'
    AND ${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${JSON.stringify(automation.eventConfig)}::jsonb`;
  const receipts = sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`;
  const recorded = sql`${receipts} @> to_jsonb(ARRAY[${automation.id}::text])`;
  return {
    steps: [
      {
        precedingCtes: [
          sql`chat_run_finished_current_binding AS MATERIALIZED (${currentWorkflowAutomationBindingSql(binding, condition, "event-receipt")})`,
        ],
        statement: sql`SELECT 1 FROM chat_run_finished_current_binding`,
        failure: { kind: "chat-run-finished-binding" },
      },
      {
        statement: sql`UPDATE ${agentRunCallbacks}
        SET payload = jsonb_set(${agentRunCallbacks.payload}, '{chatRunFinishedAutomationIds}', ${receipts} || to_jsonb(${automation.id}::text))
        WHERE ${and(callbackReceiptCondition(source), not(recorded))}
          AND EXISTS (SELECT 1 FROM chat_run_finished_current_binding)
        RETURNING id`,
        failure: { kind: "chat-run-finished" },
      },
    ],
    callbackDuplicateSql: sql`SELECT ${agentRunCallbacks.id} FROM ${agentRunCallbacks}
      WHERE ${and(callbackReceiptCondition(source), recorded)} LIMIT 1`,
  };
}

export function workflowWebhookReceiptPlan(
  source: Extract<WorkflowQueueReceipt, { kind: "webhook" }>,
  automationId: string,
): WorkflowSourceAdmissionPlan {
  const receivedAt = source.receivedAt.toISOString();
  return {
    steps: [
      {
        precedingCtes: [
          sql`workflow_delivered AS (
    INSERT INTO ${workflowWebhookDeliveries} (id, automation_id, delivery_key, body_sha256, status, run_id, received_at, created_at)
    VALUES (${source.delivery.id}::uuid, ${automationId}::uuid, ${source.delivery.deliveryKey}, ${source.delivery.bodySha256}, 'dispatched', NULL, ${receivedAt}::timestamp, ${receivedAt}::timestamp)
    RETURNING id
  )`,
        ],
        statement: sql`UPDATE ${workflowWebhookAutomations}
    SET last_received_at = ${receivedAt}::timestamp, updated_at = ${receivedAt}::timestamp
    WHERE ${workflowWebhookAutomations.automationId} = ${automationId}::uuid
      AND EXISTS (SELECT 1 FROM workflow_delivered)
    RETURNING automation_id`,
      },
    ],
  };
}
