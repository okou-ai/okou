import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
};
export const wechatStatusSchema = z.object({
  configured: z.boolean(),
  status: z.enum(["disconnected", "active", "reconnect_required"]),
});
export const wechatAttemptSchema = z.object({
  id: z.uuid(),
  qrContent: z.string(),
  expiresAt: z.iso.datetime(),
});
export const wechatPollStatusSchema = z.enum([
  "waiting",
  "scanned",
  "verification_required",
  "verification_blocked",
  "expired",
  "connected",
  "restart_required",
]);
export const integrationsWechatContract = c.router({
  status: {
    method: "GET",
    path: "/api/integrations/wechat",
    headers: authHeadersSchema,
    responses: { 200: wechatStatusSchema, ...errors },
    summary: "Read WeChat connection status",
  },
  connect: {
    method: "POST",
    path: "/api/integrations/wechat/connect",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { 200: wechatAttemptSchema, ...errors },
    summary: "Create a WeChat QR connection attempt",
  },
  poll: {
    method: "POST",
    path: "/api/integrations/wechat/connect/status",
    headers: authHeadersSchema,
    body: z.object({
      id: z.uuid(),
      verifyCode: z
        .string()
        .regex(/^\d{4,12}$/u)
        .optional(),
    }),
    responses: { 200: z.object({ status: wechatPollStatusSchema }), ...errors },
    summary: "Wait for the owner's WeChat scan confirmation",
  },
  cancel: {
    method: "DELETE",
    path: "/api/integrations/wechat/connect",
    headers: authHeadersSchema,
    body: z.object({ id: z.uuid() }),
    responses: { 204: c.noBody(), ...errors },
    summary: "Cancel a WeChat connection attempt",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/integrations/wechat",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Disconnect WeChat",
  },
});
export const wechatGatewayContract = c.router({
  poll: {
    method: "POST",
    path: "/api/internal/wechat/poll",
    headers: z.object({
      "x-wechat-timestamp": z.string(),
      "x-wechat-signature": z.string(),
    }),
    body: z.object({ connectionId: z.uuid() }),
    responses: {
      200: z.object({ active: z.boolean() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Receive WeChat messages from the authenticated poller",
  },
});
export type WechatStatus = z.infer<typeof wechatStatusSchema>;
export type WechatAttempt = z.infer<typeof wechatAttemptSchema>;
export type WechatPollStatus = z.infer<typeof wechatPollStatusSchema>;
