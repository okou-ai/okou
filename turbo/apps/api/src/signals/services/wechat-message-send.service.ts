import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import type { WechatReceipt } from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import { writeDb$ } from "../external/db";
import {
  sendWechatText,
  WechatSessionExpiredError,
} from "../external/wechat-client";
import { settle } from "../utils";
import { conflict } from "../../lib/error";
import { nowDate } from "../../lib/time";
import {
  requireWechatSendAccess$,
  type WechatOwner,
} from "./wechat-access.service";
import { wechatEventId } from "./wechat-message-identity";

export const sendArchivedWechatText$ = command(
  async (
    { set },
    args: WechatOwner & {
      readonly operationId: string;
      readonly index: number;
      readonly text: string;
      readonly requestHash: string;
      readonly generation?: string;
      readonly contextId?: string;
    },
    signal: AbortSignal,
  ) => {
    const access = await set(requireWechatSendAccess$, args, signal);
    if (access.kind === "denied") return access;
    const db = set(writeDb$);
    // Identity survives reconnects: repeating an operation cannot resend earlier chunks.
    const id = wechatEventId(
      args.channelId,
      args.operationId,
      `outbound:${args.index}`,
    );
    const [claimed] = await db
      .insert(wechatMessages)
      .values({
        id,
        connectionId: args.channelId,
        generation: access.connection.generation,
        direction: "outbound",
        status: "unknown",
        content: args.text,
        requestHash: args.requestHash,
        createdAt: nowDate(),
      })
      .onConflictDoNothing()
      .returning({ id: wechatMessages.id });
    signal.throwIfAborted();
    if (!claimed) {
      const [existing] = await db
        .select({
          content: wechatMessages.content,
          requestHash: wechatMessages.requestHash,
          status: wechatMessages.status,
          providerMessageId: wechatMessages.providerMessageId,
        })
        .from(wechatMessages)
        .where(
          and(
            eq(wechatMessages.id, id),
            eq(wechatMessages.connectionId, args.channelId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (
        !existing ||
        existing.content !== args.text ||
        existing.requestHash !== args.requestHash
      ) {
        return {
          kind: "denied",
          response: conflict("This operation ID was used for another message."),
        } as const;
      }
      if (existing.status !== "sent") {
        return {
          kind: "denied",
          response: {
            ...conflict(
              "WeChat has not confirmed this message. It was not sent again. Check history before starting another operation.",
            ),
            body: {
              error: {
                code: "WECHAT_DELIVERY_UNKNOWN",
                message:
                  "WeChat has not confirmed this message. It was not sent again.",
                uncertainMessageId: id,
              },
            },
          },
        } as const;
      }
      return {
        kind: "sent",
        message: {
          id,
          channelId: args.channelId,
          providerMessageId: existing.providerMessageId,
          url: null,
        } satisfies WechatReceipt,
      } as const;
    }
    // An ambiguous transport outcome leaves the durable claim in unknown state.
    const live = await set(
      requireWechatSendAccess$,
      { ...args, generation: access.connection.generation },
      signal,
    );
    if (live.kind === "denied") return live;
    const result = await settle(
      sendWechatText(
        {
          baseUrl: live.connection.baseUrl,
          token: live.token,
          contextToken: live.contextToken,
          senderId: live.connection.senderId,
          clientId: `okou-${id}`,
          text: args.text,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof WechatSessionExpiredError) {
        await db
          .update(wechatConnections)
          .set({ status: "reconnect_required", updatedAt: nowDate() })
          .where(
            and(
              eq(wechatConnections.id, args.channelId),
              eq(wechatConnections.generation, live.connection.generation),
            ),
          );
        signal.throwIfAborted();
      }
      return {
        kind: "denied",
        response: {
          status: 502,
          body: {
            error: {
              code: "WECHAT_DELIVERY_UNKNOWN",
              message:
                "WeChat did not confirm delivery. Do not blindly resend this operation.",
              uncertainMessageId: id,
            },
          },
        },
      } as const;
    }
    const providerMessageId = result.value.message_id ?? null;
    await db
      .update(wechatMessages)
      .set({ status: "sent", providerMessageId })
      .where(eq(wechatMessages.id, id));
    signal.throwIfAborted();
    return {
      kind: "sent",
      message: {
        id,
        channelId: args.channelId,
        providerMessageId,
        url: null,
      } satisfies WechatReceipt,
    } as const;
  },
);
