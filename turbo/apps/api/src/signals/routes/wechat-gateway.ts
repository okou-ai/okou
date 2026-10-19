import { settle, safeJsonParse } from "../utils";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { wechatGatewayContract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { wechatConnections } from "@okouai/db/schema/wechat";
import {
  getWechatUpdates,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { verifyWechatGatewaySignature } from "../../lib/wechat-gateway-verification";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../services/crypto.utils";
import { wechatEnabled$ } from "../services/wechat-config";
import { recoverWechatChatDeliveries$ } from "../services/wechat-delivery-recovery.service";
import { processPendingBatch$ } from "../services/wechat-gateway-batch.service";
import type { RouteEntry } from "../route-entry";

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
    connection.workflowReceiver ||
    !(await set(wechatEnabled$, connection.orgId, connection.userId, signal))
  ) {
    return Response.json({ active: false });
  }

  if (connection.status === "active") {
    // Recovery belongs to this API invocation, independently of the receiver's
    // 80-second HTTP poll. Slow replies must not hold up incoming messages.
    waitUntil(
      set(
        recoverWechatChatDeliveries$,
        connection,
        AbortSignal.timeout(300_000),
      ),
    );
  }

  const live = and(
    eq(wechatConnections.id, connection.id),
    eq(wechatConnections.generation, connection.generation),
    eq(wechatConnections.status, connection.status),
    eq(wechatConnections.workflowReceiver, false),
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
    batchCiphertext = await encryptStoredSecretValue(
      JSON.stringify({ ...updates, retries: {} }),
    );
    signal.throwIfAborted();

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
