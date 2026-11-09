import { object, uuid, string, type infer as zInfer } from "zod";

export const emailDeliveryTargetSchema = object({
  emailMessageId: uuid(),
  userLinkId: uuid(),
  agentId: string().min(1),
});

export type EmailDeliveryTarget = zInfer<typeof emailDeliveryTargetSchema>;
export const emailChatCallbackPayloadSchema = emailDeliveryTargetSchema.extend({
  chatEventId: uuid(),
});
