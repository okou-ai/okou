import { z } from "zod";

import { feishuOrgCallbackFileSchema } from "./feishu-org-callback-payload";

export const feishuDeliveryTargetSchema = z.object({
  installationId: z.string(),
  connectionId: z.string(),
  chatId: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  replyInThread: z.boolean(),
  reactionId: z.string().optional(),
  files: z.array(feishuOrgCallbackFileSchema).optional(),
});

export type FeishuDeliveryTarget = z.infer<typeof feishuDeliveryTargetSchema>;

export const feishuChatCallbackPayloadSchema =
  feishuDeliveryTargetSchema.extend({
    chatEventId: z.string(),
  });
