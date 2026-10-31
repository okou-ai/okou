import {
  boolean,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

export const telegramDeliveryTargetSchema = object({
  installationId: string().min(1),
  chatId: string().min(1),
  messageId: string().min(1),
  rootMessageId: string().nullable(),
  userLinkId: uuid(),
  userLinkKind: literal("official"),
  agentId: string().min(1),
  isDM: boolean(),
  messageThreadId: number().int().optional(),
  thinkingMessageId: string().nullable().optional(),
});

export type TelegramDeliveryTarget = zInfer<
  typeof telegramDeliveryTargetSchema
>;

export const telegramChatCallbackPayloadSchema =
  telegramDeliveryTargetSchema.extend({
    chatEventId: uuid(),
  });
