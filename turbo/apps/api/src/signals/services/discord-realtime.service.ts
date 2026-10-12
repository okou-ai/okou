import { sql, type SQL } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { publishUserSignal } from "../external/realtime";

interface DiscordCleanupRecipientFact {
  readonly removed: boolean;
  readonly userId: string | null;
}

/** Derive recipients only from returned committed authorization facts. */
export function discordCleanupRecipients(
  rows: readonly DiscordCleanupRecipientFact[],
  additionalUserIds: readonly string[],
): { readonly removed: boolean; readonly userIds: string[] } {
  const recipients = new Set(additionalUserIds);
  let removed = false;
  for (const row of rows) {
    if (!row.removed) {
      continue;
    }
    removed = true;
    if (row.userId !== null) {
      recipients.add(row.userId);
    }
  }
  return { removed, userIds: removed ? [...recipients] : [] };
}

/** Pure union projection; callers gate each branch by real returned removal facts. */
export function discordRemovalProjection(userId: SQL, removed: boolean) {
  return {
    removed: sql`${removed}::boolean`.mapWith(pgBooleanDecoder).as("removed"),
    userId: userId
      .mapWith(nullableDriverValueDecoder(pgTextDecoder))
      .as("user_id"),
  };
}

/** Publish after commit; the existing realtime boundary owns best-effort delivery. */
export async function publishDiscordChanged(
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length > 0) {
    await publishUserSignal([...new Set(userIds)], "discord:changed");
  }
}
