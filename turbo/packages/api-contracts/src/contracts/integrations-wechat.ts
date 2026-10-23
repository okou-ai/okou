import { wechatUpdatesSchema } from "./wechat-protocol";
import * as z from "zod";
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
export const wechatBindingSchema = z.object({
  workspace: z.object({ id: z.string(), name: z.string() }),
  accountId: z.string(),
});
export const wechatStatusSchema = z.object({
  configured: z.boolean(),
  binding: wechatBindingSchema.nullable(),
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
  reconnectStatus: {
    method: "GET",
    path: "/api/integrations/wechat/reconnect",
    headers: authHeadersSchema,
    query: z.object({ token: z.string().min(1).max(1024) }),
    responses: { 200: z.object({ available: z.boolean() }), ...errors },
    summary: "Check an owner's WeChat reconnect link",
  },
  reconnect: {
    method: "POST",
    path: "/api/integrations/wechat/reconnect",
    headers: authHeadersSchema,
    body: z.object({ token: z.string().min(1).max(1024) }),
    responses: { 204: c.noBody(), ...errors },
    summary: "Restore the owner's disconnected WeChat binding",
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
const receiverHeadersSchema = z.object({
  "x-wechat-timestamp": z.string(),
  "x-wechat-signature": z.string(),
});
export type WechatStatus = z.infer<typeof wechatStatusSchema>;
export type WechatAttempt = z.infer<typeof wechatAttemptSchema>;
export type WechatPollStatus = z.infer<typeof wechatPollStatusSchema>;

/** Private Worker protocol; credentials never enter browser responses. */
export const wechatReceiverContract = c.router({
  bootstrap: {
    method: "POST",
    path: "/api/internal/wechat/receiver",
    headers: receiverHeadersSchema,
    body: z.object({ connectionId: z.uuid(), generation: z.uuid().optional() }),
    responses: {
      200: z.discriminatedUnion("active", [
        z.object({ active: z.literal(false) }),
        z.object({
          active: z.literal(true),
          generation: z.uuid(),
          session: z
            .object({
              baseUrl: z.string().url(),
              token: z.string().min(1),
              cursor: z.string(),
              preserveCursor: z.boolean(),
              pending: wechatUpdatesSchema.nullable(),
            })
            .optional(),
        }),
      ]),
      ...errors,
    },
    summary: "Bootstrap and renew a WeChat receiver binding",
  },
  deliver: {
    method: "POST",
    path: "/api/internal/wechat/deliver",
    headers: receiverHeadersSchema,
    body: z.object({
      connectionId: z.uuid(),
      generation: z.uuid(),
      updates: wechatUpdatesSchema,
    }),
    responses: {
      200: z.object({
        active: z.boolean(),
        refresh: z.boolean().optional(),
        retryAfterMs: z.number().int().min(1).max(5_000).optional(),
      }),
      ...errors,
    },
    summary: "Dispatch a durably saved WeChat batch",
  },
  expire: {
    method: "POST",
    path: "/api/internal/wechat/expire",
    headers: receiverHeadersSchema,
    body: z.object({ connectionId: z.uuid(), generation: z.uuid() }),
    responses: {
      200: z.object({ active: z.boolean(), refresh: z.boolean().optional() }),
      ...errors,
    },
    summary: "Revoke an expired WeChat provider session",
  },
});
