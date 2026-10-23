import { parseMessageTarget } from "../../lib/command/message-target";

/**
 * Bare Discord IDs are channels; explicit user targets open a bot DM.
 */
export function resolveDiscordDestination(
  to: string,
):
  | { channelId: string; userId?: never }
  | { userId: string; channelId?: never } {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  if (target.kind === "me") {
    return { userId: "me" };
  }
  return target.kind === "user"
    ? { userId: target.id }
    : { channelId: target.id };
}
