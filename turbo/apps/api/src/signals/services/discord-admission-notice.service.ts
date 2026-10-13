import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordConnectMessage } from "../../lib/discord-connect-message";
import type { DiscordMessageCreate } from "../../lib/discord-gateway-event";
import { discordAccountMessage } from "../../lib/discord-interaction-messages";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { discordClient } from "../external/discord-client";

const NOTICE_WINDOW_MS = 60 * 60 * 1000;
const RECENT_CHANNEL_MESSAGES = 50;

type DiscordAdmissionNoticeKind = "not-connected" | "selection-required";

/**
 * Replies to an unconnected sender without admitting their message to a run.
 * Discord has no ephemeral messages outside interactions. The channel history
 * and Discord nonce deduplicate notices without storing unconnected senders.
 */
export const sendDiscordAdmissionNotice$ = command(
  async (
    { set },
    args: {
      readonly applicationId: string;
      readonly botToken: string;
      readonly message: DiscordMessageCreate;
      readonly kind: DiscordAdmissionNoticeKind;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { message } = args;
    if (args.kind === "not-connected") {
      // A binding that exists but no longer verifies (for example, while the
      // feature is off for its org) must not advertise setup steps.
      const [connection] = await set(writeDb$)
        .select({ id: discordOrgConnections.id })
        .from(discordOrgConnections)
        .where(
          and(
            eq(discordOrgConnections.discordUserId, message.author.id),
            message.guild_id
              ? eq(discordOrgConnections.guildId, message.guild_id)
              : undefined,
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (connection) {
        return;
      }
    }
    // Reply only in the original guild channel or the sender's one-to-one DM.
    const channel = await discordClient.fetchDiscordChannel(
      { botToken: args.botToken, channelId: message.channel_id },
      signal,
    );
    signal.throwIfAborted();
    if (channel.kind !== "ok" || channel.data.id !== message.channel_id) {
      return;
    }
    if (message.guild_id) {
      if (
        channel.data.guild_id !== message.guild_id ||
        ![0, 5, 10, 11, 12].includes(channel.data.type)
      ) {
        return;
      }
    } else if (
      channel.data.type !== 1 ||
      channel.data.guild_id !== undefined ||
      channel.data.recipients?.length !== 1 ||
      channel.data.recipients[0]?.id !== message.author.id
    ) {
      return;
    }
    const notice =
      args.kind === "not-connected"
        ? discordConnectMessage(message.guild_id)
        : discordAccountMessage(
            "Your Discord account is connected to more than one Okou workspace. Run `/connect` here to choose the workspace for direct messages, then send your message again.",
          );
    const content = message.guild_id
      ? `<@${message.author.id}> ${notice.content}`
      : notice.content;
    // Only this bot's own notices are inspected; nothing read here reaches a run.
    const recent = await discordClient.fetchDiscordMessages(
      {
        botToken: args.botToken,
        channelId: message.channel_id,
        limit: RECENT_CHANNEL_MESSAGES,
      },
      signal,
    );
    signal.throwIfAborted();
    const currentTime = nowDate().getTime();
    if (
      recent.kind !== "ok" ||
      recent.data.some((entry) => {
        return (
          entry.channel_id === message.channel_id &&
          entry.author.id === args.applicationId &&
          entry.author.bot === true &&
          entry.content === content &&
          currentTime - Date.parse(entry.timestamp) < NOTICE_WINDOW_MS
        );
      })
    ) {
      return;
    }
    await discordClient.createDiscordMessage(
      {
        botToken: args.botToken,
        channelId: message.channel_id,
        content,
        components: notice.components,
        ...(message.guild_id ? { replyToMessageId: message.id } : {}),
        // Concurrent messages share this nonce, so Discord keeps one notice.
        nonce: createHash("sha256")
          .update(
            JSON.stringify([
              args.applicationId,
              "ADMISSION_NOTICE",
              args.kind,
              message.author.id,
              message.channel_id,
              Math.floor(currentTime / NOTICE_WINDOW_MS),
            ]),
          )
          .digest("hex")
          .slice(0, 25),
      },
      signal,
    );
  },
);
