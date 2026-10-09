import { publishUserSignal } from "../external/realtime";

/** Combine recipient facts captured by the owning transaction before deletion. */
export function discordOrgChangedUserIds(
  admins: readonly { readonly userId: string }[],
  additionalUserIds: readonly string[],
): string[] {
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
