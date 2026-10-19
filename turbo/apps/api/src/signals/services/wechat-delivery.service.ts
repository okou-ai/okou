import { createHash } from "node:crypto";
import { sendPreparedWechatText$ } from "./wechat-message-send.service";
import { requireWechatSendAccess$ } from "./wechat-access.service";
import { recordWechatDeliveryPhase } from "./wechat-delivery-timing.service";
import { monotonicNow } from "../../lib/time";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
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
import type { WechatDeliveryTarget } from "./wechat-chat-callback-payload";
import {
  resolveIntegrationAdmissionFailurePresentation,
  resolveIntegrationAgentResponsePresentation,
} from "./integration-agent-response-presentation.service";
export interface WechatReplyRequest {
  readonly chatEventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: WechatDeliveryTarget;
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
    const presentationArgs = {
      db,
      orgId: args.orgId,
      agentId: reply.agentId,
    };
    const presentation =
      reply.runId === null
        ? await resolveIntegrationAdmissionFailurePresentation(
            presentationArgs,
            signal,
          )
        : await resolveIntegrationAgentResponsePresentation(
            { ...presentationArgs, runId: reply.runId },
            signal,
          );
    signal.throwIfAborted();
    const content = presentation.footerText
      ? `${reply.content}\n\n${presentation.footerText}`
      : reply.content;
    const points = Array.from(content);
    const requestHash = createHash("sha256").update(content).digest("hex");
    recordWechatDeliveryPhase({
      phase: "reply_prepare",
      inputEventId: args.target.contextId,
      chatThreadId: args.chatThreadId,
      operationId: args.chatEventId,
      runId: reply.runId ?? undefined,
      durationMs: monotonicNow() - prepareStartedAt,
      success: true,
    });
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
          runId: reply.runId,
          index: offset / 2000,
          text: points.slice(offset, offset + 2000).join(""),
          requestHash,
        },
        signal,
      );
      if (result.kind === "denied") {
        throw new Error(result.response.body.error.message);
      }
    }
  },
);
