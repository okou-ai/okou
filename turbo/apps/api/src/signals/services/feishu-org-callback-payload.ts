import { z } from "zod";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

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

/**
 * Rollback compatibility (#36766): APIs released before the Feishu brand
 * retirement require `publicBrand` when they parse stored `feishu:chat` and
 * `feishu:org` payloads. Current readers ignore it. Surface: persisted payload
 * read by an older API. Remove once those APIs have drained and are no longer
 * rollback targets, with the Feishu `public_brand` column drop.
 */
export const FEISHU_CALLBACK_ROLLBACK_PUBLIC_BRAND = PUBLIC_BRAND;

export type FeishuOrgCallbackPayload = z.infer<
  typeof feishuOrgCallbackPayloadSchema
>;
