import { and, eq } from "drizzle-orm";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";

import type { ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";

/** Capture recipients before deleting a guild's connected-user rows. */
export async function discordOrgChangedUserIds(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  additionalUserIds: readonly string[] = [],
): Promise<string[]> {
  const admins = await db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.role, "admin")),
    );
  return [
    ...new Set([
      ...additionalUserIds,
      ...admins.map((admin) => {
        return admin.userId;
      }),
    ]),
  ];
}

/** Publish after commit; the existing realtime boundary owns best-effort delivery. */
export async function publishDiscordChanged(
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length > 0) {
    await publishUserSignal([...new Set(userIds)], "discord:changed");
  }
}
