import { wechatUpdatesSchema } from "./wechat-protocol";
import {
  boolean,
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

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
export const wechatBindingSchema = object({
  workspace: object({ id: string(), name: string() }),
  accountId: string(),
});
export const wechatStatusSchema = object({
  configured: boolean(),
  binding: wechatBindingSchema.nullable(),
  status: zEnum(["disconnected", "active", "reconnect_required"]),
});
export const wechatAttemptSchema = object({
  id: uuid(),
  qrContent: string(),
  expiresAt: iso.datetime(),
});
export const wechatPollStatusSchema = zEnum([
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
    body: object({
      id: uuid(),
      verifyCode: string()
        .regex(/^\d{4,12}$/u)
        .optional(),
    }),
    responses: { 200: object({ status: wechatPollStatusSchema }), ...errors },
    summary: "Wait for the owner's WeChat scan confirmation",
  },
  cancel: {
    method: "DELETE",
    path: "/api/integrations/wechat/connect",
    headers: authHeadersSchema,
    body: object({ id: uuid() }),
    responses: { 204: c.noBody(), ...errors },
    summary: "Cancel a WeChat connection attempt",
  },
  reconnectStatus: {
    method: "GET",
    path: "/api/integrations/wechat/reconnect",
    headers: authHeadersSchema,
    query: object({ token: string().min(1).max(1024) }),
    responses: { 200: object({ available: boolean() }), ...errors },
    summary: "Check an owner's WeChat reconnect link",
  },
  reconnect: {
    method: "POST",
    path: "/api/integrations/wechat/reconnect",
    headers: authHeadersSchema,
    body: object({ token: string().min(1).max(1024) }),
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
const receiverHeadersSchema = object({
  "x-wechat-timestamp": string(),
  "x-wechat-signature": string(),
});
export type WechatStatus = zInfer<typeof wechatStatusSchema>;
export type WechatAttempt = zInfer<typeof wechatAttemptSchema>;
export type WechatPollStatus = zInfer<typeof wechatPollStatusSchema>;

/** Private Worker protocol; credentials never enter browser responses. */
export const wechatReceiverContract = c.router({
  bootstrap: {
    method: "POST",
    path: "/api/internal/wechat/receiver",
    headers: receiverHeadersSchema,
    body: object({ connectionId: uuid(), generation: uuid().optional() }),
    responses: {
      200: discriminatedUnion("active", [
        object({ active: literal(false) }),
        object({
          active: literal(true),
          generation: uuid(),
          session: object({
            baseUrl: url(),
            token: string().min(1),
            cursor: string(),
            preserveCursor: boolean(),
            pending: wechatUpdatesSchema.nullable(),
          }).optional(),
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
    body: object({
      connectionId: uuid(),
      generation: uuid(),
      updates: wechatUpdatesSchema,
    }),
    responses: {
      200: object({
        active: boolean(),
        refresh: boolean().optional(),
        retryAfterMs: number().int().min(1).max(5_000).optional(),
      }),
      ...errors,
    },
    summary: "Dispatch a durably saved WeChat batch",
  },
  expire: {
    method: "POST",
    path: "/api/internal/wechat/expire",
    headers: receiverHeadersSchema,
    body: object({ connectionId: uuid(), generation: uuid() }),
    responses: {
      200: object({ active: boolean(), refresh: boolean().optional() }),
      ...errors,
    },
    summary: "Revoke an expired WeChat provider session",
  },
});
