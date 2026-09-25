import { z } from "zod";

export const telegramDeliveryTargetSchema = z.object({
  installationId: z.string().min(1),
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  rootMessageId: z.string().nullable(),
  userLinkId: z.string().uuid(),
  userLinkKind: z.enum(["custom", "official"]),
  agentId: z.string().min(1),
  isDM: z.boolean(),
  messageThreadId: z.number().int().optional(),
  thinkingMessageId: z.string().nullable().optional(),
});

export type TelegramDeliveryTarget = z.infer<
  typeof telegramDeliveryTargetSchema
>;

export const telegramChatCallbackPayloadSchema =
  telegramDeliveryTargetSchema.extend({
    chatEventId: z.string().uuid(),
  });
