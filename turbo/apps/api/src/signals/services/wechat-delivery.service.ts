import { createHash } from "node:crypto";
import { sendArchivedWechatText$ } from "./wechat-message-send.service";
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
import { wechatEnabled$ } from "./wechat-config";
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
    const presentationArgs = {
      db,
      orgId: args.orgId,
      agentId: binding.agentId,
    };
    const presentation =
      event.runId === null
        ? await resolveIntegrationAdmissionFailurePresentation(
            presentationArgs,
            signal,
          )
        : await resolveIntegrationAgentResponsePresentation(
            { ...presentationArgs, runId: event.runId },
            signal,
          );
    signal.throwIfAborted();
    const content = presentation.footerText
      ? `${event.content}\n\n${presentation.footerText}`
      : event.content;
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
        throw new Error(result.response.body.error.message);
      }
    }
  },
);
