import { settle, safeJsonParse } from "../utils";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { wechatGatewayContract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { wechatConnections } from "@okouai/db/schema/wechat";
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
} from "../external/wechat-client";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../services/crypto.utils";
import { wechatEnabled$ } from "../services/wechat-config";
import { receiveWechatMessage$ } from "../services/wechat-ingress.service";
import { sendWechatNotice$ } from "../services/wechat-notice.service";
import type { RouteEntry } from "../route-entry";

const log = logger("api:wechat:gateway");

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
      req.header("x-wechat-timestamp") ?? null,
      req.header("x-wechat-signature") ?? null,
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
  const batch = wechatUpdatesSchema.parse(
    JSON.parse(await decryptStoredSecretValue(batchCiphertext)) as unknown,
  );

  for (const message of batch.msgs ?? []) {
    // A notice failure must not block a user's prompt or replay an ambiguous send.
    const notice = await settle(
      set(sendWechatNotice$, { connection, message }, signal),
      signal,
    );
    if (!notice.ok) {
      log.warn("WeChat notice failed", { error: notice.error });
    }
    if (connection.status === "active") {
      await set(receiveWechatMessage$, { connection, message }, signal);
    }
  }
  await db
    .update(wechatConnections)
    .set({ pendingBatchCiphertext: null, updatedAt: nowDate() })
    .where(
      and(live, eq(wechatConnections.pendingBatchCiphertext, batchCiphertext)),
    );
  signal.throwIfAborted();
  return Response.json({ active: true });
});
export const wechatGatewayRoutes: readonly RouteEntry[] = [
  { route: wechatGatewayContract.poll, handler: poll$ },
];
