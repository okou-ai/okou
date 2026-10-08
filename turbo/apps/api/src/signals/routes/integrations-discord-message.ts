import { command } from "ccstate";
import { delay } from "signal-timers";
import { now } from "../../lib/time";
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

const sendChunk$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      guildId?: string;
      channelId: string;
      content: string;
    },
    signal: AbortSignal,
  ) => {
    let retryDeadline: number | undefined;
    let retryFailure: DiscordFailureResponse | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const access = await set(
        requireDiscordConversationAccess$,
        { ...args, mode: "write" },
        signal,
      );
      if (access.kind === "denied") {
        return access;
      }
      if (
        retryDeadline !== undefined &&
        now() >= retryDeadline &&
        retryFailure
      ) {
        return { kind: "denied" as const, response: retryFailure };
      }
      const sent = await discordClient.createDiscordMessage(
        {
          botToken: access.botToken,
          channelId: args.channelId,
          content: args.content,
        },
        signal,
      );
      if (sent.kind === "ok") {
        if (sent.data.channel_id !== args.channelId) {
          throw new Error(
            "Discord sent message response has another channel identity",
          );
        }
        return {
          kind: "delivered" as const,
          message: {
            id: sent.data.id,
            channelId: sent.data.channel_id,
            url: discordMessageUrl({
              guildId: access.channel.guild_id,
              channelId: sent.data.channel_id,
              messageId: sent.data.id,
            }),
          },
        };
      }
      const response = discordApiFailure(sent);
      if (
        sent.kind !== "discord-error" ||
        sent.status !== 429 ||
        sent.retryAfterMs === undefined
      ) {
        return { kind: "denied" as const, response };
      }
      retryDeadline ??= now() + 10_000;
      if (attempt >= 3 || sent.retryAfterMs >= retryDeadline - now()) {
        return { kind: "denied" as const, response };
      }
      retryFailure = response;
      await delay(sent.retryAfterMs, { signal });
      signal.throwIfAborted();
    }
  },
);

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
    const result = await set(
      sendChunk$,
      {
        ...auth,
        guildId: body.data.guildId,
        channelId: body.data.channelId,
        content,
      },
      signal,
    );
    if (result.kind === "denied") {
      return partialFailure(result.response, messages);
    }
    messages.push(result.message);
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
