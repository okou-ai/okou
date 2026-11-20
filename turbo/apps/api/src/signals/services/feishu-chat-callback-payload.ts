import { array, boolean, object, string, type infer as zInfer } from "zod";

import { feishuRunFileSchema } from "./feishu-run-file-index";

export const feishuDeliveryTargetSchema = object({
  installationId: string(),
  connectionId: string(),
  chatId: string(),
  messageId: string(),
  threadId: string(),
  replyInThread: boolean(),
  reactionId: string().optional(),
  files: array(feishuRunFileSchema).optional(),
});

export type FeishuDeliveryTarget = zInfer<typeof feishuDeliveryTargetSchema>;

export const feishuChatCallbackPayloadSchema =
  feishuDeliveryTargetSchema.extend({
    chatEventId: string(),
  });
