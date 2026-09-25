import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} from "node:crypto";

import type {
  DiscordCommandInteraction,
  DiscordComponentInteraction,
} from "@okouai/api-contracts/contracts/discord-interactions";
import { z } from "zod";

import { now } from "./time";

const DISCORD_REPLAY_WINDOW_SECONDS = 5 * 60;
const DISCORD_FUTURE_WINDOW_SECONDS = 30;
const PICKER_LIFETIME_SECONDS = 15 * 60;
const PICKER_MAC_DOMAIN = "okou.discord.preference.v1\0";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DiscordInteractionActor {
  readonly discordUserId: string;
  readonly applicationId: string;
  readonly channelId: string;
  readonly guildId: string | null;
}

const pickerStateSchema = z.object({
  action: z.enum(["agent", "model", "org"]),
  page: z.number().int().min(0).max(4_294_967_295),
  // Organization selection happens before a DM has selected its binding.
  connectionId: z.union([z.uuid(), z.literal("-")]),
});

export type DiscordPickerState = z.infer<typeof pickerStateSchema>;
export type DiscordPickerAction = DiscordPickerState["action"];

export function verifyDiscordInteractionSignature(args: {
  readonly publicKey: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly body: Uint8Array;
}): boolean {
  if (
    !/^[0-9a-f]{64}$/i.test(args.publicKey) ||
    !/^[0-9a-f]{128}$/i.test(args.signature) ||
    !/^(0|[1-9][0-9]{0,12})$/.test(args.timestamp)
  ) {
    return false;
  }

  const requestTime = Number(args.timestamp);
  const currentTime = Math.floor(now() / 1000);
  if (
    requestTime < currentTime - DISCORD_REPLAY_WINDOW_SECONDS ||
    requestTime > currentTime + DISCORD_FUTURE_WINDOW_SECONDS
  ) {
    return false;
  }

  const key = createPublicKey({
    key: Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(args.publicKey, "hex"),
    ]),
    format: "der",
    type: "spki",
  });

  return verify(
    null,
    Buffer.concat([Buffer.from(args.timestamp, "utf8"), args.body]),
    key,
    Buffer.from(args.signature, "hex"),
  );
}

export function resolveDiscordInteractionActor(
  interaction: DiscordCommandInteraction | DiscordComponentInteraction,
): DiscordInteractionActor | null {
  if (interaction.guild_id !== undefined) {
    if (interaction.member === undefined || interaction.user !== undefined) {
      return null;
    }
    return {
      discordUserId: interaction.member.user.id,
      applicationId: interaction.application_id,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
    };
  }

  if (interaction.user === undefined || interaction.member !== undefined) {
    return null;
  }
  return {
    discordUserId: interaction.user.id,
    applicationId: interaction.application_id,
    channelId: interaction.channel_id,
    guildId: null,
  };
}

function pickerMac(args: {
  readonly payload: string;
  readonly actor: DiscordInteractionActor;
  readonly botToken: string;
}): Buffer {
  return createHmac("sha256", args.botToken)
    .update(PICKER_MAC_DOMAIN)
    .update(args.payload)
    .update("\0")
    .update(
      JSON.stringify([
        args.actor.applicationId,
        args.actor.discordUserId,
        args.actor.channelId,
        args.actor.guildId,
      ]),
    )
    .digest()
    .subarray(0, 16);
}

export function createDiscordPickerCustomId(
  args: DiscordPickerState & {
    readonly actor: DiscordInteractionActor;
    readonly botToken: string;
  },
): string {
  const state = pickerStateSchema.parse(args);
  if (args.botToken.length === 0) {
    throw new Error("Discord picker signing requires the bot token");
  }

  const expiresAt = Math.floor(now() / 1000) + PICKER_LIFETIME_SECONDS;
  const connection =
    state.connectionId === "-"
      ? "-"
      : Buffer.from(state.connectionId.replaceAll("-", ""), "hex").toString(
          "base64url",
        );
  const payload = `okou:1:${state.action}:${state.page.toString(36)}:${expiresAt.toString(36)}:${connection}`;
  const mac = pickerMac({
    payload,
    actor: args.actor,
    botToken: args.botToken,
  });
  return `${payload}:${mac.toString("base64url")}`;
}

export function parseDiscordPickerCustomId(args: {
  readonly customId: string;
  readonly actor: DiscordInteractionActor;
  readonly botToken: string;
}): DiscordPickerState | null {
  if (args.customId.length > 100 || args.botToken.length === 0) {
    return null;
  }

  const match =
    /^okou:1:(agent|model|org):([0-9a-z]{1,7}):([0-9a-z]{1,11}):(-|[A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})$/.exec(
      args.customId,
    );
  if (!match) {
    return null;
  }
  const [, action, pageText, expiryText, connectionText, signature] = match;
  if (
    action === undefined ||
    pageText === undefined ||
    expiryText === undefined ||
    connectionText === undefined ||
    signature === undefined
  ) {
    return null;
  }

  const expiresAt = Number.parseInt(expiryText, 36);
  const currentTime = Math.floor(now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= currentTime ||
    expiresAt > currentTime + PICKER_LIFETIME_SECONDS
  ) {
    return null;
  }

  const payload = args.customId.slice(0, args.customId.lastIndexOf(":"));
  const expected = pickerMac({
    payload,
    actor: args.actor,
    botToken: args.botToken,
  });
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  const connectionHex = Buffer.from(connectionText, "base64url").toString(
    "hex",
  );
  const connectionId =
    connectionText === "-"
      ? "-"
      : `${connectionHex.slice(0, 8)}-${connectionHex.slice(8, 12)}-${connectionHex.slice(12, 16)}-${connectionHex.slice(16, 20)}-${connectionHex.slice(20)}`;
  const state = pickerStateSchema.safeParse({
    action,
    page: Number.parseInt(pageText, 36),
    connectionId,
  });
  return state.success ? state.data : null;
}
