import {
  array,
  coerce,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  null as zNull,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { wechatBindingSchema } from "./integrations-wechat";
import { apiErrorSchema } from "./errors";

const c = initContract();
export const wechatAttachmentSchema = object({
  id: string(),
  kind: zEnum(["image", "audio", "video", "file"]),
  filename: string(),
  size: number().int().nonnegative().nullable(),
});
export const wechatStoredMessageSchema = object({
  id: uuid(),
  providerMessageId: string().nullable(),
  direction: zEnum(["inbound", "outbound"]),
  status: zEnum(["received", "sent", "unknown"]),
  content: string(),
  quotedText: string().nullable(),
  attachments: array(wechatAttachmentSchema),
  timestamp: iso.datetime(),
});
export const wechatHistoryQuerySchema = object({
  channelId: uuid(),
  before: uuid().optional(),
  oldest: iso.datetime({ offset: true }).optional(),
  latest: iso.datetime({ offset: true }).optional(),
  limit: coerce.number().int().min(1).max(100).default(50),
}).refine(
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
export const wechatSendBodySchema = object({
  channelId: uuid(),
  operationId: uuid(),
  text: string()
    .min(1)
    .max(20_000)
    .refine((value) => {
      return value.trim().length > 0;
    }, "Message text must not be blank"),
});
export const wechatReceiptSchema = object({
  id: uuid(),
  channelId: uuid(),
  providerMessageId: string().nullable(),
  url: zNull(),
});
export const wechatSendErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    deliveredMessages: array(wechatReceiptSchema).optional(),
    uncertainMessageId: uuid().optional(),
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
      200: object({
        channels: array(
          object({
            id: uuid(),
            binding: wechatBindingSchema,
            name: string(),
            status: zEnum(["active", "reconnect_required"]),
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
      200: object({
        channelId: uuid(),
        messages: array(wechatStoredMessageSchema),
        nextBefore: uuid().nullable(),
        historyScope: literal("okou_received_and_sent"),
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
      200: object({
        operationId: uuid(),
        messages: array(wechatReceiptSchema),
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
export type WechatHistoryQuery = zInfer<typeof wechatHistoryQuerySchema>;
export type WechatStoredMessage = zInfer<typeof wechatStoredMessageSchema>;
export type WechatSendBody = zInfer<typeof wechatSendBodySchema>;
export type WechatReceipt = zInfer<typeof wechatReceiptSchema>;
