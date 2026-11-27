import { command } from "ccstate";
import {
  remoteDevicesContract,
  type RemoteDeviceChannelKind,
} from "@okouai/api-contracts/contracts/remote-devices";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  computerUseCommandAuditEvents,
  computerUseCommands,
} from "@okouai/db/schema/computer-use-host";
import { remoteDevices } from "@okouai/db/schema/remote-device";
import { and, eq, exists, getTableName, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { array, boolean, object, uuid } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { isForeignKeyViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishPhoneUseDevicesChanged,
  publishRemoteDevicesChangedSafely,
  publishUserSignal,
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
  type RemoteDeviceOwner,
} from "../services/remote-device-access";
import {
  channelTables,
  readRemoteDeviceDirectory,
  remoteDeviceView,
} from "../services/remote-device-directory";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { publishRemoteRunnerInvalidation$ } from "../services/remote-runtime-wakeup.service";
import { publishSshRuntimeInvalidation$ } from "../services/ssh-runtime-wakeup.service";
import { publishVncNetworkReferenceChange } from "../services/vnc-connection.service";

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

const renameDevice$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const { deviceId } = get(pathParamsOf(remoteDevicesContract.rename));
  const body = await get(bodyResultOf(remoteDevicesContract.rename));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const [row] = await set(writeDb$)
    .update(remoteDevices)
    .set({ displayName: body.data.displayName })
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

const deletionResult = object({
  desktop_changed: boolean(),
  ios_changed: boolean(),
  ssh_ids: array(uuid()),
  vnc_ids: array(uuid()),
});

async function deleteRemoteDeviceRows(
  db: Db,
  owner: RemoteDeviceOwner,
  deviceId: string,
) {
  return parseRawRows(
    deletionResult,
    await db.execute(sql`
    WITH target AS (
      DELETE FROM ${remoteDevices}
      WHERE ${ownedRemoteDevice(owner, deviceId)}
      RETURNING id
    ), desktop AS (
      DELETE FROM ${channelTables.desktop}
      WHERE remote_device_id = (SELECT id FROM target)
      RETURNING id
    ), desktop_commands AS (
      DELETE FROM ${computerUseCommands}
      WHERE host_id IN (SELECT id FROM desktop)
      RETURNING id
    ), desktop_audit AS (
      DELETE FROM ${computerUseCommandAuditEvents}
      WHERE EXISTS (SELECT FROM desktop)
        AND org_id = ${owner.orgId} AND user_id = ${owner.userId}
        AND (
          host_id IN (SELECT id FROM desktop)
          OR command_id IN (SELECT id FROM desktop_commands)
        )
    ), ios AS (
      DELETE FROM ${channelTables.ios}
      WHERE remote_device_id = (SELECT id FROM target)
      RETURNING id
    ), vnc AS (
      DELETE FROM ${channelTables.vnc}
      WHERE remote_device_id = (SELECT id FROM target)
      RETURNING id
    ), ssh AS (
      DELETE FROM ${channelTables.ssh}
      WHERE remote_device_id = (SELECT id FROM target)
      RETURNING id
    )
    SELECT EXISTS (SELECT FROM desktop) AS desktop_changed,
           EXISTS (SELECT FROM ios) AS ios_changed,
           ARRAY(SELECT id FROM ssh) AS ssh_ids,
           ARRAY(SELECT id FROM vnc) AS vnc_ids
    FROM target
  `),
  );
}

const deleteDevice$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = get(organizationAuthContext$);
  const { deviceId } = get(pathParamsOf(remoteDevicesContract.delete));
  const deleted = await settle(
    deleteRemoteDeviceRows(set(writeDb$), owner, deviceId),
    signal,
  );
  signal.throwIfAborted();
  if (!deleted.ok) {
    if (
      isForeignKeyViolation(deleted.error, "vnc_connections_ssh_owner_fk") ||
      isForeignKeyViolation(deleted.error, "vnc_connections_kdc_ssh_owner_fk")
    ) {
      return conflict(
        "Remove the channel dependency on the other device before deleting this one.",
      );
    }
    if (
      isForeignKeyViolation(deleted.error) ||
      safeSqlStateCode(deleted.error) === "40P01"
    ) {
      return conflict("The device changed. Try deleting it again.");
    }
    throw deleted.error;
  }
  const [result] = deleted.value;
  if (!result) {
    return missing;
  }
  await Promise.all([
    publishRemoteDevicesChangedSafely(owner),
    result.desktop_changed &&
      publishUserSignal([owner.userId], "computerUseHostsChanged"),
    result.ios_changed && publishPhoneUseDevicesChanged(owner),
    result.ssh_ids.length > 0 &&
      set(publishSshRuntimeInvalidation$, {
        ...owner,
        connectionIds: result.ssh_ids,
      }),
    set(
      publishRemoteRunnerInvalidation$,
      { ...owner, connectionIds: result.vnc_ids },
      "vnc",
    ),
    result.vnc_ids.length > 0 && publishVncNetworkReferenceChange(owner),
  ]);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
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
    route: remoteDevicesContract.rename,
    handler: authRoute(ownerAuth, renameDevice$),
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
    route: remoteDevicesContract.delete,
    handler: authRoute(ownerAuth, deleteDevice$),
  },
  {
    route: remoteDevicesContract.approve,
    handler: authRoute(ownerAuth, approve$),
  },
];
