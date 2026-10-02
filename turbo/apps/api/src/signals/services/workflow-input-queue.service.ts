import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  workflowWebhookAutomations,
  workflowWebhookDeliveries,
} from "@okouai/db/schema/workflow";
import { and, eq, not, sql, type SQL } from "drizzle-orm";
import { GmailAutomationSourceChangedError } from "./workflow-gmail-queue.service";
import { GoogleCalendarSourceTransitionChangedError } from "./workflow-google-calendar-queue.service";
import { GoogleFormsSourceTransitionChangedError } from "./workflow-google-forms-queue.service";
import { GoogleMeetAutomationSourceChangedError } from "./workflow-google-meet-queue.service";
import { NotionAutomationSourceChangedError } from "./workflow-notion-queue.service";
import {
  StripeDeliveryClaimChangedError,
  StripeDeliveryTargetChangedError,
} from "./workflow-stripe-queue.service";

export class ChatRunFinishedAutomationAlreadyAdmittedError extends Error {}

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
  | { readonly kind: "gmail" }
  | { readonly kind: "google-calendar" }
  | { readonly kind: "google-forms" }
  | { readonly kind: "google-meet" }
  | { readonly kind: "notion" }
  | { readonly kind: "stripe-claim" }
  | { readonly kind: "stripe-target"; readonly reason: string };

/** A finite SQL plan contains neither resources nor executable callbacks. */
export interface WorkflowSourceAdmissionPlan {
  readonly steps: readonly {
    readonly statement: SQL;
    readonly failure?: WorkflowSourceFailure;
  }[];
  readonly callbackDuplicateSql?: SQL;
}

export function workflowSourceAdmissionError(
  failure: WorkflowSourceFailure,
): Error {
  switch (failure.kind) {
    case "chat-run-finished": {
      return new Error("Chat run finished admission lost its source callback");
    }
    case "gmail": {
      return new GmailAutomationSourceChangedError();
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
    case "stripe-claim": {
      return new StripeDeliveryClaimChangedError();
    }
    case "stripe-target": {
      return new StripeDeliveryTargetChangedError(failure.reason);
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
  automationId: string,
): WorkflowSourceAdmissionPlan {
  const receipts = sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`;
  const recorded = sql`${receipts} @> to_jsonb(ARRAY[${automationId}::text])`;
  return {
    steps: [
      {
        statement: sql`UPDATE ${agentRunCallbacks}
        SET payload = jsonb_set(${agentRunCallbacks.payload}, '{chatRunFinishedAutomationIds}', ${receipts} || to_jsonb(${automationId}::text))
        WHERE ${and(callbackReceiptCondition(source), not(recorded))} RETURNING id`,
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
        statement: sql`WITH delivered AS (
    INSERT INTO ${workflowWebhookDeliveries} (id, automation_id, delivery_key, body_sha256, status, run_id, received_at, created_at)
    VALUES (${source.delivery.id}::uuid, ${automationId}::uuid, ${source.delivery.deliveryKey}, ${source.delivery.bodySha256}, 'dispatched', NULL, ${receivedAt}::timestamp, ${receivedAt}::timestamp)
    RETURNING id
  ) UPDATE ${workflowWebhookAutomations}
    SET last_received_at = ${receivedAt}::timestamp, updated_at = ${receivedAt}::timestamp
    WHERE ${workflowWebhookAutomations.automationId} = ${automationId}::uuid
      AND EXISTS (SELECT 1 FROM delivered)`,
      },
    ],
  };
}
