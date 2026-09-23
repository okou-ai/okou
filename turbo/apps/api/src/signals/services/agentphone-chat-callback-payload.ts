import { z } from "zod";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";

export const agentphoneDeliveryTargetSchema = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().nullable(),
  // Nullable for run callbacks created before the group-id migration.
  groupId: z.string().nullable().default(null),
  channel: z.enum(["imessage", "sms", "mms"]),
  isGroup: z.boolean(),
  rootMessageId: z.string().min(1),
  phoneHandle: z.string().min(1),
  fromNumber: z.string().min(1),
  toNumber: z.string().min(1),
  userLinkId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentphoneAgentId: z.string().min(1),
});

export type AgentPhoneDeliveryTarget = z.infer<
  typeof agentphoneDeliveryTargetSchema
>;

export const agentphoneChatCallbackPayloadSchema =
  agentphoneDeliveryTargetSchema.extend({
    chatEventId: z.string().uuid(),
    publicBrand: publicBrandSchema,
  });
