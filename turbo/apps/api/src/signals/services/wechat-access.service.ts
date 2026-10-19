import { command } from "ccstate";
import { and, desc, eq, ne } from "drizzle-orm";
import { chatWechatContext, wechatConnections } from "@okouai/db/schema/wechat";
import { writeDb$ } from "../external/db";
import { wechatEnabled$ } from "./wechat-config";
import { decryptStoredSecretValue } from "./crypto.utils";
import { notFound, resourceUnavailable } from "../../lib/error";

export interface WechatOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly channelId: string;
}

export interface WechatSendAccess {
  readonly connection: typeof wechatConnections.$inferSelect;
  readonly contextId: string;
  readonly token: string;
  readonly contextToken: string;
}

/** Recheck the mutable binding without repeating this send's membership lookup. */
export const requireLiveWechatSendConnection$ = command(
  async (
    { set },
    connection: WechatSendAccess["connection"],
    signal: AbortSignal,
  ) => {
    const [live] = await set(writeDb$)
      .select({ id: wechatConnections.id })
      .from(wechatConnections)
      .where(
        and(
          eq(wechatConnections.id, connection.id),
          eq(wechatConnections.orgId, connection.orgId),
          eq(wechatConnections.userId, connection.userId),
          eq(wechatConnections.generation, connection.generation),
          eq(wechatConnections.senderId, connection.senderId),
          eq(wechatConnections.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return live
      ? ({ kind: "allowed" } as const)
      : ({
          kind: "denied",
          response: notFound("This WeChat connection changed before sending."),
        } as const);
  },
);

export const requireWechatConnection$ = command(
  async ({ set }, args: WechatOwner, signal: AbortSignal) => {
    if (!(await set(wechatEnabled$, args.orgId, args.userId, signal))) {
      return {
        kind: "denied",
        response: resourceUnavailable(
          "WeChat is not available for this workspace member.",
        ),
      } as const;
    }
    const [connection] = await set(writeDb$)
      .select()
      .from(wechatConnections)
      .where(
        and(
          eq(wechatConnections.id, args.channelId),
          eq(wechatConnections.orgId, args.orgId),
          eq(wechatConnections.userId, args.userId),
          ne(wechatConnections.status, "disconnected"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return connection
      ? ({ kind: "allowed", connection } as const)
      : ({
          kind: "denied",
          response: notFound(
            "This WeChat conversation is unavailable. Use okou wechat connect to connect from Works.",
          ),
        } as const);
  },
);

export const requireWechatSendAccess$ = command(
  async (
    { set },
    args: WechatOwner & {
      readonly generation?: string;
      readonly contextId?: string;
    },
    signal: AbortSignal,
  ) => {
    const access = await set(requireWechatConnection$, args, signal);
    if (access.kind === "denied") {
      return access;
    }
    const { connection } = access;
    if (
      connection.status !== "active" ||
      (args.generation !== undefined &&
        args.generation !== connection.generation)
    ) {
      return {
        kind: "denied",
        response: notFound("Reconnect WeChat from Works before sending."),
      } as const;
    }
    const [context] = await set(writeDb$)
      .select({
        id: chatWechatContext.id,
        ciphertext: chatWechatContext.contextTokenCiphertext,
      })
      .from(chatWechatContext)
      .where(
        and(
          eq(chatWechatContext.connectionId, connection.id),
          eq(chatWechatContext.generation, connection.generation),
          eq(chatWechatContext.senderId, connection.senderId),
          args.contextId === undefined
            ? undefined
            : eq(chatWechatContext.id, args.contextId),
        ),
      )
      .orderBy(desc(chatWechatContext.createdAt), desc(chatWechatContext.id))
      .limit(1);
    signal.throwIfAborted();
    if (!context) {
      return {
        kind: "denied",
        response: notFound(
          "Send a message to Okou in WeChat before using message send.",
        ),
      } as const;
    }
    const [token, contextToken] = await Promise.all([
      decryptStoredSecretValue(connection.tokenCiphertext),
      decryptStoredSecretValue(context.ciphertext),
    ]);
    signal.throwIfAborted();
    const live = await set(
      requireLiveWechatSendConnection$,
      connection,
      signal,
    );
    if (live.kind === "denied") {
      return live;
    }
    return {
      kind: "allowed",
      connection,
      contextId: context.id,
      token,
      contextToken,
    } as const satisfies WechatSendAccess & { readonly kind: "allowed" };
  },
);
