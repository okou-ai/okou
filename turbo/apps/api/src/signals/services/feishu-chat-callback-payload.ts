import { array, boolean, object, string, type infer as zInfer } from "zod";

import { feishuOrgCallbackFileSchema } from "./feishu-org-callback-payload";

export const feishuDeliveryTargetSchema = object({
  installationId: string(),
  connectionId: string(),
  chatId: string(),
  messageId: string(),
  threadId: string(),
  replyInThread: boolean(),
  reactionId: string().optional(),
  files: array(feishuOrgCallbackFileSchema).optional(),
});

export type FeishuDeliveryTarget = zInfer<typeof feishuDeliveryTargetSchema>;

export const feishuChatCallbackPayloadSchema =
  feishuDeliveryTargetSchema.extend({
    chatEventId: string(),
  });
