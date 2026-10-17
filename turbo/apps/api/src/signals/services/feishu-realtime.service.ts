import { and, eq } from "drizzle-orm";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";

export function feishuOrgChangedAdminReadPlan(orgId: string) {
  return {
    columns: { userId: orgMembersCache.userId },
    condition: and(
      eq(orgMembersCache.orgId, orgId),
      eq(orgMembersCache.role, "admin"),
    ),
  };
}

export function feishuOrgChangedUserIds(
  admins: readonly { readonly userId: string }[],
  ownerUserId: string | null,
  additionalUserIds: readonly string[] = [],
): string[] {
  const userIds = new Set(
    admins.map((admin) => {
      return admin.userId;
    }),
  );
  if (ownerUserId) {
    userIds.add(ownerUserId);
  }
  for (const userId of additionalUserIds) {
    userIds.add(userId);
  }
  return [...userIds];
}
