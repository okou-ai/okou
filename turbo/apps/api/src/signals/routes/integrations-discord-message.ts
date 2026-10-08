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
import {
  requireDiscordBinding$,
  requireDiscordConversationAccess$,
} from "../services/discord-access.service";
import {
  discordMessageSendFooterText,
  integrationMessageSendLabels$,
} from "../services/integration-message-context.service";
import { readDiscordContextMessage$ } from "../services/discord-context.service";
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
      replyToMessageId?: string;
    },
    signal: AbortSignal,
  ) => {
    let retryDeadline: number | undefined;
    let retryFailure: DiscordFailureResponse | undefined;
    for (let attempt = 1; ; attempt += 1) {
      let access = await set(
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
      if (args.replyToMessageId && access.channel.type !== 1) {
        const referenced = await set(
          readDiscordContextMessage$,
          { ...args, messageId: args.replyToMessageId },
          signal,
        );
        if (referenced.kind === "denied") {
          return referenced;
        }
        // Reference reads may outlive a permission or binding change.
        access = await set(
          requireDiscordConversationAccess$,
          { ...args, mode: "write" },
          signal,
        );
        if (access.kind === "denied") {
          return access;
        }
      }
      // Never read bot DM content. Discord validates an own-DM reference on send.
      const sent = await discordClient.createDiscordMessage(
        {
          botToken: access.botToken,
          channelId: args.channelId,
          content: args.content,
          replyToMessageId: args.replyToMessageId,
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
  const binding = await set(
    requireDiscordBinding$,
    { ...auth, guildId: body.data.guildId },
    signal,
  );
  if (binding.kind === "denied") {
    return partialFailure(binding.response, []);
  }
  const labels = await get(integrationMessageSendLabels$);
  signal.throwIfAborted();
  const footerText = discordMessageSendFooterText({
    ...labels,
    discordUserId: binding.binding.discordUserId,
  });
  const text = footerText
    ? `${body.data.text}\n\n-# ${footerText}`
    : body.data.text;
  const messages: SendDiscordMessageResponse["messages"] = [];
  for (const content of splitDiscordMessage(text)) {
    const result = await set(
      sendChunk$,
      {
        ...auth,
        guildId: body.data.guildId,
        channelId: body.data.channelId,
        content,
        ...(messages.length === 0 && body.data.replyToMessageId !== undefined
          ? { replyToMessageId: body.data.replyToMessageId }
          : {}),
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
