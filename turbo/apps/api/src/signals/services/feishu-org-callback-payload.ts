import { z } from "zod";

export const feishuOrgCallbackFileSchema = z.object({
  fileId: z.string().min(1),
  messageId: z.string().min(1),
  fileKey: z.string().min(1),
  type: z.enum(["file", "image"]),
});

export const feishuOrgCallbackPayloadSchema = z
  .object({
    installationId: z.string().uuid(),
    chatId: z.string(),
    messageId: z.string(),
    connectionId: z.string(),
    sessionKey: z.string().optional(),
    agentId: z.string().uuid().optional(),
    existingSessionId: z.string().uuid().optional(),
    reactionId: z.string().optional(),
    replyInThread: z.boolean().optional(),
    files: z.array(feishuOrgCallbackFileSchema).optional(),
    canonicalChatDelivery: z.boolean().optional(),
  })
  .passthrough();

export type FeishuOrgCallbackPayload = z.infer<
  typeof feishuOrgCallbackPayloadSchema
>;
