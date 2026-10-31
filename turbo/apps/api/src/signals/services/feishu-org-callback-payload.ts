import {
  array,
  boolean,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

export const feishuOrgCallbackFileSchema = object({
  fileId: string().min(1),
  messageId: string().min(1),
  fileKey: string().min(1),
  type: zEnum(["file", "image"]),
});

export const feishuOrgCallbackPayloadSchema = object({
  installationId: uuid(),
  chatId: string(),
  messageId: string(),
  connectionId: string(),
  sessionKey: string().optional(),
  agentId: uuid().optional(),
  existingSessionId: uuid().optional(),
  reactionId: string().optional(),
  replyInThread: boolean().optional(),
  files: array(feishuOrgCallbackFileSchema).optional(),
  canonicalChatDelivery: boolean().optional(),
}).passthrough();

export type FeishuOrgCallbackPayload = zInfer<
  typeof feishuOrgCallbackPayloadSchema
>;
