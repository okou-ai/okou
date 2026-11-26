import { command } from "ccstate";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { remoteDevices } from "@okouai/db/schema/remote-device";
import { and, eq, exists, getTableName, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { badRequestMessage, notFound } from "../../lib/error";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishRemoteDevicesChangedSafely,
} from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";
import {
  ownedRemoteDevice,
  remoteDeviceDestination,
  remoteDeviceMode,
  remoteDeviceMode$,
  remoteDeviceRunActive,
  remoteDeviceStatementTime,
} from "../services/remote-device-access";
import {
  channelTables,
  readRemoteDeviceDirectory,
  remoteDeviceView,
} from "../services/remote-device-directory";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { RemoteDeviceChannelKind } from "@okouai/api-contracts/contracts/remote-devices";

const missing = notFound("Remote device not found");
const remoteDeviceFields = Object.freeze({
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

const discoveryCapabilities = [
  ["desktop", "computer-use:write"],
  ["ios", "phone-use:read"],
  ["ssh", "ssh:read"],
  ["vnc", "vnc:read"],
] as const satisfies readonly (readonly [
  RemoteDeviceChannelKind,
  Capability,
])[];

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = get(organizationAuthContext$);
  const devices = await readRemoteDeviceDirectory(
    get(db$),
    owner,
    discoveryCapabilities.map(([kind]) => {
      return kind;
    }),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { devices } };
});

const listForRun$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Remote device discovery requires Run authentication");
  }
  const capabilities = auth.capabilities ?? [];
  const kinds = discoveryCapabilities.flatMap(([kind, capability]) => {
    return capabilities.includes(capability) ? [kind] : [];
  });
  const db = get(db$);
  const active = remoteDeviceRunActive(auth, auth.runId);
  const [run] = await db
    .select({ chatThreadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, auth.runId), active, remoteDeviceMode(auth)))
    .limit(1);
  signal.throwIfAborted();
  if (!run?.chatThreadId) {
    return notFound("Remote device discovery is unavailable for this Run");
  }
  const devices = await readRemoteDeviceDirectory(db, auth, kinds, active);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { chatThreadId: run.chatThreadId, devices },
  };
});

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const body = await get(bodyResultOf(remoteDevicesContract.create));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const enabled = await set(remoteDeviceMode$, owner, signal);
  signal.throwIfAborted();
  if (!enabled) {
    return missing;
  }
  const db = set(writeDb$);
  const { id, displayName } = body.data;
  const [created] = await db
    .insert(remoteDevices)
    .values({ id, displayName, orgId: owner.orgId, userId: owner.userId })
    .onConflictDoNothing({ target: remoteDevices.id })
    .returning(remoteDeviceFields);
  signal.throwIfAborted();
  if (created) {
    await publishRemoteDevicesChangedSafely(owner);
    signal.throwIfAborted();
    return { status: 201 as const, body: remoteDeviceView(created) };
  }
  const [existing] = await db
    .select(remoteDeviceFields)
    .from(remoteDevices)
    .where(ownedRemoteDevice(owner, id));
  signal.throwIfAborted();
  return existing
    ? { status: 200 as const, body: remoteDeviceView(existing) }
    : missing;
});

const moveChannel$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const { deviceId, kind, channelId } = get(
    pathParamsOf(remoteDevicesContract.moveChannel),
  );
  const table = channelTables[kind];
  const result = await settle(
    set(writeDb$)
      .update(table)
      .set({ remoteDeviceId: deviceId })
      .where(
        and(
          eq(table.id, channelId),
          eq(table.orgId, owner.orgId),
          eq(table.userId, owner.userId),
          remoteDeviceDestination(owner, deviceId),
          kind === "desktop" ? isNull(computerUseHosts.revokedAt) : undefined,
        ),
      )
      .returning({ id: table.id }),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    if (
      isForeignKeyViolation(
        result.error,
        `${getTableName(table)}_remote_device_owner_fk`,
      )
    ) {
      return missing;
    }
    throw result.error;
  }
  if (result.value.length === 0) {
    return missing;
  }
  await publishRemoteDevicesChangedSafely(owner);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
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
    body.data.mode === "until"
      ? new Date(body.data.expiresAt)
      : body.data.mode === "for"
        ? new Date(nowDate().getTime() + body.data.hours * 3_600_000)
        : null;
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
    .where(ownedRemoteDevice(owner, deviceId))
    .returning(remoteDeviceFields);
  signal.throwIfAborted();
  if (!row) {
    return missing;
  }
  await publishRemoteDevicesChangedSafely(owner);
  signal.throwIfAborted();
  return { status: 200 as const, body: remoteDeviceView(row) };
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
    .where(and(ownedRemoteDevice(owner, body.data.deviceId), ownedThread))
    .returning(remoteDeviceFields);
  signal.throwIfAborted();
  if (row) {
    await Promise.all([
      publishChatThreadDetailChangedSafely(owner.userId, threadId),
      publishRemoteDevicesChangedSafely(owner),
    ]);
    signal.throwIfAborted();
  }
  return row ? { status: 200 as const, body: remoteDeviceView(row) } : missing;
});

export const remoteDevicesRoutes: readonly RouteEntry[] = [
  {
    route: remoteDevicesContract.list,
    handler: authRoute(ownerAuth, list$),
  },
  {
    route: remoteDevicesContract.listForRun,
    handler: authRoute(
      { ...ownerAuth, accept: ["agent"], requiredCapability: "connector:read" },
      listForRun$,
    ),
  },
  {
    route: remoteDevicesContract.create,
    handler: authRoute(ownerAuth, create$),
  },
  {
    route: remoteDevicesContract.moveChannel,
    handler: authRoute(ownerAuth, moveChannel$),
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
