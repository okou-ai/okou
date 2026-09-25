import { command } from "ccstate";
import {
  integrationsDiscordReadContract,
  type DiscordChannelListResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-read";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { discordClient } from "../external/discord-client";
import {
  requireDiscordBinding$,
  requireDiscordRunReadAccess$,
} from "../services/discord-access.service";
import {
  discordApiFailure,
  discordUnavailable,
} from "../services/discord-api-response";
import {
  loadDiscordGuildAccess,
  discordSharedChannelPermissions,
} from "../services/discord-provider-access";
import {
  projectDiscordMessage,
  readDiscordHistoryPage$,
} from "../services/discord-context.service";
import { isDiscordThread } from "../services/discord-permissions";
import type { RouteEntry } from "../route-entry";

const listChannels$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsDiscordReadContract.listChannels));
  const binding = await set(
    requireDiscordBinding$,
    { ...auth, ...query },
    signal,
  );
  if (binding.kind === "denied") {
    return binding.response;
  }
  const guild = await loadDiscordGuildAccess(
    { ...binding.binding, botToken: binding.botToken },
    signal,
  );
  if (guild.kind === "denied") {
    return guild.response;
  }
  const result = await discordClient.fetchDiscordGuildChannels(
    { botToken: binding.botToken, guildId: binding.binding.guildId },
    signal,
  );
  if (result.kind !== "ok") {
    return discordApiFailure(result);
  }
  const channels: DiscordChannelListResponse["channels"] = [];
  for (const channel of result.data) {
    // Forum and media channels hold posts as threads and have no readable
    // history of their own, so list only channels that history can read.
    if (
      ![0, 5].includes(channel.type) ||
      !discordSharedChannelPermissions(guild.access, channel, "view", false)
    ) {
      continue;
    }
    if (channel.name === undefined || channel.name === null) {
      throw new Error("Discord guild channel has no name");
    }
    channels.push({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      guildId: binding.binding.guildId,
      parentId: channel.parent_id ?? null,
    });
  }
  return { status: 200 as const, body: { channels } };
});

const history$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsDiscordReadContract.history));
  const page = await set(
    readDiscordHistoryPage$,
    { ...auth, ...query },
    signal,
  );
  if (page.kind === "denied") {
    return page.response;
  }
  return {
    status: 200 as const,
    body: {
      channelId: query.channelId,
      messages: page.messages.map((message) => {
        return projectDiscordMessage(message, page.channel.guild_id);
      }),
      nextBefore: page.nextBefore,
      contextMode: page.contextMode,
    },
  };
});

const replies$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsDiscordReadContract.replies));
  const access = await set(
    requireDiscordRunReadAccess$,
    { ...auth, ...query },
    signal,
  );
  if (access.kind === "denied") {
    return access.response;
  }
  const message = await discordClient.fetchDiscordMessage(
    {
      botToken: access.botToken,
      channelId: query.channelId,
      messageId: query.messageId,
    },
    signal,
  );
  if (message.kind !== "ok") {
    return discordApiFailure(message);
  }
  if (
    message.data.id !== query.messageId ||
    message.data.channel_id !== query.channelId
  ) {
    return discordUnavailable();
  }
  const threadId =
    message.data.thread?.id ??
    (message.data.flags !== undefined && (message.data.flags & 32) !== 0
      ? message.data.id
      : undefined);
  if (!threadId) {
    return discordUnavailable();
  }
  const page = await set(
    readDiscordHistoryPage$,
    { ...auth, ...query, channelId: threadId },
    signal,
  );
  if (page.kind === "denied") {
    return page.response;
  }
  if (
    !isDiscordThread(page.channel) ||
    page.channel.parent_id !== query.channelId
  ) {
    return discordUnavailable();
  }
  return {
    status: 200 as const,
    body: {
      channelId: query.channelId,
      messageId: query.messageId,
      threadId,
      messages: page.messages.map((entry) => {
        return projectDiscordMessage(entry, page.channel.guild_id);
      }),
      nextBefore: page.nextBefore,
      contextMode: page.contextMode,
    },
  };
});

const discordReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "discord:read",
} as const;

export const integrationsDiscordReadRoutes: readonly RouteEntry[] = [
  {
    route: integrationsDiscordReadContract.listChannels,
    handler: authRoute(discordReadAuth, listChannels$),
  },
  {
    route: integrationsDiscordReadContract.history,
    handler: authRoute(discordReadAuth, history$),
  },
  {
    route: integrationsDiscordReadContract.replies,
    handler: authRoute(discordReadAuth, replies$),
  },
];
