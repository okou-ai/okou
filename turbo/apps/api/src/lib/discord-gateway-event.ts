import {
  array,
  boolean,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";

import {
  discordAttachmentSchema,
  discordMessageReferenceSchema,
  discordSnowflakeSchema,
  discordUserSchema,
} from "../signals/external/discord-client";

export const discordMessageCreateSchema = object({
  id: discordSnowflakeSchema,
  channel_id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  author: discordUserSchema,
  content: string().max(4000),
  mentions: array(discordUserSchema).max(100),
  attachments: array(discordAttachmentSchema).max(10),
  message_reference: discordMessageReferenceSchema.optional(),
  webhook_id: discordSnowflakeSchema.optional(),
  type: number().int(),
  edited_timestamp: string().nullable().optional(),
});

export type DiscordMessageCreate = zInfer<typeof discordMessageCreateSchema>;

export const discordGuildDeleteSchema = object({
  id: discordSnowflakeSchema,
  unavailable: boolean().optional(),
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
