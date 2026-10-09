import { and, eq } from "drizzle-orm";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";

import { publishUserSignal } from "../external/realtime";

export function discordOrgAdminsWhere(orgId: string) {
  return and(
    eq(orgMembersCache.orgId, orgId),
    eq(orgMembersCache.role, "admin"),
  );
}

/** Combine recipients captured before deleting a guild's connected-user rows. */
export function discordChangedUserIds(
  adminUserIds: readonly string[],
  additionalUserIds: readonly string[],
): string[] {
  return [...new Set([...additionalUserIds, ...adminUserIds])];
}

/** Publish after commit; the existing realtime boundary owns best-effort delivery. */
export async function publishDiscordChanged(
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length > 0) {
    await publishUserSignal([...new Set(userIds)], "discord:changed");
  }
}
