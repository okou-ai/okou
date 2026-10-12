import { command, computed, type Computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getDiscordAppConfig } from "./discord-config";
import {
  createDiscordUserBinding,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { discordClient, type DiscordChannel } from "../external/discord-client";
import { discordMessageContentCapability } from "./discord-application-capability.service";
import {
  discordApiFailure,
  discordDmReadDenied,
  discordUnavailable,
  type DiscordFailureResponse,
} from "./discord-api-response";
import {
  resolveDiscordProviderAccess,
  type DiscordAccessMode,
} from "./discord-provider-access";

import { createUserFeatureSwitchContext } from "./feature-switches.service";

interface DiscordBindingIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly guildId?: string;
}

export type DiscordBindingAccess =
  | {
      kind: "allowed";
      binding: DiscordVerifiedBinding;
      botToken: string;
      applicationId: string;
    }
  | { kind: "denied"; response: DiscordFailureResponse };

/** A read snapshot for one authorization boundary, keyed only by identities. */
export function discordBindingAccess(args: DiscordBindingIdentity) {
  const identity$ = computed(() => {
    return Promise.resolve(args);
  });
  const access$ = createDiscordBindingAccess(identity$);
  return computed(async (get): Promise<DiscordBindingAccess> => {
    const access = await get(access$);
    if (!access) {
      throw new Error("Discord binding access is missing its identity");
    }
    return access;
  });
}

function createDiscordBindingAccess(
  identity$: Computed<Promise<DiscordBindingIdentity | null>>,
): Computed<Promise<DiscordBindingAccess | null>> {
  const features$ = createUserFeatureSwitchContext(identity$);
  const binding$ = createDiscordUserBinding(identity$);
  return computed(async (get): Promise<DiscordBindingAccess | null> => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const features = await get(features$);
    if (
      !features ||
      !isFeatureEnabled(FeatureSwitchKey.DiscordIntegration, features)
    ) {
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
    const binding = await get(binding$);
    if (
      !binding ||
      (identity.guildId !== undefined && binding.guildId !== identity.guildId)
    ) {
      return { kind: "denied", response: discordUnavailable() };
    }
    return {
      kind: "allowed",
      binding,
      botToken: config.botToken,
      applicationId: config.applicationId,
    };
  });
}

export const requireDiscordBinding$ = command(
  async (
    { get },
    args: { orgId: string; userId: string; guildId?: string },
    signal: AbortSignal,
  ): Promise<DiscordBindingAccess> => {
    signal.throwIfAborted();
    const access = await get(discordBindingAccess(args));
    signal.throwIfAborted();
    return access;
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

/** Each node is a fresh authority boundary, connected during graph construction. */
export function discordConversationAccess(
  input$: Computed<
    Promise<
      | (DiscordBindingIdentity & {
          readonly channelId: string;
          readonly mode: DiscordAccessMode;
        })
      | null
    >
  >,
): Computed<Promise<DiscordConversationAccess | null>> {
  const binding$ = createDiscordBindingAccess(input$);
  const capability$ = discordMessageContentCapability();
  return computed(async (get): Promise<DiscordConversationAccess | null> => {
    const input = await get(input$);
    if (!input) {
      return null;
    }
    const current = await get(binding$);
    if (!current || current.kind === "denied") {
      return current;
    }
    const access = await resolveDiscordProviderAccess({
      ...current.binding,
      botToken: current.botToken,
      channelId: input.channelId,
      mode: input.mode,
    });
    if (access.kind === "denied") {
      return access;
    }
    if (input.mode === "write" || access.channel.type === 1) {
      return {
        ...current,
        channel: access.channel,
        messageContentEnabled: false,
      };
    }
    const capability = await get(capability$);
    return capability.kind === "denied"
      ? capability
      : {
          ...current,
          channel: access.channel,
          messageContentEnabled: capability.enabled,
        };
  });
}

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
      createPublicThread?: boolean;
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
        createPublicThread: args.createPublicThread,
      },
      signal,
    );
    if (access.kind === "denied") {
      return access;
    }
    if (args.mode === "write" || access.channel.type === 1) {
      return {
        ...current,
        channel: access.channel,
        messageContentEnabled: false,
      };
    }
    const application = await discordClient.fetchDiscordCurrentApplication(
      current,
      signal,
    );
    if (application.kind !== "ok") {
      return { kind: "denied", response: discordApiFailure(application) };
    }
    return {
      ...current,
      channel: access.channel,
      messageContentEnabled: application.data.messageContentEnabled,
    };
  },
);

/**
 * Reads channel content on a run's behalf: history pages, native thread
 * replies and attachment downloads. Discord gives the bot one DM channel per
 * user, shared by every org that user is bound in, and its messages record no
 * org, so no run token may read DM content. Sends to the sender's own DM use
 * write access and stay available.
 */
export const requireDiscordRunReadAccess$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      guildId?: string;
      channelId: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordConversationAccess> => {
    const access = await set(
      requireDiscordConversationAccess$,
      { ...args, mode: "read" },
      signal,
    );
    if (access.kind === "allowed" && access.channel.type === 1) {
      return { kind: "denied", response: discordDmReadDenied() };
    }
    return access;
  },
);
