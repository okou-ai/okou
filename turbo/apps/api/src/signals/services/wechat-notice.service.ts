import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { object, uuid } from "zod";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import {
  sendWechatText,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
import { decryptStoredSecretValue } from "./crypto.utils";
import { wechatEnabled$ } from "./wechat-config";
import { isWechatOwnerMessage, wechatEventId } from "./wechat-message-identity";
import { settle } from "../utils";
import { buildWechatConnectUrl } from "./wechat-connect-token";

type Connection = typeof wechatConnections.$inferSelect;

/** Claim before sending: failed or ambiguous system notices are never retried. */
const sendNotice$ = command(
  async (
    { set },
    args: {
      readonly connection: Connection;
      readonly id: string;
      readonly text: string;
      readonly contextToken?: string;
    },
    signal: AbortSignal,
  ) => {
    const { connection, id, text } = args;
    const disconnected = connection.status === "disconnected";
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
    const rowSchema = object({ id: uuid() });
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
          contextToken: args.contextToken,
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

/** Connection completion tries once without waiting for an incoming context. */
export const sendWechatWelcome$ = command(
  async (
    { set },
    connectionId: string,
    generation: string,
    signal: AbortSignal,
  ) => {
    const [connection] = await set(writeDb$)
      .select()
      .from(wechatConnections)
      .where(
        and(
          eq(wechatConnections.id, connectionId),
          eq(wechatConnections.generation, generation),
          eq(wechatConnections.status, "active"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return;
    }
    await set(
      sendNotice$,
      {
        connection,
        id: wechatEventId(connectionId, generation, "welcome"),
        text: `Hi! I'm ${BRAND_PRESENTATION.assistantName}. You're connected to your workspace's agent.\n\nJust describe what you need help with to get started.`,
      },
      signal,
    );
  },
);

/** Only the verified owner can receive a reconnect link on the retained transport. */
export const sendWechatReconnectNotice$ = command(
  async (
    { set },
    args: { readonly connection: Connection; readonly message: WechatMessage },
    signal: AbortSignal,
  ) => {
    const { connection, message } = args;
    if (
      connection.status !== "disconnected" ||
      !isWechatOwnerMessage(connection, message)
    ) {
      return;
    }
    await set(
      sendNotice$,
      {
        connection,
        id: wechatEventId(
          connection.id,
          connection.generation,
          `reconnect:${message.message_id}`,
        ),
        text: `Your WeChat account isn't connected to ${BRAND_PRESENTATION.assistantName}. Connect your account to start chatting:\n${buildWechatConnectUrl(connection.id, connection.generation)}`,
        contextToken: message.context_token,
      },
      signal,
    );
  },
);

/** A terminal input notice also records the disposition across redelivery. */
export const sendWechatInputFailureNotice$ = command(
  async (
    { set },
    args: {
      readonly connection: Connection;
      readonly message: WechatMessage;
      readonly failure: "default_agent_unavailable" | "processing_failed";
    },
    signal: AbortSignal,
  ) => {
    const { connection, message, failure } = args;
    if (
      connection.status !== "active" ||
      !isWechatOwnerMessage(connection, message)
    ) {
      return;
    }
    await set(
      sendNotice$,
      {
        connection,
        id: wechatEventId(
          connection.id,
          connection.generation,
          `ingress-failed:${message.message_id}`,
        ),
        text:
          failure === "default_agent_unavailable"
            ? `Your workspace's agent is unavailable. Ask a workspace admin to configure it in ${BRAND_PRESENTATION.assistantName}, then send your message again.`
            : "I couldn't process this message after retrying. Please send it again. If it includes a file, try sending the text separately.",
        contextToken: message.context_token,
      },
      signal,
    );
  },
);
