import { command } from "ccstate";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { remoteDevices } from "@okouai/db/schema/remote-device";
import { and, asc, eq, exists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadDetailChangedSafely } from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import {
  remoteDeviceMode,
  remoteDeviceStatementTime,
  type RemoteDeviceOwner,
} from "../services/remote-device-access";

const missing = notFound("Remote device not found");
const fields = Object.freeze({
  id: remoteDevices.id,
  displayName: remoteDevices.displayName,
  accessAllowed: remoteDevices.accessAllowed,
  accessExpiresAt: remoteDevices.accessExpiresAt,
});
const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

function ownedDevices(owner: RemoteDeviceOwner) {
  return and(
    eq(remoteDevices.orgId, owner.orgId),
    eq(remoteDevices.userId, owner.userId),
    remoteDeviceMode(owner),
  );
}

function view(
  row: Pick<typeof remoteDevices.$inferSelect, keyof typeof fields>,
) {
  return {
    ...row,
    accessExpiresAt: row.accessExpiresAt?.toISOString() ?? null,
  };
}

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = get(organizationAuthContext$);
  const rows = await get(db$)
    .select(fields)
    .from(remoteDevices)
    .where(ownedDevices(owner))
    .orderBy(asc(remoteDevices.displayName), asc(remoteDevices.id));
  signal.throwIfAborted();
  return { status: 200 as const, body: { devices: rows.map(view) } };
});

const setAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const { deviceId } = get(pathParamsOf(remoteDevicesContract.setAccess));
  const body = await get(bodyResultOf(remoteDevicesContract.setAccess));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const expiresAt =
    body.data.mode === "until" ? new Date(body.data.expiresAt) : null;
  if (expiresAt !== null && expiresAt <= nowDate()) {
    return badRequestMessage(
      "Remote device access expiry must be in the future",
    );
  }
  const [row] = await set(writeDb$)
    .update(remoteDevices)
    .set({
      accessAllowed: body.data.mode !== "denied",
      accessExpiresAt: expiresAt,
    })
    .where(and(ownedDevices(owner), eq(remoteDevices.id, deviceId)))
    .returning(fields);
  signal.throwIfAborted();
  return row ? { status: 200 as const, body: view(row) } : missing;
});

const approve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const { threadId } = get(pathParamsOf(remoteDevicesContract.approve));
  const body = await get(bodyResultOf(remoteDevicesContract.approve));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const ownedThread = exists(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.orgId, owner.orgId),
          eq(chatThreads.userId, owner.userId),
        ),
      ),
  );
  const [row] = await set(writeDb$)
    .update(remoteDevices)
    .set({
      accessAllowed: true,
      accessExpiresAt: sql`CASE
        WHEN ${remoteDevices.accessAllowed} AND ${remoteDevices.accessExpiresAt} IS NULL
        THEN NULL
        ELSE GREATEST(${remoteDevices.accessExpiresAt}, ${remoteDeviceStatementTime()} + INTERVAL '1 hour')
      END`,
    })
    .where(
      and(
        ownedDevices(owner),
        eq(remoteDevices.id, body.data.deviceId),
        ownedThread,
      ),
    )
    .returning(fields);
  signal.throwIfAborted();
  if (row) {
    await publishChatThreadDetailChangedSafely(owner.userId, threadId);
    signal.throwIfAborted();
  }
  return row ? { status: 200 as const, body: view(row) } : missing;
});

export const remoteDevicesRoutes: readonly RouteEntry[] = [
  {
    route: remoteDevicesContract.list,
    handler: authRoute(ownerAuth, list$),
  },
  {
    route: remoteDevicesContract.setAccess,
    handler: authRoute(ownerAuth, setAccess$),
  },
  {
    route: remoteDevicesContract.approve,
    handler: authRoute(ownerAuth, approve$),
  },
];
