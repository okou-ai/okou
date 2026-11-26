import {
  remoteDeviceChannelKindSchema,
  type RemoteDevice,
  type RemoteDeviceChannelKind,
  type RemoteDeviceDirectoryItem,
} from "@okouai/api-contracts/contracts/remote-devices";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { phoneUseDevices } from "@okouai/db/schema/phone-use";
import { remoteDevices } from "@okouai/db/schema/remote-device";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";
import {
  remoteDeviceMode,
  type RemoteDeviceOwner,
} from "./remote-device-access";

const remoteDeviceFields = Object.freeze({
  id: remoteDevices.id,
  displayName: remoteDevices.displayName,
  accessAllowed: remoteDevices.accessAllowed,
  accessExpiresAt: remoteDevices.accessExpiresAt,
});

export const channelTables = Object.freeze({
  desktop: computerUseHosts,
  ios: phoneUseDevices,
  ssh: sshConnections,
  vnc: vncConnections,
});

export function ownedDevices(owner: RemoteDeviceOwner) {
  return and(
    eq(remoteDevices.orgId, owner.orgId),
    eq(remoteDevices.userId, owner.userId),
    remoteDeviceMode(owner),
  );
}

export function remoteDeviceView(
  row: Pick<typeof remoteDevices.$inferSelect, keyof typeof remoteDeviceFields>,
): RemoteDevice {
  return {
    ...row,
    accessExpiresAt: row.accessExpiresAt?.toISOString() ?? null,
  };
}

const kindDecoder = zodEnumDriverValueDecoder(remoteDeviceChannelKindSchema);
const timestampDecoder = nullableDriverValueDecoder(
  computerUseHosts.lastSeenAt,
);
const idDecoder = nullableDriverValueDecoder(pgTextDecoder);

function channelQuery(
  db: ReadonlyDb,
  kind: RemoteDeviceChannelKind,
  owner: RemoteDeviceOwner,
) {
  const channel = channelTables[kind];
  const lastSeenAt =
    kind === "desktop"
      ? computerUseHosts.lastSeenAt
      : kind === "ios"
        ? phoneUseDevices.lastSeenAt
        : sql`NULL::timestamp`;
  const sshId =
    kind === "vnc" ? vncConnections.sshConnectionId : sql`NULL::uuid`;
  const kdcId =
    kind === "vnc" ? vncConnections.kdcSshConnectionId : sql`NULL::uuid`;
  return db
    .select({
      id: channel.id,
      deviceId: channel.remoteDeviceId,
      displayName: channel.displayName,
      kind: sql`${kind}::text`.mapWith(kindDecoder).as("kind"),
      lastSeenAt: sql`${lastSeenAt}`
        .mapWith(timestampDecoder)
        .as("last_seen_at"),
      sshId: sql`${sshId}`.mapWith(idDecoder).as("ssh_id"),
      kdcId: sql`${kdcId}`.mapWith(idDecoder).as("kdc_id"),
    })
    .from(channel)
    .where(
      and(
        eq(channel.orgId, owner.orgId),
        eq(channel.userId, owner.userId),
        kind === "desktop" ? isNull(computerUseHosts.revokedAt) : undefined,
      ),
    );
}

export async function readRemoteDeviceDirectory(
  db: ReadonlyDb,
  owner: RemoteDeviceOwner,
  kinds: readonly RemoteDeviceChannelKind[],
  runActive?: SQL,
): Promise<RemoteDeviceDirectoryItem[]> {
  const [first, second, ...rest] = kinds;
  if (first === undefined) {
    return [];
  }
  const firstChannel = channelQuery(db, first, owner);
  const channels = (
    second === undefined
      ? firstChannel
      : unionAll(
          firstChannel,
          channelQuery(db, second, owner),
          ...rest.map((kind) => {
            return channelQuery(db, kind, owner);
          }),
        )
  ).as("remote_device_channels");
  const directory = db
    .select({
      device: remoteDeviceFields,
      channel: {
        id: channels.id,
        kind: channels.kind,
        displayName: channels.displayName,
        lastSeenAt: channels.lastSeenAt,
        sshId: channels.sshId,
        kdcId: channels.kdcId,
      },
    })
    .from(remoteDevices);
  const matchingDevice = eq(remoteDevices.id, channels.deviceId);
  const rows = await (
    runActive === undefined
      ? directory.leftJoin(channels, matchingDevice)
      : directory.innerJoin(channels, matchingDevice)
  )
    .where(and(ownedDevices(owner), runActive))
    .orderBy(
      asc(remoteDevices.displayName),
      asc(remoteDevices.id),
      asc(channels.kind),
      asc(channels.displayName),
      asc(channels.id),
    );
  const devices = new Map<string, RemoteDeviceDirectoryItem>();
  for (const row of rows) {
    const device = devices.get(row.device.id) ?? {
      ...remoteDeviceView(row.device),
      channels: [],
    };
    if (row.channel) {
      const { id, kind, displayName, lastSeenAt, sshId, kdcId } = row.channel;
      const sshDependencyIds = [...new Set([sshId, kdcId])].filter(
        (dependency) => {
          return dependency !== null;
        },
      );
      device.channels.push({
        id,
        kind,
        displayName,
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
        sshDependencyIds,
      });
    }
    devices.set(device.id, device);
  }
  return [...devices.values()];
}
