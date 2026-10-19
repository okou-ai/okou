import { command, computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { wechatReceiverContract as contract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { wechatUpdatesSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
import { wechatConnections } from "@okouai/db/schema/wechat";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { verifyWechatGatewaySignature } from "../../lib/wechat-gateway-verification";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { recoverWechatChatDeliveries$ } from "../services/wechat-delivery-recovery.service";
import { writeDb$ } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../services/crypto.utils";
import { wechatEnabled$ } from "../services/wechat-config";
import { processPendingBatch$ } from "../services/wechat-gateway-batch.service";
import { safeJsonParse } from "../utils";
import type { RouteEntry } from "../route-entry";

const authenticatedBody$ = computed(async (get) => {
  const req = get(request$);
  const raw = await req.text();
  const secret = env("WECHAT_GATEWAY_SECRET");
  if (
    raw.length > 2_100_000 ||
    !secret ||
    !verifyWechatGatewaySignature(
      secret,
      req.raw.headers.get("x-wechat-timestamp"),
      req.raw.headers.get("x-wechat-signature"),
      raw,
    )
  ) {
    return null;
  }
  return safeJsonParse(raw);
});
const connection$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const [row] = await set(writeDb$)
      .select()
      .from(wechatConnections)
      .where(eq(wechatConnections.id, id))
      .limit(1);
    signal.throwIfAborted();
    if (
      !row ||
      row.status === "reconnect_required" ||
      !(await set(wechatEnabled$, row.orgId, row.userId, signal))
    ) {
      return null;
    }
    return row;
  },
);
const bootstrap$ = command(async ({ get, set }, signal: AbortSignal) => {
  const raw = await get(authenticatedBody$);
  signal.throwIfAborted();
  if (raw === null) {
    return createErrorResponse("UNAUTHORIZED", "Invalid gateway request");
  }
  const parsed = contract.bootstrap.body.safeParse(raw);
  if (!parsed.success) {
    return createErrorResponse("BAD_REQUEST", "Invalid receiver body");
  }
  const connection = await set(connection$, parsed.data.connectionId, signal);
  if (!connection) {
    return Response.json({ active: false });
  }
  if (connection.status === "active") {
    // Normal callbacks send replies immediately. This bounded renewal is the
    // backstop for a callback interrupted before durable delivery registration.
    waitUntil(
      set(
        recoverWechatChatDeliveries$,
        connection,
        AbortSignal.timeout(300_000),
      ),
    );
  }
  if (parsed.data.generation === connection.generation) {
    return Response.json({ active: true, generation: connection.generation });
  }
  const token = await decryptStoredSecretValue(connection.tokenCiphertext);
  signal.throwIfAborted();
  const pending = connection.pendingBatchCiphertext
    ? wechatUpdatesSchema.parse(
        safeJsonParse(
          await decryptStoredSecretValue(connection.pendingBatchCiphertext),
        ),
      )
    : null;
  signal.throwIfAborted();
  return Response.json(
    {
      active: true,
      generation: connection.generation,
      session: {
        baseUrl: connection.baseUrl,
        token,
        cursor: connection.updatesCursor,
        preserveCursor:
          connection.status === "disconnected" || connection.resumedAt !== null,
        pending,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
const deliver$ = command(async ({ get, set }, signal: AbortSignal) => {
  const raw = await get(authenticatedBody$);
  signal.throwIfAborted();
  if (raw === null) {
    return createErrorResponse("UNAUTHORIZED", "Invalid gateway request");
  }
  const parsed = contract.deliver.body.safeParse(raw);
  if (!parsed.success) {
    return createErrorResponse("BAD_REQUEST", "Invalid receiver body");
  }
  const body = parsed.data;
  const connection = await set(connection$, body.connectionId, signal);
  if (!connection) {
    return Response.json({ active: false });
  }
  if (connection.generation !== body.generation) {
    return Response.json({ active: true, refresh: true });
  }
  if (connection.status === "active") {
    waitUntil(
      set(
        recoverWechatChatDeliveries$,
        connection,
        AbortSignal.timeout(300_000),
      ),
    );
  }
  const db = set(writeDb$);
  let batchCiphertext = connection.pendingBatchCiphertext;
  if (!batchCiphertext) {
    batchCiphertext = await encryptStoredSecretValue(
      JSON.stringify({ ...body.updates, retries: {} }),
    );
    signal.throwIfAborted();
    const [saved] = await db
      .update(wechatConnections)
      .set({
        pendingBatchCiphertext: batchCiphertext,
        updatesCursor: body.updates.get_updates_buf ?? connection.updatesCursor,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(wechatConnections.id, connection.id),
          eq(wechatConnections.generation, body.generation),
          eq(wechatConnections.status, connection.status),
          isNull(wechatConnections.pendingBatchCiphertext),
        ),
      )
      .returning({ id: wechatConnections.id });
    signal.throwIfAborted();
    if (!saved) {
      // Another request owns this batch, or the binding changed. Retain the
      // Workflows checkpoint until its next attempt observes the live binding.
      return Response.json({ active: true, retryAfterMs: 1000 });
    }
  }
  await set(processPendingBatch$, { connection, batchCiphertext }, signal);
  const [current] = await db
    .select({
      generation: wechatConnections.generation,
      pending: wechatConnections.pendingBatchCiphertext,
      status: wechatConnections.status,
    })
    .from(wechatConnections)
    .where(eq(wechatConnections.id, connection.id))
    .limit(1);
  signal.throwIfAborted();
  if (!current || current.status === "reconnect_required") {
    return Response.json({ active: false });
  }
  if (current.generation !== body.generation) {
    return Response.json({ active: true, refresh: true });
  }
  // A failed input retains its persisted retry budget; later inputs have already
  // been admitted. The receiver must not acknowledge this batch prematurely.
  return Response.json(
    current.pending ? { active: true, retryAfterMs: 1000 } : { active: true },
  );
});
const expire$ = command(async ({ get, set }, signal: AbortSignal) => {
  const raw = await get(authenticatedBody$);
  signal.throwIfAborted();
  if (raw === null) {
    return createErrorResponse("UNAUTHORIZED", "Invalid gateway request");
  }
  const parsed = contract.expire.body.safeParse(raw);
  if (!parsed.success) {
    return createErrorResponse("BAD_REQUEST", "Invalid receiver body");
  }
  const row = await set(connection$, parsed.data.connectionId, signal);
  if (!row) {
    return Response.json({ active: false });
  }
  if (row.generation !== parsed.data.generation) {
    return Response.json({ active: true, refresh: true });
  }
  const live = and(
    eq(wechatConnections.id, row.id),
    eq(wechatConnections.generation, row.generation),
  );
  if (row.status === "disconnected") {
    await set(writeDb$).delete(wechatConnections).where(live);
  } else {
    await set(writeDb$)
      .update(wechatConnections)
      .set({ status: "reconnect_required", updatedAt: nowDate() })
      .where(live);
  }
  signal.throwIfAborted();
  return Response.json({ active: false });
});
export const wechatReceiverRoutes: readonly RouteEntry[] = [
  { route: contract.bootstrap, handler: bootstrap$ },
  { route: contract.deliver, handler: deliver$ },
  { route: contract.expire, handler: expire$ },
];
