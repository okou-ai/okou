import { command } from "ccstate";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { wechatChatThreadRoutes } from "@okouai/db/schema/wechat";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { dispatchRunCallbacks$ } from "./agent-run-callback.service";

/** Recover through the source callback, including a crash before reply registration. */
export const recoverWechatChatDeliveries$ = command(
  async (
    { get, set },
    connection: {
      readonly id: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const [callback] = await get(db$)
      .select({
        id: agentRunCallbacks.id,
        runId: agentRuns.id,
        status: agentRuns.status,
        error: agentRuns.error,
      })
      .from(wechatChatThreadRoutes)
      .innerJoin(
        agentRuns,
        eq(agentRuns.chatThreadId, wechatChatThreadRoutes.chatThreadId),
      )
      .innerJoin(agentRunCallbacks, eq(agentRunCallbacks.runId, agentRuns.id))
      .where(
        and(
          eq(wechatChatThreadRoutes.connectionId, connection.id),
          eq(agentRuns.orgId, connection.orgId),
          eq(agentRuns.userId, connection.userId),
          eq(agentRuns.triggerSource, "wechat"),
          inArray(agentRuns.status, ["completed", "failed", "cancelled"]),
          eq(agentRunCallbacks.internalKind, "chat"),
          inArray(agentRunCallbacks.status, ["pending", "failed"]),
          or(
            isNull(agentRunCallbacks.lastAttemptAt),
            lt(
              agentRunCallbacks.lastAttemptAt,
              new Date(nowDate().getTime() - 30_000),
            ),
          ),
        ),
      )
      .orderBy(asc(agentRunCallbacks.createdAt), asc(agentRunCallbacks.id))
      .limit(1);
    signal.throwIfAborted();
    if (!callback) {
      return;
    }
    // Replay also completes the source callback's remaining shared side effects.
    // The durable child and per-chunk receipts prevent duplicate provider sends.
    await set(
      dispatchRunCallbacks$,
      {
        runId: callback.runId,
        redriveChatCallbackId: callback.id,
        status: callback.status === "completed" ? "completed" : "failed",
        error:
          callback.status === "completed"
            ? undefined
            : callback.error ||
              (callback.status === "cancelled"
                ? "Run cancelled"
                : "Run failed"),
      },
      signal,
    );
  },
);
