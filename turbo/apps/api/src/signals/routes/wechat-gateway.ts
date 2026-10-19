import { settle, safeJsonParse } from "../utils";
import { command } from "ccstate";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { wechatGatewayContract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { verifyWechatGatewaySignature } from "../../lib/wechat-gateway-verification";
import { request$ } from "../context/hono";
import { writeDb$ } from "../external/db";
import {
  getWechatUpdates,
  wechatUpdatesSchema,
  WechatSessionExpiredError,
  type WechatMessage,
} from "../external/wechat-client";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../services/crypto.utils";
import { wechatEnabled$ } from "../services/wechat-config";
import {
  receiveWechatMessage$,
  WechatIngressError,
} from "../services/wechat-ingress.service";
import { recoverWechatChatDeliveries$ } from "../services/wechat-delivery-recovery.service";
import {
  isWechatOwnerMessage,
  wechatEventId,
} from "../services/wechat-message-identity";
import { sendWechatNotice$ } from "../services/wechat-notice.service";
import type { RouteEntry } from "../route-entry";

const log = logger("api:wechat:gateway");
const MAX_INPUT_ATTEMPTS = 3;
// Stored only inside the encrypted pending batch, scoped to its binding generation.
const pendingBatchSchema = wechatUpdatesSchema.extend({
  retries: z
    .record(
      z.string(),
      z.object({
        failures: z.number().int().nonnegative(),
        nextAttemptAt: z.number(),
      }),
    )
    .default({}),
});

type InputRetry = z.infer<typeof pendingBatchSchema>["retries"][string];
type Connection = typeof wechatConnections.$inferSelect;
const receiveBatchInput$ = command(
  async (
    { set },
    args: {
      connection: Connection;
      message: WechatMessage;
      retry: InputRetry | undefined;
    },
    signal: AbortSignal,
  ): Promise<InputRetry | undefined> => {
    const { connection, message, retry } = args;
    if (!isWechatOwnerMessage(connection, message)) {
      return;
    }
    // A terminal notice is also the durable disposition of this input. Provider
    // redelivery must not reset its retry budget after the batch advances.
    const [terminal] = await set(writeDb$)
      .select({ id: wechatMessages.id })
      .from(wechatMessages)
      .where(
        eq(
          wechatMessages.id,
          wechatEventId(
            connection.id,
            connection.generation,
            `ingress-failed:${message.message_id}`,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (terminal) {
      return;
    }
    const notice = await settle(
      set(sendWechatNotice$, { connection, message }, signal),
      signal,
    );
    if (!notice.ok) {
      log.warn("WeChat notice failed", { error: notice.error });
    }
    if (connection.status !== "active") {
      return;
    }
    const received = await settle(
      set(receiveWechatMessage$, { connection, message }, signal),
      signal,
    );
    if (received.ok) {
      return;
    }
    const failures = (retry?.failures ?? 0) + 1;
    const retryable =
      !(received.error instanceof WechatIngressError) ||
      received.error.retryable;
    const retryPending = retryable && failures < MAX_INPUT_ATTEMPTS;
    log.warn("WeChat input failed", {
      connectionId: connection.id,
      messageId: message.message_id,
      failures,
      retryable: retryPending,
      error: received.error,
    });
    if (retryPending) {
      return {
        failures,
        nextAttemptAt: nowDate().getTime() + 1000 * 2 ** (failures - 1),
      };
    }
    const failure =
      received.error instanceof WechatIngressError &&
      received.error.reason === "default_agent_unavailable"
        ? "default_agent_unavailable"
        : "processing_failed";
    const notified = await settle(
      set(sendWechatNotice$, { connection, message, failure }, signal),
      signal,
    );
    if (!notified.ok) {
      log.warn("WeChat input failure notice failed", { error: notified.error });
    }
  },
);
const processPendingBatch$ = command(
  async (
    { set },
    args: { connection: Connection; batchCiphertext: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const { connection } = args;
    let { batchCiphertext } = args;
    const db = set(writeDb$);
    const live = and(
      eq(wechatConnections.id, connection.id),
      eq(wechatConnections.generation, connection.generation),
      eq(wechatConnections.status, connection.status),
    );
    const batch = pendingBatchSchema.parse(
      JSON.parse(await decryptStoredSecretValue(batchCiphertext)) as unknown,
    );

    let remaining = batch.msgs ?? [];
    for (const message of batch.msgs ?? []) {
      const retry = batch.retries[message.message_id];
      if (retry && retry.nextAttemptAt > nowDate().getTime()) {
        continue;
      }

      const nextRetry = await set(
        receiveBatchInput$,
        { connection, message, retry },
        signal,
      );
      const keep = nextRetry !== undefined;
      if (nextRetry) {
        batch.retries[message.message_id] = nextRetry;
      }
      if (!keep) {
        remaining = remaining.filter((pending) => {
          return pending.message_id !== message.message_id;
        });
        delete batch.retries[message.message_id];
      }
      // Checkpoint each outcome. A crash replays only unfinished inputs, while a
      // failed input never prevents later inputs in this batch from being admitted.
      const nextCiphertext = remaining.length
        ? await encryptStoredSecretValue(
            JSON.stringify({ ...batch, msgs: remaining }),
          )
        : null;
      const [saved] = await db
        .update(wechatConnections)
        .set({ pendingBatchCiphertext: nextCiphertext, updatedAt: nowDate() })
        .where(
          and(
            live,
            eq(wechatConnections.pendingBatchCiphertext, batchCiphertext),
          ),
        )
        .returning({ id: wechatConnections.id });
      signal.throwIfAborted();
      if (!saved || nextCiphertext === null) {
        return;
      }
      batchCiphertext = nextCiphertext;
    }
    if (!remaining.length) {
      await db
        .update(wechatConnections)
        .set({ pendingBatchCiphertext: null, updatedAt: nowDate() })
        .where(
          and(
            live,
            eq(wechatConnections.pendingBatchCiphertext, batchCiphertext),
          ),
        );
      signal.throwIfAborted();
    }
  },
);

const poll$ = command(async ({ get, set }, signal: AbortSignal) => {
  const req = get(request$);
  const secret = env("WECHAT_GATEWAY_SECRET");
  const raw = await req.text();

  signal.throwIfAborted();
  if (
    raw.length > 4096 ||
    !secret ||
    !verifyWechatGatewaySignature(
      secret,
      req.raw.headers.get("x-wechat-timestamp"),
      req.raw.headers.get("x-wechat-signature"),
      raw,
    )
  ) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid gateway request" } },
      { status: 401 },
    );
  }
  const parsed = wechatGatewayContract.poll.body.safeParse(safeJsonParse(raw));
  if (!parsed.success) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Invalid gateway body" } },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = set(writeDb$);

  const [connection] = await db
    .select()
    .from(wechatConnections)
    .where(eq(wechatConnections.id, body.connectionId))
    .limit(1);
  signal.throwIfAborted();

  if (
    !connection ||
    connection.status === "reconnect_required" ||
    !(await set(wechatEnabled$, connection.orgId, connection.userId, signal))
  ) {
    return Response.json({ active: false });
  }

  if (connection.status === "active") {
    await set(recoverWechatChatDeliveries$, connection, signal);
  }

  const live = and(
    eq(wechatConnections.id, connection.id),
    eq(wechatConnections.generation, connection.generation),
    eq(wechatConnections.status, connection.status),
  );
  let batchCiphertext = connection.pendingBatchCiphertext;
  if (!batchCiphertext) {
    const fetched = await settle(
      getWechatUpdates(
        connection.baseUrl,
        await decryptStoredSecretValue(connection.tokenCiphertext),
        connection.updatesCursor,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!fetched.ok) {
      if (!(fetched.error instanceof WechatSessionExpiredError)) {
        throw fetched.error;
      }
      if (connection.status === "disconnected") {
        await db.delete(wechatConnections).where(live);
      } else {
        await db
          .update(wechatConnections)
          .set({ status: "reconnect_required", updatedAt: nowDate() })
          .where(live);
      }
      signal.throwIfAborted();
      return Response.json({ active: false });
    }

    const updates = fetched.value;
    if (updates === null) {
      return Response.json({ active: true });
    }
    batchCiphertext = await encryptStoredSecretValue(JSON.stringify(updates));

    const [saved] = await db
      .update(wechatConnections)
      .set({
        pendingBatchCiphertext: batchCiphertext,
        updatesCursor: updates.get_updates_buf ?? connection.updatesCursor,
        updatedAt: nowDate(),
      })
      .where(
        and(
          live,
          isNull(wechatConnections.pendingBatchCiphertext),
          eq(wechatConnections.updatesCursor, connection.updatesCursor),
        ),
      )
      .returning({ id: wechatConnections.id });
    signal.throwIfAborted();
    if (!saved) {
      return Response.json({ active: true });
    }
  }
  await set(processPendingBatch$, { connection, batchCiphertext }, signal);
  return Response.json({ active: true });
});
export const wechatGatewayRoutes: readonly RouteEntry[] = [
  { route: wechatGatewayContract.poll, handler: poll$ },
];
