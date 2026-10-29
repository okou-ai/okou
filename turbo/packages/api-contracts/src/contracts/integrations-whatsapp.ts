import {
  array,
  boolean,
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { integrationsAgentPhoneContract } from "./integrations-agentphone";

const c = initContract();
const linkStatusSchema = discriminatedUnion("linked", [
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
const linkCodeSchema = object({
  code: string().regex(/^\d{8}$/u),
  expiresAt: iso.datetime(),
});
const sendErrorSchema = apiErrorSchema.extend({
  acceptedMessages: array(object({ id: string() })).optional(),
  delivery: zEnum(["failed", "unknown"]).optional(),
});

export const integrationsWhatsappContract = c.router({
  getConnectStatus: {
    ...integrationsAgentPhoneContract.getConnectStatus,
    path: "/api/integrations/whatsapp/connect-status",
    responses: {
      ...integrationsAgentPhoneContract.getConnectStatus.responses,
      404: apiErrorSchema,
    },
    summary: "Check a signed WhatsApp connection link before connecting",
  },
  connectWhatsapp: {
    ...integrationsAgentPhoneContract.connectAgentPhone,
    path: "/api/integrations/whatsapp/connect",
    responses: {
      ...integrationsAgentPhoneContract.connectAgentPhone.responses,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Link the authenticated user to an independently verified WhatsApp handle",
  },
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/whatsapp/link",
    headers: authHeadersSchema,
    responses: {
      200: linkStatusSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read your verified WhatsApp connection",
  },
  createLinkCode: {
    method: "POST",
    path: "/api/integrations/whatsapp/link-code",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: linkCodeSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Create a one-time WhatsApp connection code",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/whatsapp/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { 204: c.noBody(), 401: apiErrorSchema, 404: apiErrorSchema },
    summary: "Disconnect your WhatsApp account",
  },
  sendMessage: {
    method: "POST",
    path: "/api/integrations/whatsapp/message",
    headers: authHeadersSchema,
    body: object({ text: string().min(1).max(65536) }),
    responses: {
      200: object({
        channel: literal("whatsapp"),
        toNumber: string(),
        messages: array(object({ id: string() })),
      }),
      400: sendErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: sendErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Send a WhatsApp message to your verified account within the customer service window",
  },
});
export type WhatsappLinkStatusResponse = zInfer<typeof linkStatusSchema>;
export type WhatsappLinkCodeResponse = zInfer<typeof linkCodeSchema>;
