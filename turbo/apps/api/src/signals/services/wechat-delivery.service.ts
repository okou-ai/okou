import { createHash } from "node:crypto";
import { sendPreparedWechatText$ } from "./wechat-message-send.service";
import {
  requireWechatSendAccess$,
  type WechatSendAccess,
} from "./wechat-access.service";
import { recordWechatDeliveryPhase } from "./wechat-delivery-timing.service";
import { monotonicNow, nowDate } from "../../lib/time";
import { command } from "ccstate";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { object, string, uuid } from "zod";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { settle } from "../utils";
import {
  chatWechatContext,
  wechatConnections,
  wechatChatThreadRoutes,
} from "@okouai/db/schema/wechat";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { agents } from "@okouai/db/schema/agent";
import { writeDb$ } from "../external/db";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import {
  wechatDeliveryTargetSchema,
  type WechatDeliveryTarget,
} from "./wechat-chat-callback-payload";
import {
  resolveIntegrationAdmissionFailurePresentation$,
  resolveIntegrationAgentResponsePresentation$,
} from "./integration-agent-response-presentation.service";
interface WechatReplyRequest {
  readonly chatEventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: WechatDeliveryTarget;
  readonly content?: string;
  readonly deliveryCallbackId?: string;
}
export const sendWechatChatReply$ = command(
  async ({ set }, args: WechatReplyRequest, signal: AbortSignal) => {
    const prepareStartedAt = monotonicNow();
    const owner = {
      orgId: args.orgId,
      userId: args.userId,
      channelId: args.target.connectionId,
      generation: args.target.generation,
      contextId: args.target.contextId,
    };
    const initialAccess = await set(requireWechatSendAccess$, owner, signal);
    if (initialAccess.kind === "denied") {
      return;
    }
    const db = set(writeDb$);
    const [reply] = await db
      .select({
        agentId: agents.id,
        content: canonicalChatEventContent(),
        runId: chatEvents.runId,
      })
      .from(wechatConnections)
      .innerJoin(
        wechatChatThreadRoutes,
        and(
          eq(wechatChatThreadRoutes.connectionId, wechatConnections.id),
          eq(wechatChatThreadRoutes.chatThreadId, args.chatThreadId),
        ),
      )
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, wechatChatThreadRoutes.chatThreadId),
      )
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.id, args.chatEventId),
          eq(chatEvents.chatThreadId, chatThreads.id),
          chatEventTypeIn([
            "output.message",
            "output.error",
            "run.failed",
            "run.cancelled",
          ]),
        ),
      )
      .innerJoin(
        chatWechatContext,
        and(
          eq(chatWechatContext.connectionId, wechatConnections.id),
          eq(chatWechatContext.generation, wechatConnections.generation),
          eq(chatWechatContext.senderId, wechatConnections.senderId),
          eq(chatWechatContext.chatThreadId, args.chatThreadId),
        ),
      )
      .where(
        and(
          eq(wechatConnections.id, args.target.connectionId),
          eq(wechatConnections.generation, args.target.generation),
          eq(wechatConnections.senderId, args.target.senderId),
          eq(wechatConnections.orgId, args.orgId),
          eq(wechatConnections.userId, args.userId),
          eq(wechatConnections.status, "active"),
          eq(chatThreads.userId, args.userId),
          eq(agents.orgId, args.orgId),
          eq(chatWechatContext.id, args.target.contextId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!reply?.content) {
      return;
    }
    let content = args.content;
    if (content === undefined) {
      const presentationArgs = {
        orgId: args.orgId,
        agentId: reply.agentId,
      };
      const presentation =
        reply.runId === null
          ? await set(
              resolveIntegrationAdmissionFailurePresentation$,
              presentationArgs,
              signal,
            )
          : await set(
              resolveIntegrationAgentResponsePresentation$,
              { ...presentationArgs, runId: reply.runId },
              signal,
            );
      signal.throwIfAborted();
      content = presentation.footerText
        ? `${reply.content}\n\n${presentation.footerText}`
        : reply.content;
    }
    if (args.deliveryCallbackId) {
      const snapshot = await set(
        snapshotWechatReply$,
        { callbackId: args.deliveryCallbackId, content },
        signal,
      );
      if (snapshot === null) {
        return;
      }
      content = snapshot;
    }

    recordWechatDeliveryPhase({
      phase: "reply_prepare",
      inputEventId: args.target.contextId,
      chatThreadId: args.chatThreadId,
      operationId: args.chatEventId,
      runId: reply.runId ?? undefined,
      durationMs: monotonicNow() - prepareStartedAt,
      success: true,
    });
    return await set(
      sendWechatReplyChunks$,
      { ...args, content, runId: reply.runId },
      initialAccess,
      signal,
    );
  },
);

