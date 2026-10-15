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
import { db$ } from "../external/db";
import { sendWechatText } from "../external/wechat-client";
import { decryptStoredSecretValue } from "./crypto.utils";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { wechatEnabled$ } from "./wechat-config";
import type { WechatDeliveryTarget } from "./wechat-chat-callback-payload";
export interface WechatReplyRequest {
  readonly chatEventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: WechatDeliveryTarget;
}
export const sendWechatChatReply$ = command(
  async ({ get, set }, args: WechatReplyRequest, signal: AbortSignal) => {
    if (!(await set(wechatEnabled$, args.orgId, args.userId, signal))) {
      return;
    }
    const db = get(db$);
    const [binding] = await db
      .select({
        baseUrl: wechatConnections.baseUrl,
        token: wechatConnections.tokenCiphertext,
        contextToken: chatWechatContext.contextTokenCiphertext,
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
      .select({ content: canonicalChatEventContent() })
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
    const token = await decryptStoredSecretValue(binding.token);
    signal.throwIfAborted();
    const contextToken = await decryptStoredSecretValue(binding.contextToken);
    signal.throwIfAborted();
    // A stable client ID is supplied, but Tencent does not document an exactly-once
    // guarantee. As with Discord, ambiguous network failures are not blindly replayed.
    const parts = Array.from(event.content);
    const size = 2000;
    for (let offset = 0; offset < parts.length; offset += size) {
      // Recheck revocation between chunks, including while KMS/network was in flight.
      const [live] = await db
        .select({ id: wechatConnections.id })
        .from(wechatConnections)
        .where(
          and(
            eq(wechatConnections.id, args.target.connectionId),
            eq(wechatConnections.generation, args.target.generation),
            eq(wechatConnections.status, "active"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!live) {
        return;
      }
      await sendWechatText(
        {
          baseUrl: binding.baseUrl,
          token,
          contextToken,
          senderId: args.target.senderId,
          clientId: `okou-${args.chatEventId}-${offset / size}`,
          text: parts.slice(offset, offset + size).join(""),
        },
        signal,
      );
    }
  },
);
