import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentPhoneConnectProofSchema = object({
  phoneHandle: string().min(1),
  agentphoneAgentId: string().min(1),
  timestamp: number(),
  signature: string().min(1),
  channel: string().min(1).optional(),
});

const agentPhoneConnectBodySchema = agentPhoneConnectProofSchema.extend({
  replacePhoneHandle: string().min(1).optional(),
});

const agentPhoneConnectStatusSchema = discriminatedUnion("kind", [
  object({ kind: literal("connect") }),
  object({ kind: literal("connected"), phoneHandle: string() }),
  object({ kind: literal("phone_in_use") }),
  object({
    kind: literal("phone_mismatch"),
    currentPhoneHandle: string(),
  }),
]);

const agentPhoneConnectResponseSchema = object({
  phoneHandle: string(),
});

const agentPhoneWebhookHeadersSchema = object({
  "x-webhook-signature": string().optional(),
  "x-webhook-timestamp": string().optional(),
  "x-webhook-event": string().optional(),
  "x-webhook-id": string().optional(),
});

const agentPhoneLinkStatusResponseSchema = discriminatedUnion("linked", [
  object({
    linked: literal(true),
    phoneHandle: string(),
    agentPhoneNumber: string().nullable(),
    configured: boolean(),
  }),
  object({
    linked: literal(false),
    agentPhoneNumber: string().nullable(),
    configured: boolean(),
  }),
]);

const agentPhoneStartLinkBodySchema = object({
  phoneHandle: string().min(1),
});

const agentPhoneStartLinkResponseSchema = object({
  phoneHandle: string(),
  verificationSent: literal(true),
});

const agentPhoneLinkCodeResponseSchema = object({
  code: string().regex(/^\d{8}$/u),
  expiresAt: iso.datetime(),
});

export const agentPhoneGroupHistoryQuerySchema = object({
  groupId: string().min(5).max(255).startsWith("grp_"),
  after: iso.datetime({ offset: true }).optional(),
  before: iso.datetime({ offset: true }).optional(),
  query: string().trim().min(1).max(500).optional(),
  limit: coerce.number().int().min(1).max(200).default(100),
  cursor: string().min(1).max(512).optional(),
}).refine(
  (value) => {
    return (
      value.after === undefined ||
      value.before === undefined ||
      Date.parse(value.after) < Date.parse(value.before)
    );
  },
  { message: "after must be earlier than before", path: ["after"] },
);

const agentPhoneGroupHistoryResponseSchema = object({
  groupId: string(),
  messages: array(
    object({
      id: string(),
      conversationId: string().nullable(),
      fromNumber: string(),
      toNumber: string(),
      direction: zEnum(["inbound", "outbound"]),
      channel: string(),
      body: string().nullable(),
      mediaUrl: string().nullable(),
      receivedAt: iso.datetime(),
    }),
  ),
  hasMore: boolean(),
  nextCursor: string().nullable(),
});

const agentPhoneGroupMessageBodySchema = object({
  groupId: string().min(5).max(255).startsWith("grp_"),
  agentphoneAgentId: string().min(1).optional(),
  text: string().min(1),
});

export const integrationsAgentPhoneContract = c.router({
  getConnectStatus: {
    method: "GET",
    path: "/api/integrations/agentphone/connect-status",
    headers: authHeadersSchema,
    query: agentPhoneConnectProofSchema.extend({ timestamp: coerce.number() }),
    responses: {
      200: agentPhoneConnectStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Check a signed phone connection link before connecting",
  },
  connectAgentPhone: {
    method: "POST",
    path: "/api/agentphone/connect",
    headers: authHeadersSchema,
    body: agentPhoneConnectBodySchema,
    responses: {
      200: agentPhoneConnectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link the authenticated Okou user to a phone handle",
  },
  webhook: {
    method: "POST",
    path: "/api/agentphone/webhook",
    headers: agentPhoneWebhookHeadersSchema,
    body: c.type<string>(),
    responses: {
      200: string(),
      400: string(),
      401: string(),
      404: string(),
      500: string(),
    },
    summary: "Handle inbound phone message webhooks",
  },
  groupHistory: {
    method: "GET",
    path: "/api/integrations/agentphone/group-history",
    headers: authHeadersSchema,
    query: agentPhoneGroupHistoryQuerySchema,
    responses: {
      200: agentPhoneGroupHistoryResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read archived iMessage group messages visible to the user",
  },
  groupMessage: {
    method: "POST",
    path: "/api/integrations/agentphone/group-message",
    headers: authHeadersSchema,
    body: agentPhoneGroupMessageBodySchema,
    responses: {
      200: object({
        ok: literal(true),
        messageId: string(),
        channel: string().nullable(),
        toNumber: string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send text to an existing iMessage group containing the caller",
  },
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    responses: {
      200: agentPhoneLinkStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Check the authenticated user's phone link status",
  },
  startLink: {
    method: "POST",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    body: agentPhoneStartLinkBodySchema,
    responses: {
      200: agentPhoneStartLinkResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      429: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Send a verified phone connection link by SMS",
  },
  createLinkCode: {
    method: "POST",
    path: "/api/integrations/agentphone/link-code",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: agentPhoneLinkCodeResponseSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create a one-time phone connection code",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the authenticated user's phone link",
  },
});

export type IntegrationsAgentPhoneContract =
  typeof integrationsAgentPhoneContract;
export type AgentPhoneConnectRequest = zInfer<
  typeof agentPhoneConnectBodySchema
>;
export type AgentPhoneConnectStatus = zInfer<
  typeof agentPhoneConnectStatusSchema
>;
export type AgentPhoneConnectResponse = zInfer<
  typeof agentPhoneConnectResponseSchema
>;
export type AgentPhoneLinkStatusResponse = zInfer<
  typeof agentPhoneLinkStatusResponseSchema
>;
export type AgentPhoneStartLinkResponse = zInfer<
  typeof agentPhoneStartLinkResponseSchema
>;
export type AgentPhoneLinkCodeResponse = zInfer<
  typeof agentPhoneLinkCodeResponseSchema
>;
export type AgentPhoneGroupHistoryQuery = zInfer<
  typeof agentPhoneGroupHistoryQuerySchema
>;
export type AgentPhoneGroupHistoryResponse = zInfer<
  typeof agentPhoneGroupHistoryResponseSchema
>;
export type SendAgentPhoneGroupMessageBody = zInfer<
  typeof agentPhoneGroupMessageBodySchema
>;
