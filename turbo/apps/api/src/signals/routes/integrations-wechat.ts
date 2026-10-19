import { orgCache } from "@okouai/db/schema/org-cache";
import { settle } from "../utils";
import { isUniqueViolation } from "../../lib/pg-errors";
import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, gt, sql } from "drizzle-orm";
import { integrationsWechatContract as contract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import {
  wechatConnections,
  wechatConnectAttempts,
} from "@okouai/db/schema/wechat";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  createWechatQr,
  pollWechatQr,
  WECHAT_ORIGIN,
  wechatOrigin,
} from "../external/wechat-client";
import {
  encryptStoredSecretValue,
  decryptStoredSecretValue,
} from "../services/crypto.utils";
import {
  wechatEnabled$,
  wechatConfigured,
  startWechatPoller,
} from "../services/wechat-config";
import type { RouteEntry } from "../route-entry";
import { nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { z } from "zod";

const checkAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  return await set(wechatEnabled$, auth.orgId, auth.userId, signal);
});
const status$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(checkAccess$, signal))) {
    return createErrorResponse(
      "FORBIDDEN",
      "WeChat integration is not enabled.",
    );
  }
  const auth = get(organizationAuthContext$);
  const [row] = await set(writeDb$)
    .select({
      id: wechatConnections.id,
      status: wechatConnections.status,
      accountId: wechatConnections.senderId,
      workspaceId: wechatConnections.orgId,
      workspaceName: orgCache.name,
    })
    .from(wechatConnections)
    .leftJoin(orgCache, eq(orgCache.orgId, wechatConnections.orgId))
    .where(
      and(
        eq(wechatConnections.orgId, auth.orgId),
        eq(wechatConnections.userId, auth.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  // Also repairs a connection committed just before the browser/API lost its response.
  if (row && row.status !== "reconnect_required" && wechatConfigured()) {
    await startWechatPoller(row.id, signal);
  }
  return {
    status: 200 as const,
    body: {
      configured: wechatConfigured(),
      binding:
        row && row.status !== "disconnected"
          ? {
              workspace: {
                id: row.workspaceId,
                name: row.workspaceName || row.workspaceId,
              },
              accountId: row.accountId,
            }
          : null,
      status: row?.status ?? ("disconnected" as const),
    },
  };
});
const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(checkAccess$, signal))) {
    return createErrorResponse(
      "FORBIDDEN",
      "WeChat integration is not enabled.",
    );
  }
  if (!wechatConfigured()) {
    return createErrorResponse(
      "PROVIDER_UNAVAILABLE",
      "WeChat connection is not configured.",
    );
  }
  const auth = get(organizationAuthContext$);
  const qr = await createWechatQr(signal);
  const attempt = {
    id: randomUUID(),
    orgId: auth.orgId,
    userId: auth.userId,
    qrCiphertext: await encryptStoredSecretValue(qr.qrcode),
    baseUrl: WECHAT_ORIGIN,
    expiresAt: new Date(nowDate().getTime() + 5 * 60_000),
  };
  signal.throwIfAborted();
  await set(writeDb$)
    .insert(wechatConnectAttempts)
    .values(attempt)
    .onConflictDoUpdate({
      target: [wechatConnectAttempts.orgId, wechatConnectAttempts.userId],
      set: attempt,
    });
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      id: attempt.id,
      qrContent: qr.qrcode_img_content,
      expiresAt: attempt.expiresAt.toISOString(),
    },
  };
});
const poll$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(checkAccess$, signal))) {
    return createErrorResponse(
      "FORBIDDEN",
      "WeChat integration is not enabled.",
    );
  }
  const parsed = await get(bodyResultOf(contract.poll));
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const auth = get(organizationAuthContext$);
  const db = set(writeDb$);
  const where = and(
    eq(wechatConnectAttempts.id, parsed.data.id),
    eq(wechatConnectAttempts.orgId, auth.orgId),
    eq(wechatConnectAttempts.userId, auth.userId),
    gt(wechatConnectAttempts.expiresAt, nowDate()),
  );
  const [attempt] = await db
    .select()
    .from(wechatConnectAttempts)
    .where(where)
    .limit(1);
  signal.throwIfAborted();
  if (!attempt) {
    return { status: 200 as const, body: { status: "expired" as const } };
  }
  const qr = await decryptStoredSecretValue(attempt.qrCiphertext);
  signal.throwIfAborted();
  const result = await pollWechatQr(
    attempt.baseUrl,
    qr,
    parsed.data.verifyCode,
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "scaned_but_redirect") {
    if (!result.redirect_host) {
      throw new Error("WeChat redirect is missing its host");
    }
    const baseUrl = wechatOrigin(`https://${result.redirect_host}`);
    await db.update(wechatConnectAttempts).set({ baseUrl }).where(where);
    signal.throwIfAborted();
    return { status: 200 as const, body: { status: "scanned" as const } };
  }
  if (result.status !== "confirmed") {
    const statuses = {
      wait: "waiting",
      scaned: "scanned",
      need_verifycode: "verification_required",
      verify_code_blocked: "verification_blocked",
      expired: "expired",
      binded_redirect: "restart_required",
    } as const;
    return { status: 200 as const, body: { status: statuses[result.status] } };
  }
  if (
    !result.bot_token ||
    !result.ilink_bot_id ||
    !result.ilink_user_id ||
    !result.baseurl
  ) {
    throw new Error("WeChat confirmation is incomplete");
  }
  const baseUrl = wechatOrigin(result.baseurl);
  const ciphertext = await encryptStoredSecretValue(result.bot_token);
  signal.throwIfAborted();
  const generation = randomUUID();
  // The still-current, unexpired owner attempt is the only publication gate.
  // A second tab, cancellation, or a late status response cannot replace it.
  const bound = await settle(
    (async () => {
      return parseRawRows(
        z.object({ id: z.uuid() }),
        await db.execute(sql`
  WITH consumed AS (DELETE FROM ${wechatConnectAttempts}
   WHERE id=${attempt.id}::uuid AND org_id=${auth.orgId} AND user_id=${auth.userId} AND expires_at>now()
   RETURNING id), eligible AS (
   SELECT id FROM consumed
   WHERE NOT EXISTS(SELECT 1 FROM ${wechatConnections} WHERE org_id=${auth.orgId} AND user_id=${auth.userId} AND sender_id<>${result.ilink_user_id} AND status<>'disconnected')
   AND NOT EXISTS(SELECT 1 FROM ${wechatConnections} WHERE sender_id=${result.ilink_user_id} AND status<>'disconnected' AND (org_id<>${auth.orgId} OR user_id<>${auth.userId}))
  ), released AS (
   DELETE FROM ${wechatConnections}
   WHERE status='disconnected' AND (sender_id=${result.ilink_user_id} OR (org_id=${auth.orgId} AND user_id=${auth.userId}))
   AND EXISTS(SELECT 1 FROM eligible)
   RETURNING id
  ), bound AS (
   INSERT INTO ${wechatConnections} (org_id,user_id,sender_id,bot_id,base_url,token_ciphertext,generation)
   SELECT ${auth.orgId},${auth.userId},${result.ilink_user_id},${result.ilink_bot_id},${baseUrl},${ciphertext},${generation}::uuid FROM eligible
   WHERE (SELECT count(*) FROM released)>=0
   ON CONFLICT (org_id,user_id) DO UPDATE SET sender_id=EXCLUDED.sender_id,bot_id=EXCLUDED.bot_id,base_url=EXCLUDED.base_url,token_ciphertext=EXCLUDED.token_ciphertext,generation=EXCLUDED.generation,status='active',updates_cursor='',pending_batch_ciphertext=NULL,updated_at=now()
   WHERE wechat_connections.sender_id=EXCLUDED.sender_id
   RETURNING id
  ) SELECT id FROM bound`),
      );
    })(),
  );
  signal.throwIfAborted();
  if (
    !bound.ok &&
    !isUniqueViolation(bound.error, "wechat_connections_sender_idx")
  ) {
    throw bound.error;
  }
  const row = bound.ok ? bound.value[0] : undefined;
  if (!row) {
    return createErrorResponse(
      "CONFLICT",
      "This connection attempt is no longer available. Disconnect the existing WeChat binding before connecting a different account.",
    );
  }
  await startWechatPoller(row.id, signal);
  return { status: 200 as const, body: { status: "connected" as const } };
});
const cancel$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(contract.cancel));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  await set(writeDb$)
    .delete(wechatConnectAttempts)
    .where(
      and(
        eq(wechatConnectAttempts.id, body.data.id),
        eq(wechatConnectAttempts.orgId, auth.orgId),
        eq(wechatConnectAttempts.userId, auth.userId),
      ),
    );
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});
const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  // Retain only the transport for reconnect notices. Old runs, routes and
  // private message history lose their binding in the same statement.
  await set(writeDb$).execute(sql`WITH cancelled AS (
    DELETE FROM wechat_connect_attempts WHERE org_id=${auth.orgId} AND user_id=${auth.userId}
  ), disconnected AS (
    UPDATE wechat_connections SET status='disconnected',generation=gen_random_uuid(),pending_batch_ciphertext=NULL,updated_at=now()
    WHERE org_id=${auth.orgId} AND user_id=${auth.userId} AND status<>'disconnected'
    RETURNING id
  ), contexts AS (
    DELETE FROM chat_wechat_context WHERE connection_id IN (SELECT id FROM disconnected)
  ), messages AS (
    DELETE FROM wechat_messages WHERE connection_id IN (SELECT id FROM disconnected)
  ) DELETE FROM wechat_chat_thread_routes WHERE connection_id IN (SELECT id FROM disconnected)`);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});
const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
export const integrationsWechatRoutes: readonly RouteEntry[] = [
  { route: contract.status, handler: authRoute(auth, status$) },
  { route: contract.connect, handler: authRoute(auth, connect$) },
  { route: contract.poll, handler: authRoute(auth, poll$) },
  { route: contract.cancel, handler: authRoute(auth, cancel$) },
  { route: contract.disconnect, handler: authRoute(auth, disconnect$) },
];
