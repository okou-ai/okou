import { command } from "ccstate";
import { and, eq, exists, inArray, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { object } from "zod";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatWechatContext,
  wechatChatThreadRoutes,
  wechatConnections,
} from "@okouai/db/schema/wechat";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import {
  getWechatTypingTicket,
  sendWechatTyping,
} from "@okouai/core/wechat-client";
import { settle } from "../utils";
import { chatEventTypeIn } from "./chat-event-type.service";
import { internalRunCallbackKindForRecord } from "./internal-run-callback";
import { requireWechatSendAccess$ } from "./wechat-access.service";
import {
  wechatDeliveryTargetSchema,
  type WechatDeliveryTarget,
} from "./wechat-chat-callback-payload";

const L = logger("WechatThreadTyping");
const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
const queueEventRevoker = alias(chatEvents, "wechat_typing_event_revoker");
const typingPayloadSchema = object({
  wechatDelivery: wechatDeliveryTargetSchema,
});

// Tencent's reference client refreshes typing every five seconds.
export const WECHAT_TYPING_REFRESH_INTERVAL_SECONDS = 5;

interface WechatThreadTypingTarget {
  readonly chatThreadId: string;
  readonly target: WechatDeliveryTarget;
}

// Like Slack, derive status from one snapshot of queued inputs and active runs.
// A late progress callback must not revive finished work or clear a newer run.
const wechatThreadHasOutstandingWork$ = command(
  async ({ set }, args: WechatThreadTypingTarget, signal: AbortSignal) => {
    const db = set(writeDb$);
    const activeRun = db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, chatEvents.runId),
          eq(agentRuns.chatThreadId, args.chatThreadId),
          eq(agentRuns.triggerSource, "wechat"),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
    const [work] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .innerJoin(
        chatWechatContext,
        eq(chatWechatContext.id, chatEvents.contextId),
      )
      .where(
        and(
          eq(chatEvents.chatThreadId, args.chatThreadId),
          eq(chatEvents.contextType, "wechat"),
          chatEventTypeIn(["input.prompt"]),
          eq(chatWechatContext.connectionId, args.target.connectionId),
          eq(chatWechatContext.generation, args.target.generation),
          or(
            and(
              isNull(chatEvents.runId),
              notExists(
                db
                  .select({ id: queueEventRevoker.id })
                  .from(queueEventRevoker)
                  .where(eq(queueEventRevoker.revokesEventId, chatEvents.id)),
              ),
            ),
            exists(activeRun),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return work !== undefined;
  },
);

const syncWechatThreadTyping$ = command(
  async ({ set }, args: WechatThreadTypingTarget, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [binding] = await db
      .select({
        orgId: wechatConnections.orgId,
        userId: wechatConnections.userId,
      })
      .from(wechatConnections)
      .innerJoin(
        wechatChatThreadRoutes,
        eq(wechatChatThreadRoutes.connectionId, wechatConnections.id),
      )
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, wechatChatThreadRoutes.chatThreadId),
      )
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .innerJoin(
        chatWechatContext,
        and(
          eq(chatWechatContext.connectionId, wechatConnections.id),
          eq(chatWechatContext.generation, wechatConnections.generation),
          eq(chatWechatContext.senderId, wechatConnections.senderId),
          eq(chatWechatContext.chatThreadId, chatThreads.id),
        ),
      )
      .where(
        and(
          eq(wechatConnections.id, args.target.connectionId),
          eq(wechatConnections.generation, args.target.generation),
          eq(wechatConnections.senderId, args.target.senderId),
          eq(wechatConnections.status, "active"),
          eq(chatThreads.id, args.chatThreadId),
          eq(chatThreads.userId, wechatConnections.userId),
          eq(agents.orgId, wechatConnections.orgId),
          eq(chatWechatContext.id, args.target.contextId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!binding) {
      return;
    }
    const owner = {
      ...binding,
      channelId: args.target.connectionId,
      generation: args.target.generation,
      contextId: args.target.contextId,
    };
    const access = await set(requireWechatSendAccess$, owner, signal);
    if (access.kind === "denied") {
      return;
    }
    const typingTicket = await getWechatTypingTicket(
      {
        baseUrl: access.connection.baseUrl,
        token: access.token,
        senderId: access.connection.senderId,
        contextToken: access.contextToken,
      },
      signal,
    );
    if (!typingTicket) {
      return;
    }
    let active = await set(wechatThreadHasOutstandingWork$, args, signal);
    while (true) {
      // Config reads and provider requests may overlap disconnect or completion.
      const live = await set(requireWechatSendAccess$, owner, signal);
      if (live.kind === "denied") {
        return;
      }
      await sendWechatTyping(
        {
          baseUrl: live.connection.baseUrl,
          token: live.token,
          senderId: live.connection.senderId,
          typingTicket,
          status: active ? 1 : 2,
        },
        signal,
      );
      const desired = await set(wechatThreadHasOutstandingWork$, args, signal);
      if (desired === active) {
        return;
      }
      active = desired;
    }
  },
);

/** Cosmetic status failures must never block message admission or delivery. */
export const reconcileWechatThreadTyping$ = command(
  async ({ set }, args: WechatThreadTypingTarget, signal: AbortSignal) => {
    const result = await settle(
      set(syncWechatThreadTyping$, args, signal),
      signal,
    );
    if (!result.ok) {
      L.warn("Failed to reconcile WeChat typing", {
        chatThreadId: args.chatThreadId,
        error: result.error,
      });
    }
  },
);

export const hasWechatTypingTargetForRun$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const callbacks = await set(writeDb$)
      .select({
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.status, "pending"),
          eq(agentRuns.triggerSource, "wechat"),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
    signal.throwIfAborted();
    return callbacks.some((callback) => {
      return (
        internalRunCallbackKindForRecord(callback) === "chat" &&
        typingPayloadSchema.safeParse(callback.payload).success
      );
    });
  },
);
