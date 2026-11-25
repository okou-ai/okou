import { remoteDevices } from "@okouai/db/schema/remote-device";
import { sql, type SQLWrapper, type Subquery } from "drizzle-orm";
import type { Db } from "../external/db";

type WrittenChannel = Subquery & {
  readonly remoteDeviceId: SQLWrapper;
  readonly orgId: SQLWrapper;
  readonly userId: SQLWrapper;
  readonly displayName: SQLWrapper;
};

/** Publish only the device selected by the channel write in the same statement. */
export function publishRemoteChannelDevice(
  db: Db,
  channel: WrittenChannel,
  candidateId?: string,
) {
  return db.$with("published_remote_channel_device", {}).as(sql`
    INSERT INTO ${remoteDevices} (id, org_id, user_id, display_name)
    SELECT ${channel.remoteDeviceId}, ${channel.orgId}, ${channel.userId}, ${channel.displayName}
    FROM ${channel}
    ${candidateId === undefined ? sql.empty() : sql`WHERE ${channel.remoteDeviceId} = ${candidateId}::uuid`}
  `);
}
