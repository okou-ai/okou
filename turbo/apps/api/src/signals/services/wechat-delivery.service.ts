import { createHash } from "node:crypto";
import { sendArchivedWechatText$ } from "./wechat-message-send.service";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  chatWechatContext,
  wechatConnections,
  wechatChatThreadRoutes,
} from "@okouai/db/schema/wechat";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { agents } from "@okouai/db/schema/agent";
import { db$, writeDb$ } from "../external/db";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { wechatEnabled$ } from "./wechat-config";
import {
  wechatDeliveryTargetSchema,
  type WechatDeliveryTarget,
} from "./wechat-chat-callback-payload";
import {
  resolveIntegrationAdmissionFailurePresentation,
  resolveIntegrationAgentResponsePresentation,
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
    if (!(await set(wechatEnabled$, args.orgId, args.userId, signal))) {
      return;
    }
    const db = set(writeDb$);
    const [binding] = await db
      .select({
        id: wechatConnections.id,
        agentId: agents.id,
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
    if (!binding) {
      return;
    }
    const [event] = await db
      .select({
        content: canonicalChatEventContent(),
        runId: chatEvents.runId,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.chatEventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          chatEventTypeIn([
            "output.message",
            "output.error",
            "run.failed",
            "run.cancelled",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!event?.content) {
      return;
    }
    let content =
      args.content ??
      (await set(
        renderWechatReply$,
        {
          orgId: args.orgId,
          agentId: binding.agentId,
          runId: event.runId,
          content: event.content,
        },
        signal,
      ));
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

    const points = Array.from(content);
    const requestHash = createHash("sha256").update(content).digest("hex");
    for (let offset = 0; offset < points.length; offset += 2000) {
      const result = await set(
        sendArchivedWechatText$,
        {
          orgId: args.orgId,
          userId: args.userId,
          channelId: args.target.connectionId,
          generation: args.target.generation,
          contextId: args.target.contextId,
          operationId: args.chatEventId,
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

const renderWechatReply$ = command(
  async (
    { get },
    args: {
      orgId: string;
      agentId: string;
      runId: string | null;
      content: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const presentationArgs = {
      db: get(db$),
      orgId: args.orgId,
      agentId: args.agentId,
    };
    const presentation =
      args.runId === null
        ? await resolveIntegrationAdmissionFailurePresentation(
            presentationArgs,
            signal,
          )
        : await resolveIntegrationAgentResponsePresentation(
            { ...presentationArgs, runId: args.runId },
            signal,
          );
    signal.throwIfAborted();
    return presentation.footerText
      ? `${args.content}\n\n${presentation.footerText}`
      : args.content;
  },
);

const wechatReplyRequestSchema = z.object({
  content: z.string().optional(),
  chatEventId: z.uuid(),
  chatThreadId: z.uuid(),
  orgId: z.string(),
  userId: z.string(),
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
      ? z.object({ content: z.string() }).parse(saved.payload).content
      : null;
  },
);

function deliveryLeaseAvailable() {
  return sql`(${agentRunCallbacks.payload}->>'leaseExpiresAt' IS NULL OR (${agentRunCallbacks.payload}->>'leaseExpiresAt')::timestamptz <= ${nowDate()})`;
}

/** The source chat callback owns retries until this durable delivery settles. */
export const dispatchWechatChatDelivery$ = command(
  async ({ set }, callbackId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const leaseExpiresAt = new Date(nowDate().getTime() + 90_000).toISOString();
    const [callback] = await db
      .update(agentRunCallbacks)
      .set({
        attempts: sql`${agentRunCallbacks.attempts} + 1`,
        lastAttemptAt: nowDate(),
        payload: sql`jsonb_set(${agentRunCallbacks.payload}, '{leaseExpiresAt}', to_jsonb(${leaseExpiresAt}::text))`,
      })
      .where(
        and(
          eq(agentRunCallbacks.id, callbackId),
          eq(agentRunCallbacks.internalKind, "wechat:chat"),
          eq(agentRunCallbacks.status, "pending"),
          deliveryLeaseAvailable(),
        ),
      )
      .returning({ payload: agentRunCallbacks.payload });
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
      sql`${agentRunCallbacks.payload}->>'leaseExpiresAt' = ${leaseExpiresAt}`,
    );
    if (!delivery.ok) {
      // Release only our claim. A crash leaves the lease to expire; a known
      // failure allows the runner to retry immediately without another send claim.
      await db
        .update(agentRunCallbacks)
        .set({ payload: sql`${agentRunCallbacks.payload} - 'leaseExpiresAt'` })
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
