import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  discordNativeErrorSchema,
  discordSnowflakeSchema,
} from "./integrations-discord-read";

const c = initContract();

export const sendDiscordMessageBodySchema = z.object({
  guildId: discordSnowflakeSchema.optional(),
  channelId: discordSnowflakeSchema,
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine(
      (value) => {
        return value.trim().length > 0;
      },
      { message: "Message text must not be blank" },
    ),
});

export const discordSentMessageSchema = z.object({
  id: discordSnowflakeSchema,
  channelId: discordSnowflakeSchema,
  url: z.string().url(),
});

export const discordSendErrorSchema = discordNativeErrorSchema.extend({
  error: discordNativeErrorSchema.shape.error.extend({
    deliveredMessages: z.array(discordSentMessageSchema).optional(),
  }),
});

const sendDiscordMessageResponseSchema = z.object({
  messages: z.array(discordSentMessageSchema).min(1),
});

/** Sends as the organization bot with mention notifications disabled. */
export const integrationsDiscordMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/integrations/discord/message",
    headers: authHeadersSchema,
    body: sendDiscordMessageBodySchema,
    responses: {
      200: sendDiscordMessageResponseSchema,
      400: discordSendErrorSchema,
      401: apiErrorSchema,
      403: discordSendErrorSchema,
      404: discordSendErrorSchema,
      429: discordSendErrorSchema,
      502: discordSendErrorSchema,
      503: discordSendErrorSchema,
    },
    summary: "Send text to an authorized Discord channel, thread or bot DM",
  },
});

export type SendDiscordMessageBody = z.infer<
  typeof sendDiscordMessageBodySchema
>;
export type SendDiscordMessageResponse = z.infer<
  typeof sendDiscordMessageResponseSchema
>;
