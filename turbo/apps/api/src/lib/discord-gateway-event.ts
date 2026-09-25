import { z } from "zod";
import {
  discordAttachmentSchema,
  discordSnowflakeSchema,
  discordUserSchema,
} from "../signals/external/discord-client";

/** Discord's message content limit, including Nitro-length messages. */
const MAX_DISCORD_CONTENT_LENGTH = 4000;

export const discordMessageCreateSchema = z.object({
  id: discordSnowflakeSchema,
  channel_id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  author: discordUserSchema,
  content: z.string().max(MAX_DISCORD_CONTENT_LENGTH),
  // Discord does not cap user mentions separately. Each one, except a reply's
  // author, needs a `<@id>` token in content, so the content limit is a safe
  // bound; rejecting a legitimate message would dead-letter it silently.
  mentions: z.array(discordUserSchema).max(MAX_DISCORD_CONTENT_LENGTH),
  attachments: z.array(discordAttachmentSchema).max(10),
  webhook_id: discordSnowflakeSchema.optional(),
  type: z.number().int(),
  edited_timestamp: z.string().nullable().optional(),
});

export type DiscordMessageCreate = z.infer<typeof discordMessageCreateSchema>;

export const discordGuildDeleteSchema = z.object({
  id: discordSnowflakeSchema,
  unavailable: z.boolean().optional(),
});

export function isDiscordUserMessage(message: DiscordMessageCreate): boolean {
  return (
    !message.author.bot &&
    !message.webhook_id &&
    !message.edited_timestamp &&
    (message.type === 0 || message.type === 19)
  );
}

export function hasDiscordBotMention(
  message: DiscordMessageCreate,
  botUserId: string,
): boolean {
  return (
    message.mentions.some((mention) => {
      return mention.id === botUserId;
    }) &&
    (message.content.includes(`<@${botUserId}>`) ||
      message.content.includes(`<@!${botUserId}>`))
  );
}
