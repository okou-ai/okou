import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { publicBrandSchema } from "./public-brand";

const c = initContract();

const agentPhoneConnectBodySchema = z.object({
  phoneHandle: z.string().min(1),
  agentphoneAgentId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
  channel: z.string().min(1).optional(),
  publicBrand: publicBrandSchema,
  publicBrandSignature: z.string().min(1),
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
    publicBrand: publicBrandSchema,
  }),
  z.object({
    linked: z.literal(false),
    agentPhoneNumber: z.string().nullable(),
    configured: z.boolean(),
    publicBrand: publicBrandSchema,
  }),
]);

const agentPhoneStartLinkBodySchema = z.object({
  phoneHandle: z.string().min(1),
});

const agentPhoneStartLinkResponseSchema = z.object({
  phoneHandle: z.string(),
  verificationSent: z.literal(true),
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
    summary: "Link the authenticated Okou user to an AgentPhone phone handle",
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
    summary: "Handle AgentPhone inbound message webhooks",
  },
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    responses: {
      200: agentPhoneLinkStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Check the authenticated user's AgentPhone link status",
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
    summary: "Send a verified AgentPhone connection link by SMS",
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
    summary: "Disconnect the authenticated user's AgentPhone link",
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
