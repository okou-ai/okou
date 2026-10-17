import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  sendWechatText,
  WechatSessionExpiredError,
  type WechatMessage,
} from "../external/wechat-client";
import { decryptStoredSecretValue } from "./crypto.utils";
import { wechatEnabled$ } from "./wechat-config";
import { isWechatOwnerMessage, wechatEventId } from "./wechat-message-identity";
import { settle } from "../utils";

type Connection = typeof wechatConnections.$inferSelect;

/** System notices use the verified incoming context, never an agent send grant. */
export const sendWechatNotice$ = command(
  async (
    { set },
    args: {
      readonly connection: Connection;
      readonly message: WechatMessage;
    },
    signal: AbortSignal,
  ) => {
    const { connection, message } = args;
    if (
      !isWechatOwnerMessage(connection, message) ||
      connection.status === "reconnect_required"
    ) {
      return;
    }
    const disconnected = connection.status === "disconnected";
    const { assistantName } = BRAND_PRESENTATION;
    const text = disconnected
      ? `Your WeChat account isn't connected to ${assistantName}. Connect your account to start chatting:\n${new URL("/works", env("APP_URL")).toString()}`
      : `Hi! I'm ${assistantName}. You're connected to your workspace's agent.\n\nJust describe what you need help with to get started.`;
    const id = wechatEventId(
      connection.id,
      connection.generation,
      disconnected ? `reconnect:${message.message_id}` : "welcome",
    );
    const live = and(
      eq(wechatConnections.id, connection.id),
      eq(wechatConnections.generation, connection.generation),
      eq(wechatConnections.status, connection.status),
    );
    const db = set(writeDb$);
    // One welcome per binding, or one reconnect reply per incoming message.
    // Claim before the provider call: an ambiguous result must never be resent.
    const noticeClaimQuery = sql`INSERT INTO ${wechatMessages} (id,connection_id,generation,direction,status,content)
        SELECT ${id}::uuid,id,generation,'outbound','unknown',${text}
        FROM ${wechatConnections} WHERE ${live}
        ON CONFLICT (id) DO NOTHING RETURNING id`;
    const rowSchema = z.object({ id: z.uuid() });
    const [claimed] = await (async () => {
      return parseRawRows(rowSchema, await db.execute(noticeClaimQuery));
    })();
    signal.throwIfAborted();
    if (!claimed) {
      return;
    }
    const token = await decryptStoredSecretValue(connection.tokenCiphertext);
    signal.throwIfAborted();
    if (
      !(await set(wechatEnabled$, connection.orgId, connection.userId, signal))
    ) {
      return;
    }
    const [current] = await db
      .select({ id: wechatConnections.id })
      .from(wechatConnections)
      .where(live)
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      return;
    }
    const sent = await settle(
      sendWechatText(
        {
          baseUrl: connection.baseUrl,
          token,
          senderId: connection.senderId,
          contextToken: message.context_token,
          clientId: `okou-${id}`,
          text,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!sent.ok) {
      if (sent.error instanceof WechatSessionExpiredError) {
        if (disconnected) {
          await db.delete(wechatConnections).where(live);
        } else {
          await db
            .update(wechatConnections)
            .set({ status: "reconnect_required", updatedAt: nowDate() })
            .where(live);
        }
        signal.throwIfAborted();
      }
      throw sent.error;
    }
    await db
      .update(wechatMessages)
      .set({ status: "sent", providerMessageId: sent.value.message_id ?? null })
      .where(eq(wechatMessages.id, id));
    signal.throwIfAborted();
  },
);
