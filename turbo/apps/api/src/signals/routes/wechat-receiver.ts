import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { wechatReceiverContract as contract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { wechatUpdatesSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
import { wechatConnections } from "@okouai/db/schema/wechat";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { verifyWechatGatewaySignature } from "../../lib/wechat-gateway-verification";
import { request$ } from "../context/hono";
import { writeDb$ } from "../external/db";
import { decryptStoredSecretValue } from "../services/crypto.utils";
import { wechatEnabled$ } from "../services/wechat-config";
import { dispatchWechatBatch$ } from "../services/wechat-gateway-batch.service";
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
  const row = await set(connection$, parsed.data.connectionId, signal);
  if (!row) {
    return Response.json({ active: false });
  }
  // This CAS excludes concurrent legacy polls before transferring their cursor
  // and pending batch. Old API artifacts must drain before Worker activation.
  const [claimed] = row.workflowReceiver
    ? [row]
    : await set(writeDb$)
        .update(wechatConnections)
        .set({ workflowReceiver: true })
        .where(
          and(
            eq(wechatConnections.id, row.id),
            eq(wechatConnections.generation, row.generation),
          ),
        )
        .returning();
  signal.throwIfAborted();
  if (!claimed) {
    return Response.json({ active: false });
  }
  if (parsed.data.generation === claimed.generation) {
    return Response.json({ active: true, generation: claimed.generation });
  }
  const token = await decryptStoredSecretValue(claimed.tokenCiphertext);
  signal.throwIfAborted();
  const pending = claimed.pendingBatchCiphertext
    ? wechatUpdatesSchema.parse(
        safeJsonParse(
          await decryptStoredSecretValue(claimed.pendingBatchCiphertext),
        ),
      )
    : null;
  signal.throwIfAborted();
  return Response.json(
    {
      active: true,
      generation: claimed.generation,
      session: {
        baseUrl: claimed.baseUrl,
        token,
        cursor: claimed.updatesCursor,
        preserveCursor:
          claimed.status === "disconnected" || claimed.resumedAt !== null,
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
  if (!connection.workflowReceiver) {
    return createErrorResponse(
      "CONFLICT",
      "Receiver has not claimed this binding",
    );
  }
  await set(
    dispatchWechatBatch$,
    { connection, messages: body.updates.msgs ?? [] },
    signal,
  );
  await set(writeDb$)
    .update(wechatConnections)
    .set({
      pendingBatchCiphertext: null,
      updatesCursor: body.updates.get_updates_buf ?? connection.updatesCursor,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(wechatConnections.id, connection.id),
        eq(wechatConnections.generation, body.generation),
      ),
    );
  signal.throwIfAborted();
  return Response.json({ active: true });
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
