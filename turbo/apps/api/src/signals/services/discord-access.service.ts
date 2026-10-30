import { command, computed, type Computed } from "ccstate";
import { now } from "../../lib/time";
import { joinAll, settle } from "../utils";
import { getDiscordAppConfig, type DiscordAppConfig } from "./discord-config";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$ } from "../external/db";
import {
  createDiscordUserBinding,
  discordUserBindingReadPlan,
  discordBindingFromMemberships,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { discordClient, type DiscordChannel } from "../external/discord-client";
import {
  discordApiFailure,
  discordDmReadDenied,
  discordUnavailable,
  type DiscordFailureResponse,
} from "./discord-api-response";
import {
  authorizeDiscordSnapshot,
  resolveDiscordProviderConversationAccess,
  resolveDiscordProviderAccess,
  type DiscordAccessMode,
} from "./discord-provider-access";

import {
  measureApiDispatchTiming,
  type ApiDispatchTimingCollector,
} from "./api-dispatch-timing.service";

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

function discordBindingAccessResult(
  identity: DiscordBindingIdentity,
  config: DiscordAppConfig | null,
  binding: DiscordVerifiedBinding | null,
): DiscordBindingAccess {
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
  if (!binding) {
    return { kind: "denied", response: discordUnavailable() };
  }
  return {
    kind: "allowed",
    binding: identity.guildId
      ? { ...binding, guildId: identity.guildId }
      : binding,
    botToken: config.botToken,
    applicationId: config.applicationId,
  };
}

function createDiscordBindingAccess(
  identity$: Computed<Promise<DiscordBindingIdentity | null>>,
): Computed<Promise<DiscordBindingAccess | null>> {
  const binding$ = createDiscordUserBinding(identity$);
  return computed(async (get): Promise<DiscordBindingAccess | null> => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const config = getDiscordAppConfig();
    const binding = config ? await get(binding$) : null;
    return discordBindingAccessResult(identity, config, binding);
  });
}

