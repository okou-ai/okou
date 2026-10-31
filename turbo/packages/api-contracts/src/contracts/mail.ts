import {
  array,
  boolean,
  discriminatedUnion,
  email,
  literal,
  number,
  object,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const mailProviderSchema = zEnum(["gmail", "outlook"]);

export const mailDraftStatusSchema = zEnum([
  "draft",
  "sending",
  "sent",
  "deleted",
]);

export const mailAttachmentSchema = object({
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative(),
  partId: string().optional(),
});

export const mailInlineImageSchema = object({
  contentId: string().min(1),
  partId: string().min(1),
  alt: string(),
});

const mailDraftBaseSchema = object({
  from: email(),
  fromName: string().optional(),
  to: array(email()),
  cc: array(email()),
  bcc: array(email()),
  subject: string(),
  body: string(),
  bodyHtml: string().optional(),
  inlineImages: array(mailInlineImageSchema).optional(),
  accessStatus: zEnum(["ready", "reconnect"]).optional(),
  reconnectConnectionId: uuid().optional(),
  replyTo: string().optional(),
  inReplyTo: string().optional(),
  references: array(string()),
  status: mailDraftStatusSchema,
  detailAvailable: boolean(),
  createdAt: string(),
  updatedAt: string(),
  sentAt: string().optional(),
});

const gmailMailDraftSchema = mailDraftBaseSchema.extend({
  provider: literal("gmail"),
  gmailDraftId: string(),
  gmailThreadId: string(),
  gmailMessageId: string(),
  sentGmailMessageId: string().optional(),
  version: literal(3),
  attachments: array(mailAttachmentSchema),
});

const outlookMailDraftSchema = mailDraftBaseSchema.extend({
  provider: literal("outlook"),
  version: literal(3),
  outlookMessageId: string().min(1),
  outlookConversationId: string(),
  outlookWebLink: url().optional(),
  attachments: array(mailAttachmentSchema),
});

export const mailDraftSchema = discriminatedUnion("provider", [
  gmailMailDraftSchema,
  outlookMailDraftSchema,
]);

export const linkMailDraftInputSchema = union([
  object({
    threadId: uuid(),
    agentId: uuid().optional(),
    provider: literal("gmail").optional(),
    gmailDraftId: string().min(1),
  }),
  object({
    threadId: uuid(),
    agentId: uuid().optional(),
    provider: literal("outlook"),
    outlookMessageId: string().min(1),
  }),
]);

const mailDraftResponseSchema = object({
  mailDraftId: uuid(),
  mailDraftUrl: url(),
  mailDraft: mailDraftSchema,
});

const mailLinkResponseSchema = mailDraftResponseSchema.pick({
  mailDraftId: true,
  mailDraftUrl: true,
});

const mailDraftPathParamsSchema = object({
  mailDraftId: uuid(),
});

const mailDraftAttachmentPathParamsSchema = mailDraftPathParamsSchema.extend({
  partId: string().min(1),
});

export const threadMailSummarySchema = object({
  mailDraftId: uuid(),
  status: zEnum(["draft", "sending", "sent"]),
  subject: string(),
  from: string(),
  createdAt: string(),
});

export const mailContract = c.router({
  listThreadMail: {
    method: "GET",
    path: "/api/mail/threads/:threadId/drafts",
    headers: authHeadersSchema,
    pathParams: object({ threadId: uuid() }),
    responses: {
      200: object({ mails: array(threadMailSummarySchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List all active drafts and sent emails linked to a chat thread",
  },
  linkDraft: {
    method: "POST",
    path: "/api/mail/drafts/link",
    headers: authHeadersSchema,
    body: linkMailDraftInputSchema,
    responses: {
      200: mailLinkResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link an existing email draft to a web chat thread",
  },
  getDraft: {
    method: "GET",
    path: "/api/mail/drafts/:mailDraftId",
    headers: authHeadersSchema,
    pathParams: mailDraftPathParamsSchema,
    responses: {
      200: mailDraftResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get an email draft by ID",
  },
  getAttachment: {
    method: "GET",
    path: "/api/mail/drafts/:mailDraftId/attachments/:partId",
    headers: authHeadersSchema,
    pathParams: mailDraftAttachmentPathParamsSchema,
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: c.type<Blob>(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get an email attachment",
  },
  deleteDraft: {
    method: "DELETE",
    path: "/api/mail/drafts/:mailDraftId",
    headers: authHeadersSchema,
    pathParams: mailDraftPathParamsSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Delete an email draft",
  },
  sendDraft: {
    method: "POST",
    path: "/api/mail/drafts/:mailDraftId/send",
    headers: authHeadersSchema,
    pathParams: mailDraftPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: mailDraftResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Send a linked email draft",
  },
});

export type MailProvider = zInfer<typeof mailProviderSchema>;
export type MailDraftStatus = zInfer<typeof mailDraftStatusSchema>;
export type MailAttachment = zInfer<typeof mailAttachmentSchema>;
export type MailInlineImage = zInfer<typeof mailInlineImageSchema>;
export type MailDraft = zInfer<typeof mailDraftSchema>;
export type ThreadMailSummary = zInfer<typeof threadMailSummarySchema>;
export type MailContract = typeof mailContract;

export type LinkMailDraftInput = zInfer<typeof linkMailDraftInputSchema>;
