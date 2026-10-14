import { publishUserSignal } from "../external/realtime";

/** Publish after commit; the existing realtime boundary owns best-effort delivery. */
export async function publishDiscordChanged(
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length > 0) {
    await publishUserSignal([...new Set(userIds)], "discord:changed");
  }
}
