import { createHash } from "node:crypto";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import type { DiscordMessageCreate } from "../../lib/discord-gateway-event";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { discordClient } from "../external/discord-client";

const NOTICE_WINDOW_MS = 60 * 60 * 1000;

type DiscordDmAdmissionNoticeKind = "not-connected" | "selection-required";

function noticeContent(kind: DiscordDmAdmissionNoticeKind): string {
  return kind === "not-connected"
    ? "This Discord account isn't connected to an Okou workspace, so I can't start a task here yet. Discord account onboarding isn't available yet: ask a workspace administrator to set up a verified connection. Run `/okou connect` to check your connection status."
    : "Your Discord account is connected to more than one Okou workspace. Run `/okou org` here to choose the workspace for direct messages, then send your message again.";
}

/**
 * Tells a DM sender why a message did not start a task. Discord has no
 * ephemeral messages outside interactions, so this is an ordinary bot DM, sent
 * at most once per sender, notice kind and hour.
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
    const db = set(writeDb$);
    if (args.kind === "not-connected") {
      // A binding that exists but no longer verifies (for example, while the
      // feature is off for its org) must not advertise setup steps.
      const [connection] = await db
        .select({ id: discordOrgConnections.id })
        .from(discordOrgConnections)
        .where(eq(discordOrgConnections.discordUserId, message.author.id))
        .limit(1);
      signal.throwIfAborted();
      if (connection) {
        return;
      }
    }
    // The opaque digest names no sender; it only rate-limits this notice.
    const eventDigest = createHash("sha256")
      .update(
        JSON.stringify([
          args.applicationId,
          "DM_ADMISSION_NOTICE",
          args.kind,
          message.author.id,
          Math.floor(nowDate().getTime() / NOTICE_WINDOW_MS),
        ]),
      )
      .digest("hex");
    const [claimed] = await db
      .insert(discordGatewayReceipts)
      .values({ eventDigest, createdAt: nowDate() })
      .onConflictDoNothing()
      .returning({ eventDigest: discordGatewayReceipts.eventDigest });
    signal.throwIfAborted();
    if (!claimed) {
      return;
    }
    // Reply only in the sender's own one-to-one DM with the bot.
    const channel = await discordClient.fetchDiscordChannel(
      { botToken: args.botToken, channelId: message.channel_id },
      signal,
    );
    signal.throwIfAborted();
    if (
      channel.kind === "ok" &&
      (channel.data.id !== message.channel_id ||
        channel.data.type !== 1 ||
        channel.data.guild_id !== undefined ||
        channel.data.recipients?.length !== 1 ||
        channel.data.recipients[0]?.id !== message.author.id)
    ) {
      return;
    }
    const sent =
      channel.kind === "ok"
        ? await discordClient.createDiscordMessage(
            {
              botToken: args.botToken,
              channelId: message.channel_id,
              content: noticeContent(args.kind),
              // A retried send in this window returns the original notice.
              nonce: eventDigest.slice(0, 25),
            },
            signal,
          )
        : channel;
    signal.throwIfAborted();
    if (sent.kind !== "ok") {
      // Let a later DM in this window try again.
      await db
        .delete(discordGatewayReceipts)
        .where(eq(discordGatewayReceipts.eventDigest, eventDigest));
    }
  },
);