const sendWechatReplyChunks$ = command(
  async (
    { set },
    args: WechatReplyRequest & {
      readonly content: string;
      readonly runId: string | null;
    },
    initialAccess: WechatSendAccess & { readonly kind: "allowed" },
    signal: AbortSignal,
  ) => {
    const points = Array.from(args.content);
    const requestHash = createHash("sha256").update(args.content).digest("hex");
    const owner = {
      orgId: args.orgId,
      userId: args.userId,
      channelId: args.target.connectionId,
      generation: args.target.generation,
      contextId: args.target.contextId,
    };
    for (let offset = 0; offset < points.length; offset += 2000) {
      // A prior provider request is an authorization boundary for the next chunk.
      const access =
        offset === 0
          ? initialAccess
          : await set(requireWechatSendAccess$, owner, signal);
      if (access.kind === "denied") {
        throw new Error(access.response.body.error.message);
      }
      const result = await set(
        sendPreparedWechatText$,
        access,
        {
          operationId: args.chatEventId,
          runId: args.runId,
          index: offset / 2000,
          text: points.slice(offset, offset + 2000).join(""),
          requestHash,
        },
        signal,
      );
      if (result.kind === "denied") {
        // A recorded ambiguous send is terminal. Recovery must not resend it
        // or continue with later chunks after a gap in the reply.
        if (result.response.body.error.code === "WECHAT_DELIVERY_UNKNOWN") {
          return "unknown" as const;
        }
        throw new Error(result.response.body.error.message);
      }
    }
  },
);

const wechatReplyRequestSchema = object({
  content: string().optional(),
  chatEventId: uuid(),
  chatThreadId: uuid(),
  orgId: string(),
  userId: string(),
  target: wechatDeliveryTargetSchema,
});

const snapshotWechatReply$ = command(
  async (
    { set },
    args: { callbackId: string; content: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    // Labels changing during recovery must not change the operation hash/chunks.
    const [saved] = await set(writeDb$)
      .update(agentRunCallbacks)
      .set({
        payload: sql`jsonb_set(${agentRunCallbacks.payload}, '{content}', coalesce(${agentRunCallbacks.payload}->'content', to_jsonb(${args.content}::text)))`,
      })
      .where(
        and(
          eq(agentRunCallbacks.id, args.callbackId),
          eq(agentRunCallbacks.internalKind, "wechat:chat"),
          eq(agentRunCallbacks.status, "pending"),
        ),
      )
      .returning({ payload: agentRunCallbacks.payload });
    signal.throwIfAborted();
    return saved
      ? object({ content: string() }).parse(saved.payload).content
      : null;
  },
);

/** The source chat callback owns retries until this durable delivery settles. */
export const dispatchWechatChatDelivery$ = command(
  async ({ set }, callbackId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const attemptedAt = nowDate();
    const [callback] = await db
      .update(agentRunCallbacks)
      .set({
        attempts: sql`${agentRunCallbacks.attempts} + 1`,
        lastAttemptAt: attemptedAt,
      })
      .where(
        and(
          eq(agentRunCallbacks.id, callbackId),
          eq(agentRunCallbacks.internalKind, "wechat:chat"),
          eq(agentRunCallbacks.status, "pending"),
          // vite.config.ts limits each API invocation to 300 seconds. Keep the
          // existing attempt exclusive until its owner must have finished;
          // one 40-second provider timeout does not bound a multi-chunk reply.
          or(
            isNull(agentRunCallbacks.lastAttemptAt),
            lt(
              agentRunCallbacks.lastAttemptAt,
              new Date(attemptedAt.getTime() - 300_000),
            ),
          ),
        ),
      )
      .returning({
        payload: agentRunCallbacks.payload,
        attempts: agentRunCallbacks.attempts,
      });
    signal.throwIfAborted();
    if (!callback) {
      const [current] = await db
        .select({ status: agentRunCallbacks.status })
        .from(agentRunCallbacks)
        .where(eq(agentRunCallbacks.id, callbackId))
        .limit(1);
      signal.throwIfAborted();
      if (current?.status === "pending") {
        throw new Error("WeChat reply delivery is already in progress");
      }
      return;
    }

    // Pre-send failures propagate to the source callback's existing recovery.
    // Confirmed chunks are read from their receipts; unknown chunks are final.
    const delivery = await settle(
      set(
        sendWechatChatReply$,
        {
          ...wechatReplyRequestSchema.parse(callback.payload),
          deliveryCallbackId: callbackId,
        },
        signal,
      ),
      signal,
    );
    const owned = and(
      eq(agentRunCallbacks.id, callbackId),
      eq(agentRunCallbacks.status, "pending"),
      eq(agentRunCallbacks.attempts, callback.attempts),
    );
    if (!delivery.ok) {
      // Release only this attempt after a known failure. A lost invocation
      // remains pending until its enforced runtime limit has passed.
      await db
        .update(agentRunCallbacks)
        .set({ lastAttemptAt: null })
        .where(owned);
      signal.throwIfAborted();
      throw delivery.error;
    }
    await db
      .update(agentRunCallbacks)
      .set(
        delivery.value === "unknown"
          ? { status: "failed", lastError: "WECHAT_DELIVERY_UNKNOWN" }
          : { status: "delivered", deliveredAt: nowDate(), lastError: null },
      )
      .where(owned);
    signal.throwIfAborted();
  },
);
