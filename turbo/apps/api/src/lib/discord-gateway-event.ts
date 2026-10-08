import { z } from "zod";
import {
  discordAttachmentSchema,
  discordSnowflakeSchema,
  discordUserSchema,
} from "../signals/external/discord-client";

export const discordMessageCreateSchema = z.object({
  id: discordSnowflakeSchema,
  channel_id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  author: discordUserSchema,
  content: z.string().max(4000),
  mentions: z.array(discordUserSchema).max(100),
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
