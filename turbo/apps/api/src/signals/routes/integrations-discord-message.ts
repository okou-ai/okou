import { command } from "ccstate";
import {
  integrationsDiscordMessageContract,
  type SendDiscordMessageResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-message";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { discordClient } from "../external/discord-client";
import {
  discordMessageUrl,
  splitDiscordMessage,
} from "../../lib/discord-message";
import { requireDiscordConversationAccess$ } from "../services/discord-access.service";
import {
  discordApiFailure,
  type DiscordFailureResponse,
} from "../services/discord-api-response";
import type { RouteEntry } from "../route-entry";

function partialFailure(
  response: DiscordFailureResponse,
  deliveredMessages: SendDiscordMessageResponse["messages"],
) {
  return {
    ...response,
    body: { error: { ...response.body.error, deliveredMessages } },
  };
}

const sendMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    bodyResultOf(integrationsDiscordMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const messages: SendDiscordMessageResponse["messages"] = [];
  for (const content of splitDiscordMessage(body.data.text)) {
    const access = await set(
      requireDiscordConversationAccess$,
      {
        ...auth,
        guildId: body.data.guildId,
        channelId: body.data.channelId,
        mode: "write",
      },
      signal,
    );
    if (access.kind === "denied") {
      return partialFailure(access.response, messages);
    }
    const sent = await discordClient.createDiscordMessage(
      { botToken: access.botToken, channelId: body.data.channelId, content },
      signal,
    );
    if (sent.kind !== "ok") {
      return partialFailure(discordApiFailure(sent), messages);
    }
    if (sent.data.channel_id !== body.data.channelId) {
      throw new Error(
        "Discord sent message response has another channel identity",
      );
    }
    messages.push({
      id: sent.data.id,
      channelId: sent.data.channel_id,
      url: discordMessageUrl({
        guildId: access.channel.guild_id,
        channelId: sent.data.channel_id,
        messageId: sent.data.id,
      }),
    });
  }
  return { status: 200 as const, body: { messages } };
});

export const integrationsDiscordMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsDiscordMessageContract.sendMessage,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "discord:write",
      },
      sendMessage$,
    ),
  },
];
