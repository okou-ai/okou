import { command } from "ccstate";
import { createHash } from "node:crypto";
import { discordClient } from "../external/discord-client";
import {
  requireDiscordBinding$,
  requireDiscordConversationAccess$,
} from "./discord-access.service";

/** Only a committed, newly inserted connection may initiate this user-action DM. */
export const notifyDiscordConnection$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const binding = await set(requireDiscordBinding$, args, signal);
    if (
      binding.kind !== "allowed" ||
      binding.binding.connectionId !== args.connectionId
    ) {
      return;
    }
    const dm = await discordClient.openDiscordDm(
      { botToken: binding.botToken, userId: binding.binding.discordUserId },
      signal,
    );
    if (dm.kind !== "ok") {
      return;
    }
    // Reauthorize local ownership, current Clerk membership, bot identity
    // and this exact bot/sender DM before each independent delivery.
    const access = await set(
      requireDiscordConversationAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        channelId: dm.data.id,
        mode: "write",
      },
      signal,
    );
    if (
      access.kind !== "allowed" ||
      access.binding.connectionId !== args.connectionId
    ) {
      return;
    }
    const nonce = createHash("sha256")
      .update(`discord-welcome:${args.connectionId}`)
      .digest("hex")
      .slice(0, 24);
    await discordClient.createDiscordMessage(
      {
        botToken: access.botToken,
        channelId: access.channel.id,
        content: [
          `👋 **Hi! I'm <@${access.binding.botUserId}>.**`,
          "Send me a message describing what you need help with.",
        ].join("\n\n"),
        nonce,
      },
      signal,
    );
  },
);
