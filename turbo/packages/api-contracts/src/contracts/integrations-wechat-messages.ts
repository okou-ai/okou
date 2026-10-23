import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { wechatBindingSchema } from "./integrations-wechat";
import { apiErrorSchema } from "./errors";

const c = initContract();
export const wechatAttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "audio", "video", "file"]),
  filename: z.string(),
  size: z.number().int().nonnegative().nullable(),
});
export const wechatStoredMessageSchema = z.object({
  id: z.uuid(),
  providerMessageId: z.string().nullable(),
  direction: z.enum(["inbound", "outbound"]),
  status: z.enum(["received", "sent", "unknown"]),
  content: z.string(),
  quotedText: z.string().nullable(),
  attachments: z.array(wechatAttachmentSchema),
  timestamp: z.iso.datetime(),
});
export const wechatHistoryQuerySchema = z
  .object({
    channelId: z.uuid(),
    before: z.uuid().optional(),
    oldest: z.iso.datetime({ offset: true }).optional(),
    latest: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (query) => {
      return (
        !query.oldest ||
        !query.latest ||
        Date.parse(query.oldest) < Date.parse(query.latest)
      );
    },
    {
      message: "oldest must be earlier than latest",
      path: ["oldest"],
    },
  );
export const wechatSendBodySchema = z.object({
  channelId: z.uuid(),
  operationId: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => {
      return value.trim().length > 0;
    }, "Message text must not be blank"),
});
export const wechatReceiptSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  providerMessageId: z.string().nullable(),
  url: z.null(),
});
export const wechatSendErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    deliveredMessages: z.array(wechatReceiptSchema).optional(),
    uncertainMessageId: z.uuid().optional(),
  }),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
};
export const integrationsWechatMessagesContract = c.router({
  listChannels: {
    method: "GET",
    path: "/api/integrations/wechat/channels",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        channels: z.array(
          z.object({
            id: z.uuid(),
            binding: wechatBindingSchema,
            name: z.string(),
            status: z.enum(["active", "reconnect_required"]),
          }),
        ),
      }),
      ...errors,
    },
    summary: "List the caller's verified WeChat direct conversation",
  },
  history: {
    method: "GET",
    path: "/api/integrations/wechat/messages",
    headers: authHeadersSchema,
    query: wechatHistoryQuerySchema,
    responses: {
      200: z.object({
        channelId: z.uuid(),
        messages: z.array(wechatStoredMessageSchema),
        nextBefore: z.uuid().nullable(),
        historyScope: z.literal("okou_received_and_sent"),
      }),
      ...errors,
    },
    summary: "Read one bounded page of WeChat messages recorded by Okou",
  },
  sendMessage: {
    method: "POST",
    path: "/api/integrations/wechat/message",
    headers: authHeadersSchema,
    body: wechatSendBodySchema,
    responses: {
      200: z.object({
        operationId: z.uuid(),
        messages: z.array(wechatReceiptSchema),
      }),
      ...errors,
      409: wechatSendErrorSchema,
      502: wechatSendErrorSchema,
      404: wechatSendErrorSchema,
      403: wechatSendErrorSchema,
    },
    summary: "Send text to the caller's verified WeChat direct conversation",
  },
});
export type WechatHistoryQuery = z.infer<typeof wechatHistoryQuerySchema>;
export type WechatStoredMessage = z.infer<typeof wechatStoredMessageSchema>;
export type WechatSendBody = z.infer<typeof wechatSendBodySchema>;
export type WechatReceipt = z.infer<typeof wechatReceiptSchema>;
