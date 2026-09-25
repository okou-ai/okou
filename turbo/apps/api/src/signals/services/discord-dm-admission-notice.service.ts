import { createHash } from "node:crypto";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import type { DiscordMessageCreate } from "../../lib/discord-gateway-event";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { discordClient } from "../external/discord-client";

const NOTICE_WINDOW_MS = 60 * 60 * 1000;
const RECENT_DM_MESSAGES = 50;

type DiscordDmAdmissionNoticeKind = "not-connected" | "selection-required";

function noticeContent(kind: DiscordDmAdmissionNoticeKind): string {
  return kind === "not-connected"
    ? "This Discord account isn't connected to an Okou workspace, so I can't start a task here yet. Discord account onboarding isn't available yet: ask a workspace administrator to set up a verified connection. Run `/okou connect` to check your connection status."
    : "Your Discord account is connected to more than one Okou workspace. Run `/okou org` here to choose the workspace for direct messages, then send your message again.";
}

/**
 * Tells a DM sender why a message did not start a task. Discord has no
 * ephemeral messages outside interactions, so this is an ordinary bot DM. The
 * DM itself records whether the notice went out in the last hour, so Okou
 * stores nothing about senders who have no connection.
 */
export const sendDiscordDmAdmissionNotice$ = command(
  async (
    { set },
    args: {
      readonly applicationId: string;
      readonly botToken: string;
      readonly message: DiscordMessageCreate;
      readonly kind: DiscordDmAdmissionNoticeKind;
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
        .where(eq(discordOrgConnections.discordUserId, message.author.id))
        .limit(1);
      signal.throwIfAborted();
      if (connection) {
        return;
      }
    }
    // Reply only in the sender's own one-to-one DM with the bot.
    const channel = await discordClient.fetchDiscordChannel(
      { botToken: args.botToken, channelId: message.channel_id },
      signal,
    );
    signal.throwIfAborted();
    if (
      channel.kind !== "ok" ||
      channel.data.id !== message.channel_id ||
      channel.data.type !== 1 ||
      channel.data.guild_id !== undefined ||
      channel.data.recipients?.length !== 1 ||
      channel.data.recipients[0]?.id !== message.author.id
    ) {
      return;
    }
    const content = noticeContent(args.kind);
    // Only the bot's own notices in this DM are inspected; nothing read here
    // reaches a run. An unreadable DM sends nothing rather than risk spam.
    const recent = await discordClient.fetchDiscordMessages(
      {
        botToken: args.botToken,
        channelId: message.channel_id,
        limit: RECENT_DM_MESSAGES,
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
        // Concurrent DMs share this nonce, so Discord keeps one notice.
        nonce: createHash("sha256")
          .update(
            JSON.stringify([
              args.applicationId,
              "DM_ADMISSION_NOTICE",
              args.kind,
              message.author.id,
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
