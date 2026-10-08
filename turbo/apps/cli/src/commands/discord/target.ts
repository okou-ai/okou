import {
  parseMessageTarget,
  unsupportedTargetError,
} from "../../lib/command/message-target";

/**
 * Discord destinations are channel IDs (including native threads and the
 * sender's existing bot DM channel); user IDs cannot be resolved to a channel.
 */
export function resolveDiscordChannelId(to: string): string {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  if (target.kind !== "chat") {
    throw unsupportedTargetError(
      "Discord",
      target,
      "Pass a channel, native thread, or your bot DM channel ID",
    );
  }
  return target.id;
}
