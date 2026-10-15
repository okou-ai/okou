import { command } from "ccstate";
import type { DiscordHistoryMessage } from "@okouai/api-contracts/contracts/integrations-discord-read";
import {
  discordClient,
  type DiscordAttachment,
  type DiscordMessage,
} from "../external/discord-client";
import { discordMessageUrl } from "../../lib/discord-message";
import {
  requireDiscordRunReadAccess$,
  type DiscordConversationAccess,
} from "./discord-access.service";
import { discordApiFailure } from "./discord-api-response";

/**
 * Attachment CDN URLs are signed bearer links, so native reads return only
 * metadata; `download-file` re-authorizes each fetch by attachment ID.
 */
export function projectDiscordMessage(
  message: DiscordMessage,
  guildId: string | undefined,
): DiscordHistoryMessage {
  return {
    id: message.id,
    channelId: message.channel_id,
    content: message.content,
    author: message.author,
    timestamp: message.timestamp,
    ...(message.message_reference?.message_id &&
    (message.message_reference.type === undefined ||
      message.message_reference.type === 0)
      ? {
          replyTo: {
            messageId: message.message_reference.message_id,
            ...(message.message_reference.channel_id !== undefined && {
              channelId: message.message_reference.channel_id,
            }),
          },
        }
      : {}),
    url: discordMessageUrl({
      guildId,
      channelId: message.channel_id,
      messageId: message.id,
    }),
    attachments: message.attachments.map((attachment: DiscordAttachment) => {
      return {
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        ...(attachment.content_type !== undefined && {
          contentType: attachment.content_type,
        }),
      };
    }),
  };
}

/** One bounded provider page; the caller owns any further context pagination. */
export const readDiscordHistoryPage$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      guildId?: string;
      channelId: string;
      before?: string;
      limit: number;
    },
    signal: AbortSignal,
  ) => {
    const access = await set(requireDiscordRunReadAccess$, args, signal);
    if (access.kind === "denied") {
      return access;
    }
    return await readDiscordHistoryWithAccess(access, args, signal);
  },
);

/** An explicitly referenced message shares the history permission boundary. */
export const readDiscordContextMessage$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      guildId?: string;
      channelId: string;
      messageId: string;
    },
    signal: AbortSignal,
  ) => {
    const access = await set(requireDiscordRunReadAccess$, args, signal);
    if (access.kind === "denied") {
      return access;
    }
    return await readDiscordMessageWithAccess(access, args.messageId, signal);
  },
);

type AuthorizedDiscordContext = Extract<
  DiscordConversationAccess,
  { readonly kind: "allowed" }
>;

/** Read one page with authority already established by the owning operation. */
export async function readDiscordHistoryWithAccess(
  access: AuthorizedDiscordContext,
  args: { readonly before?: string; readonly limit: number },
  signal: AbortSignal,
) {
  const result = await discordClient.fetchDiscordMessages(
    {
      botToken: access.botToken,
      channelId: access.channel.id,
      before: args.before,
      limit: args.limit,
    },
    signal,
  );
  if (result.kind !== "ok") {
    return { kind: "denied" as const, response: discordApiFailure(result) };
  }
  if (
    result.data.some((message) => {
      return message.channel_id !== access.channel.id;
    })
  ) {
    throw new Error("Discord history returned a message from another channel");
  }
  const messages = [...result.data].sort((a, b) => {
    return BigInt(a.id) > BigInt(b.id)
      ? -1
      : BigInt(a.id) < BigInt(b.id)
        ? 1
        : 0;
  });
  return {
    kind: "ok" as const,
    contextMode: access.messageContentEnabled
      ? ("full" as const)
      : ("mentions_only" as const),
    channel: access.channel,
    binding: access.binding,
    messages,
    nextBefore: messages.length === args.limit ? messages.at(-1)!.id : null,
  };
}

/** Read a referenced message within the same authorized channel snapshot. */
export async function readDiscordMessageWithAccess(
  access: AuthorizedDiscordContext,
  messageId: string,
  signal: AbortSignal,
) {
  const result = await discordClient.fetchDiscordMessage(
    {
      botToken: access.botToken,
      channelId: access.channel.id,
      messageId: messageId,
    },
    signal,
  );
  if (result.kind !== "ok") {
    return { kind: "denied" as const, response: discordApiFailure(result) };
  }
  if (
    result.data.channel_id !== access.channel.id ||
    result.data.id !== messageId
  ) {
    throw new Error("Discord context message has another message identity");
  }
  return {
    kind: "ok" as const,
    binding: access.binding,
    message: result.data,
  };
}
