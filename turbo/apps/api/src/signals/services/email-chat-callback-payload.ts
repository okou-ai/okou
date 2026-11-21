import { object, uuid, type infer as zInfer } from "zod";

export const emailDeliveryTargetSchema = object({
  emailMessageId: uuid(),
  userLinkId: uuid(),
});

export type EmailDeliveryTarget = zInfer<typeof emailDeliveryTargetSchema>;
export const emailChatCallbackPayloadSchema = emailDeliveryTargetSchema.extend({
  chatEventId: uuid(),
});
