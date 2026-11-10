import { emailConnectBodySchema } from "../validators/integrations-email";
import {
  array,
  boolean,
  discriminatedUnion,
  email,
  literal,
  number,
  object,
  string,
  record,
  union,
  uuid,
} from "zod";
import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
// Resend limits the whole email to 40 MB after Base64 encoding. A 25 MiB
// attachment encodes to about 35 MB, leaving room for MIME framing and text.
// https://resend.com/docs/dashboard/emails/attachments#attachment-limitations
export const MAX_EMAIL_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export const integrationsEmailUploadContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/email/upload-file/complete",
    headers: authHeadersSchema,
    body: object({
      uploadId: uuid(),
      text: string().max(2000).optional(),
    }).strict(),
    responses: {
      200: object({
        uploadId: uuid(),
        operationId: uuid(),
        chatThreadId: uuid(),
        emailAddress: email(),
        filename: string(),
        contentType: string(),
        size: number().int().positive(),
        url: artifactUrlSchema,
        delivery: discriminatedUnion("status", [
          object({ status: literal("pending") }),
          object({ status: literal("accepted"), providerId: string() }),
          object({ status: literal("failed"), message: string() }),
        ]),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Attach a private file to the current Email run's conversation",
  },
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  409: apiErrorSchema,
};
export const integrationsEmailContract = c.router({
  createLinkCode: {
    method: "POST",
    path: "/api/integrations/email/link-code",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ code: string(), expiresAt: string() }),
      ...errors,
    },
    summary: "Create a one-time code to connect another email sender",
  },
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
        emailSources: record(
          string(),
          union([literal("gmail"), literal("outlook")]),
        ).optional(),
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
