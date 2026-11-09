import { emailConnectBodySchema } from "../validators/integrations-email";
import { array, boolean, email, object, string } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  409: apiErrorSchema,
};
export const integrationsEmailContract = c.router({
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/email/link",
    headers: authHeadersSchema,
    responses: {
      200: object({
        address: string(),
        configured: boolean(),
        emails: array(string()),
        availableEmails: array(string()),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get Email integration status",
  },
  connect: {
    method: "POST",
    path: "/api/integrations/email/connect",
    headers: authHeadersSchema,
    body: emailConnectBodySchema,
    responses: { 200: object({ emailAddress: string() }), ...errors },
    summary: "Connect a verified sender and resume the original email",
  },
  connectAddress: {
    method: "POST",
    path: "/api/integrations/email/link",
    headers: authHeadersSchema,
    body: object({ emailAddress: email() }),
    responses: { 200: object({ emailAddress: string() }), ...errors },
    summary: "Connect a verified account email address",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/email/link",
    headers: authHeadersSchema,
    body: object({ emailAddress: email() }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Disconnect an email sender",
  },
});
