import {
  boolean,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

export const agentphoneDeliveryTargetSchema = object({
  messageId: string().min(1),
  conversationId: string().nullable(),
  // Direct messages do not have a provider group ID.
  groupId: string().nullable().optional(),
  channel: zEnum(["imessage", "sms", "mms", "whatsapp"]),
  isGroup: boolean(),
  rootMessageId: string().min(1),
  phoneHandle: string().min(1),
  fromNumber: string().min(1),
  toNumber: string().min(1),
  userLinkId: uuid(),
  agentId: uuid(),
  agentphoneAgentId: string().min(1),
});

export type AgentPhoneDeliveryTarget = zInfer<
  typeof agentphoneDeliveryTargetSchema
>;

export const agentphoneChatCallbackPayloadSchema =
  agentphoneDeliveryTargetSchema.extend({
    chatEventId: uuid(),
  });
