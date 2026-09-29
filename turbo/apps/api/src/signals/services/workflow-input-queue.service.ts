import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import {
  workflowWebhookAutomations,
  workflowWebhookDeliveries,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, not, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";

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
export const enqueueWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly orgId: string;
      readonly receipt?: WorkflowQueueReceipt;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, receipt } = args;
    const currentTime = nowDate();
    return await db.transaction(async (tx) => {
      await tx
        .insert(chatAutomationContext)
        .values(input.context)
        .onConflictDoNothing();
      const [event] = parseRawRows(
        chatEventAppendResultSchema,
        await tx.execute(
          appendCanonicalChatEventsSql([input.event], input.conflict),
        ),
      );
      if (!event) {
        if (input.conflict === "none") {
          throw new Error("Workflow queue event insert returned no row");
        }
        return null;
      }
      if (receipt?.kind === "chat-run-finished") {
        const receipts = sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`;
        const alreadyRecorded = sql`${receipts} @> to_jsonb(ARRAY[${input.context.automationId}::text])`;
        const [recorded] = await tx
          .update(agentRunCallbacks)
          .set({
            payload: sql`jsonb_set(${agentRunCallbacks.payload}, '{chatRunFinishedAutomationIds}', ${receipts} || to_jsonb(${input.context.automationId}::text))`,
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
            throw new Error(
              "Chat run finished admission lost its source callback",
            );
          }
          throw new ChatRunFinishedAutomationAlreadyAdmittedError();
        }
      } else if (receipt?.kind === "webhook") {
        await tx.insert(workflowWebhookDeliveries).values({
          ...receipt.delivery,
          automationId: input.context.automationId,
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
          .where(
            eq(
              workflowWebhookAutomations.automationId,
              input.context.automationId,
            ),
          );
      }
      await tx
        .insert(queuedChatThreads)
        .values({
          chatThreadId: input.event.chatThreadId,
          orgId: args.orgId,
          queuedAt: currentTime,
        })
        .onConflictDoUpdate({
          target: queuedChatThreads.chatThreadId,
          set: { claimId: null, claimExpiresAt: null },
        });
      signal.throwIfAborted();
      return event.id;
    });
  },
);
