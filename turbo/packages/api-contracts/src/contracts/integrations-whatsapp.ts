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
