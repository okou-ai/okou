import { remoteDevices } from "@okouai/db/schema/remote-device";
import { sql, type SQLWrapper, type Subquery } from "drizzle-orm";
import type { Db } from "../external/db";

type WrittenChannel = Subquery & {
  readonly remoteDeviceId: SQLWrapper;
  readonly orgId: SQLWrapper;
  readonly userId: SQLWrapper;
  readonly displayName: SQLWrapper;
};

// Match String.prototype.trim() independently of the database locale.
const displayNameWhitespace =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006" +
  "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Publish only the device selected by the channel write in the same statement. */
export function publishRemoteChannelDevice(
  db: Db,
  channel: WrittenChannel,
  candidateId?: string,
) {
  return db.$with("published_remote_channel_device", {}).as(sql`
    INSERT INTO ${remoteDevices} (id, org_id, user_id, display_name)
    SELECT ${channel.remoteDeviceId}, ${channel.orgId}, ${channel.userId},
      coalesce(
        nullif(btrim(${channel.displayName}, ${displayNameWhitespace}), ''),
        'Unnamed device'
      )
    FROM ${channel}
    ${candidateId === undefined ? sql.empty() : sql`WHERE ${channel.remoteDeviceId} = ${candidateId}::uuid`}
  `);
}
