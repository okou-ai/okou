import { command } from "ccstate";
import {
  discordIntegrationEnabledForOwner,
  getDiscordAppConfig,
} from "./discord-config";
import {
  discordUserBinding,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import type { DiscordChannel } from "../external/discord-client";
import {
  discordUnavailable,
  type DiscordFailureResponse,
} from "./discord-api-response";
import {
  resolveDiscordProviderAccess,
  type DiscordAccessMode,
} from "./discord-provider-access";

type DiscordBindingAccess =
  | {
      kind: "allowed";
      binding: DiscordVerifiedBinding;
      botToken: string;
      messageContentEnabled: boolean;
    }
  | { kind: "denied"; response: DiscordFailureResponse };

export const requireDiscordBinding$ = command(
  async (
    { get },
    args: { orgId: string; userId: string; guildId?: string },
    signal: AbortSignal,
  ): Promise<DiscordBindingAccess> => {
    const enabled = await get(
      discordIntegrationEnabledForOwner(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (!enabled) {
      return {
        kind: "denied",
        response: {
          status: 403,
          body: {
            error: {
              code: "FORBIDDEN",
              message: "Discord integration is not available.",
            },
          },
        },
      };
    }
    const config = getDiscordAppConfig();
    if (!config) {
      return {
        kind: "denied",
        response: {
          status: 503,
          body: {
            error: {
              code: "DISCORD_NOT_CONFIGURED",
              message: "The Discord application is not configured.",
            },
          },
        },
      };
    }
    const binding = await get(discordUserBinding(args));
    signal.throwIfAborted();
    if (
      !binding ||
      (args.guildId !== undefined && binding.guildId !== args.guildId)
    ) {
      return { kind: "denied", response: discordUnavailable() };
    }
    return {
      kind: "allowed",
      binding,
      botToken: config.botToken,
      messageContentEnabled: config.messageContentEnabled,
    };
  },
);

export type DiscordConversationAccess =
  | {
      kind: "allowed";
      binding: DiscordVerifiedBinding;
      channel: DiscordChannel;
      botToken: string;
      messageContentEnabled: boolean;
    }
  | { kind: "denied"; response: DiscordFailureResponse };

/** Re-resolve this command at delivery time; never retain its earlier authority. */
export const requireDiscordConversationAccess$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      guildId?: string;
      channelId: string;
      mode: DiscordAccessMode;
      attachFiles?: boolean;
    },
    signal: AbortSignal,
  ): Promise<DiscordConversationAccess> => {
    const current = await set(requireDiscordBinding$, args, signal);
    if (current.kind === "denied") {
      return current;
    }
    const access = await resolveDiscordProviderAccess(
      {
        ...current.binding,
        botToken: current.botToken,
        channelId: args.channelId,
        mode: args.mode,
        attachFiles: args.attachFiles,
      },
      signal,
    );
    if (access.kind === "denied") {
      return access;
    }
    return { ...current, channel: access.channel };
  },
);
