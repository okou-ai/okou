import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  workflowWebhookAutomations,
  workflowWebhookDeliveries,
} from "@okouai/db/schema/workflow";
import { and, eq, not, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";

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

function callbackReceiptCondition(
  source: Extract<WorkflowQueueReceipt, { kind: "chat-run-finished" }>,
) {
  return and(
    eq(agentRunCallbacks.id, source.sourceCallbackId),
    eq(agentRunCallbacks.runId, source.runId),
    eq(agentRunCallbacks.internalKind, "chat"),
  );
}

/** Ordinary workflow inputs and their existing source receipts have one owner. */
export async function persistWorkflowSourceReceipt(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly receipt?: WorkflowQueueReceipt;
  },
  signal: AbortSignal,
): Promise<void> {
  const receipt = args.receipt;
  if (receipt?.kind === "chat-run-finished") {
    const receipts = sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`;
    const alreadyRecorded = sql`${receipts} @> to_jsonb(ARRAY[${args.automationId}::text])`;
    const [recorded] = await tx
      .update(agentRunCallbacks)
      .set({
        payload: sql`jsonb_set(${agentRunCallbacks.payload}, '{chatRunFinishedAutomationIds}', ${receipts} || to_jsonb(${args.automationId}::text))`,
      })
      .where(and(callbackReceiptCondition(receipt), not(alreadyRecorded)))
      .returning({ id: agentRunCallbacks.id });
    if (!recorded) {
      const [admitted] = await tx
        .select({ id: agentRunCallbacks.id })
        .from(agentRunCallbacks)
        .where(and(callbackReceiptCondition(receipt), alreadyRecorded))
        .limit(1);
      if (!admitted) {
        throw new Error("Chat run finished admission lost its source callback");
      }
      throw new ChatRunFinishedAutomationAlreadyAdmittedError();
    }
  } else if (receipt?.kind === "webhook") {
    await tx.insert(workflowWebhookDeliveries).values({
      ...receipt.delivery,
      automationId: args.automationId,
      status: "dispatched",
      runId: null,
      receivedAt: receipt.receivedAt,
      createdAt: receipt.receivedAt,
    });
    await tx
      .update(workflowWebhookAutomations)
      .set({
        lastReceivedAt: receipt.receivedAt,
        updatedAt: receipt.receivedAt,
      })
      .where(eq(workflowWebhookAutomations.automationId, args.automationId));
  }
  signal.throwIfAborted();
}
