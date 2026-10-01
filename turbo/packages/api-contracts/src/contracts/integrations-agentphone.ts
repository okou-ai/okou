import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentPhoneConnectBodySchema = z.object({
  phoneHandle: z.string().min(1),
  agentphoneAgentId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
  channel: z.string().min(1).optional(),
});

const agentPhoneConnectResponseSchema = z.object({
  phoneHandle: z.string(),
});

const agentPhoneWebhookHeadersSchema = z.object({
  "x-webhook-signature": z.string().optional(),
  "x-webhook-timestamp": z.string().optional(),
  "x-webhook-event": z.string().optional(),
  "x-webhook-id": z.string().optional(),
});

const agentPhoneLinkStatusResponseSchema = z.discriminatedUnion("linked", [
  z.object({
    linked: z.literal(true),
    phoneHandle: z.string(),
    agentPhoneNumber: z.string().nullable(),
    configured: z.boolean(),
  }),
  z.object({
    linked: z.literal(false),
    agentPhoneNumber: z.string().nullable(),
    configured: z.boolean(),
  }),
]);

const agentPhoneStartLinkBodySchema = z.object({
  phoneHandle: z.string().min(1),
});

const agentPhoneStartLinkResponseSchema = z.object({
  phoneHandle: z.string(),
  verificationSent: z.literal(true),
});

const agentPhoneLinkCodeResponseSchema = z.object({
  code: z.string().regex(/^\d{8}$/u),
  expiresAt: z.iso.datetime(),
});

export const agentPhoneGroupHistoryQuerySchema = z
  .object({
    groupId: z.string().min(5).max(255).startsWith("grp_"),
    after: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    query: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().min(1).max(512).optional(),
  })
  .refine(
    (value) => {
      return (
        value.after === undefined ||
        value.before === undefined ||
        Date.parse(value.after) < Date.parse(value.before)
      );
    },
    { message: "after must be earlier than before", path: ["after"] },
  );

const agentPhoneGroupHistoryResponseSchema = z.object({
  groupId: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      conversationId: z.string().nullable(),
      fromNumber: z.string(),
      toNumber: z.string(),
      direction: z.enum(["inbound", "outbound"]),
      channel: z.string(),
      body: z.string().nullable(),
      mediaUrl: z.string().nullable(),
      receivedAt: z.iso.datetime(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const integrationsAgentPhoneContract = c.router({
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
      200: z.string(),
      400: z.string(),
      401: z.string(),
      404: z.string(),
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
export type AgentPhoneConnectRequest = z.infer<
  typeof agentPhoneConnectBodySchema
>;
export type AgentPhoneConnectResponse = z.infer<
  typeof agentPhoneConnectResponseSchema
>;
export type AgentPhoneLinkStatusResponse = z.infer<
  typeof agentPhoneLinkStatusResponseSchema
>;
export type AgentPhoneStartLinkResponse = z.infer<
  typeof agentPhoneStartLinkResponseSchema
>;
export type AgentPhoneLinkCodeResponse = z.infer<
  typeof agentPhoneLinkCodeResponseSchema
>;
export type AgentPhoneGroupHistoryQuery = z.infer<
  typeof agentPhoneGroupHistoryQuerySchema
>;
export type AgentPhoneGroupHistoryResponse = z.infer<
  typeof agentPhoneGroupHistoryResponseSchema
>;