export const requireDiscordBinding$ = command(
  async (
    { get },
    args: { orgId: string; userId: string; guildId?: string },
    signal: AbortSignal,
  ): Promise<DiscordBindingAccess> => {
    signal.throwIfAborted();
    const access = await (async () => {
      const config = getDiscordAppConfig();
      if (!config) {
        return discordBindingAccessResult(args, config, null);
      }
      const readPlan = discordUserBindingReadPlan(args);
      if (!getDiscordAppConfig()) {
        return discordBindingAccessResult(args, config, null);
      }
      const db = get(db$);
      const rows = await db
        .select(readPlan.columns)
        .from(readPlan.from)
        .innerJoin(readPlan.join, readPlan.joinCondition)
        .where(readPlan.where);
      const verified: DiscordVerifiedBinding[] = [];
      for (const row of rows) {
        const membership = await settle(
          get(clerk$).organizations.getOrganizationMembershipList({
            organizationId: row.orgId,
            userId: [row.userId],
            limit: 1,
          }),
        );
        if (!membership.ok) {
          if (isClerkResourceNotFound(membership.error)) {
            continue;
          }
          throw membership.error;
        }
        const binding = discordBindingFromMemberships(
          row,
          membership.value.data,
        );
        if (binding) {
          verified.push(binding);
        }
      }
      const [binding] = verified;
      const scopedBinding =
        binding?.userId === args.userId && binding.orgId === args.orgId
          ? binding
          : null;
      return discordBindingAccessResult(args, config, scopedBinding);
    })();
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

interface DiscordPromptAccessInput extends DiscordBindingIdentity {
  readonly connectionId: string;
  readonly discordUserId: string;
  readonly sourceChannelId: string;
  readonly destinationChannelId: string;
  readonly hasConversationContext: boolean;
}

function checkedPromptAccess<T extends { kind: "allowed" }>(
  access: T | { kind: "denied"; response: DiscordFailureResponse },
): T | null {
  if (access.kind === "allowed") {
    return access;
  }
  if (access.response.status === 403 || access.response.status === 404) {
    return null;
  }
  throw new Error(`Discord access check failed: ${access.response.status}`);
}

/** Shared by queued launch and active-input reads, once per authority boundary. */
async function loadDiscordPromptAccess(
  input: DiscordPromptAccessInput,
  current: DiscordBindingAccess,
  timing: ApiDispatchTimingCollector | undefined,
  signal?: AbortSignal,
) {
  const binding = checkedPromptAccess(current);
  if (
    !binding ||
    binding.binding.connectionId !== input.connectionId ||
    binding.binding.discordUserId !== input.discordUserId
  ) {
    return null;
  }
  const [provider, application] = await joinAll([
    measureApiDispatchTiming(
      timing,
      "api_dispatch_discord_prompt_provider",
      "nested",
      () => {
        return resolveDiscordProviderConversationAccess(
          {
            ...binding.binding,
            guildId: input.guildId,
            botToken: binding.botToken,
            sourceChannelId: input.sourceChannelId,
            destinationChannelId: input.destinationChannelId,
          },
          signal,
        );
      },
    ),
    input.hasConversationContext && input.guildId
      ? measureApiDispatchTiming(
          timing,
          "api_dispatch_discord_prompt_capability",
          "nested",
          () => {
            return discordClient.fetchDiscordCurrentApplication(
              binding,
              signal,
            );
          },
        )
      : null,
  ]);
  const access = checkedPromptAccess(provider);
  if (!access) {
    return null;
  }
  if (application && application.kind !== "ok") {
    checkedPromptAccess({
      kind: "denied",
      response: discordApiFailure(application),
    });
  }
  const messageContentEnabled =
    application?.kind === "ok" && application.data.messageContentEnabled;
  // DM history is shared across orgs. Neither its content nor an absent guild
  // context needs a MESSAGE_CONTENT lookup or a history permission check.
  const conversationContextAllowed =
    input.hasConversationContext &&
    access.source.channel.type !== 1 &&
    messageContentEnabled &&
    authorizeDiscordSnapshot(access.source.snapshot, { mode: "read" }).kind ===
      "allowed";
  return {
    ...binding,
    channel: access.destination.channel,
    messageContentEnabled,
    conversationContextAllowed,
  };
}

/** Computed memoization shares the in-flight read set within one launch only. */
export function discordPromptAccess(
  input$: Computed<Promise<DiscordPromptAccessInput | null>>,
  timing$?: Computed<ApiDispatchTimingCollector>,
) {
  const binding$ = createDiscordBindingAccess(input$);
  return computed(async (get) => {
    const input = await get(input$);
    if (!input) {
      return null;
    }
    const timing = timing$ ? get(timing$) : undefined;
    const startedAt = timing ? performance.now() : undefined;
    const current = await (async () => {
      return await get(binding$);
    })().finally(() => {
      if (startedAt !== undefined) {
        timing?.recordDuration(
          "api_dispatch_discord_prompt_binding",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      }
    });
    return current
      ? await loadDiscordPromptAccess(input, current, timing)
      : null;
  });
}

/** Each active-input delivery rechecks current membership and provider facts. */
export const requireDiscordPromptAccess$ = command(
  async ({ set }, input: DiscordPromptAccessInput, signal: AbortSignal) => {
    const current = await set(requireDiscordBinding$, input, signal);
    return await loadDiscordPromptAccess(input, current, undefined, signal);
  },
);

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
      allowOtherDmRecipients?: boolean;
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
        guildId: args.guildId,
        botToken: current.botToken,
        channelId: args.channelId,
        mode: args.mode,
        attachFiles: args.attachFiles,
        createPublicThread: args.createPublicThread,
        allowOtherDmRecipients: args.allowOtherDmRecipients,
      },
      signal,
    );
    if (access.kind === "denied") {
      return access;
    }
    if (args.mode === "write" || access.channel.type === 1) {
      return {
        ...current,
        binding: {
          ...current.binding,
          guildId: access.channel.guild_id ?? current.binding.guildId,
        },
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
      binding: {
        ...current.binding,
        guildId: access.channel.guild_id ?? current.binding.guildId,
      },
      channel: access.channel,
      messageContentEnabled: application.data.messageContentEnabled,
    };
  },
);

/**
 * Reads channel content on a run's behalf: history pages, native thread
 * replies and attachment downloads. Discord gives the bot one DM channel per
 * user, shared by every org that user is bound in, and its messages record no
 * org, so no run token may read DM content. Explicit outbound DMs use write
 * access and stay available.
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
