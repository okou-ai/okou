import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { chatEvents } from "@okouai/db/schema/chat-event";
import type { linkWalletSpends } from "@okouai/db/schema/link-wallet";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { publishUserSignal } from "../external/realtime";
import { writeDb$ } from "../external/db";
import { appendCanonicalChatEventsSql } from "./chat-event-append.service";
import { LinkWalletError } from "./link-wallet-provider.service";
import { webChatContextId } from "./web-chat-queue-context.service";

type Spend = typeof linkWalletSpends.$inferSelect;

export function requireApprovalThread(
  row: Spend,
  owner: { readonly chatThreadId?: string | null },
): void {
  if (row.approvalThreadId && owner.chatThreadId !== row.approvalThreadId) {
    throw new LinkWalletError(
      409,
      "WALLET_ORIGINAL_THREAD_REQUIRED",
      "Continue this purchase in the chat that requested approval; do not create a replacement purchase",
    );
  }
}

export function walletApprovalPrompt(row: Spend): string {
  return `Link 付款审批已通过：${row.merchantName}，金额上限 ${(row.amount / 100).toFixed(2)} ${row.currency.toUpperCase()}。请继续完成这笔购买。\n\nspendId: ${row.id}\n请先查询这笔请求的最新状态；审批通过不代表已经付款。不要新建付款请求或重复支付。`;
}

/**
 * The purchase ID is also its single continuation input ID. Manual takeover
 * competes with queue admission through the existing unique revoke edge.
 * Both enqueue and consumption already respect that edge, including retries.
 */
export const takeOverWalletApproval$ = command(
  async (
    { set },
    row: Spend,
    owner: { readonly runId?: string; readonly chatThreadId?: string | null },
    signal: AbortSignal,
  ) => {
    if (!row.approvalThreadId || !owner.runId) {
      return;
    }
    requireApprovalThread(row, owner);
    const database = set(writeDb$);
    const createdAt = nowDate();
    // If no automatic input exists yet, create and revoke a non-runnable manual
    // receipt together. The queue can never observe the input without its revoke.
    await database.execute(
      appendCanonicalChatEventsSql(
        [
          {
            id: row.id,
            chatThreadId: row.approvalThreadId,
            eventType: "input.prompt",
            contextType: "web",
            contextId: webChatContextId(),
            payload: {
              userMessage: {
                version: 1,
                parts: [
                  {
                    type: "text",
                    text: `Link 付款请求已手动接续。spendId: ${row.id}`,
                  },
                ],
              },
            },
            createdAt,
          },
          {
            id: randomUUID(),
            chatThreadId: row.approvalThreadId,
            eventType: "control.revoke",
            revokesEventId: row.id,
            runId: owner.runId,
            createdAt: new Date(createdAt.getTime() + 1),
          },
        ],
        "any",
      ),
    );
    signal.throwIfAborted();
    const [consumer] = await database
      .select({ runId: chatEvents.runId })
      .from(chatEvents)
      .where(eq(chatEvents.revokesEventId, row.id))
      .limit(1);
    signal.throwIfAborted();
    // A later manual run in the same thread is allowed to retry a failed checkout.
    // The original approval input stays revoked and cannot schedule another run.
    if (!consumer) {
      throw new Error("Link approval continuation receipt was not recorded");
    }
    await publishUserSignal([row.userId], "wallet:changed", {
      orgId: row.orgId,
    });
  },
);
