import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const mailProviderSchema = z.enum(["gmail", "outlook"]);

export const mailDraftStatusSchema = z.enum(["draft", "sent", "deleted"]);

export const mailAttachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  partId: z.string().optional(),
});

export const mailInlineImageSchema = z.object({
  contentId: z.string().min(1),
  partId: z.string().min(1),
  alt: z.string(),
});

const mailDraftBaseSchema = z.object({
  provider: z.literal("gmail"),
  from: z.email(),
  fromName: z.string().optional(),
  to: z.array(z.email()),
  cc: z.array(z.email()),
  bcc: z.array(z.email()),
  subject: z.string(),
  body: z.string(),
  bodyHtml: z.string().optional(),
  inlineImages: z.array(mailInlineImageSchema).optional(),
  accessStatus: z.enum(["ready", "reconnect"]).optional(),
  reconnectConnectionId: z.uuid().optional(),
  replyTo: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  status: mailDraftStatusSchema,
  detailAvailable: z.boolean(),
  gmailDraftId: z.string(),
  gmailThreadId: z.string(),
  gmailMessageId: z.string(),
  sentGmailMessageId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
});

export const mailDraftSchema = mailDraftBaseSchema.extend({
  version: z.literal(3),
  attachments: z.array(mailAttachmentSchema),
});

const mailDraftResponseSchema = z.object({
  mailDraftId: z.string().uuid(),
  mailDraftUrl: z.url(),
  mailDraft: mailDraftSchema,
});

const mailLinkResponseSchema = mailDraftResponseSchema.pick({
  mailDraftId: true,
  mailDraftUrl: true,
});

const mailDraftPathParamsSchema = z.object({
  mailDraftId: z.string().uuid(),
});

const mailDraftAttachmentPathParamsSchema = mailDraftPathParamsSchema.extend({
  partId: z.string().min(1),
});

export const threadMailSummarySchema = z.object({
  mailDraftId: z.uuid(),
  status: z.enum(["draft", "sent"]),
  subject: z.string(),
  from: z.string(),
  createdAt: z.string(),
});

export const mailContract = c.router({
  listThreadMail: {
    method: "GET",
    path: "/api/mail/threads/:threadId/drafts",
    headers: authHeadersSchema,
    pathParams: z.object({ threadId: z.uuid() }),
    responses: {
      200: z.object({ mails: z.array(threadMailSummarySchema) }),
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
    body: z.object({
      threadId: z.string().uuid(),
      agentId: z.string().uuid().optional(),
      gmailDraftId: z.string().min(1),
    }),
    responses: {
      200: mailLinkResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link an existing Gmail draft to a web chat thread",
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
    summary: "Get a Gmail draft attachment",
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
    summary: "Permanently delete a Gmail draft and its Okou record",
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
    summary: "Send a linked Gmail draft",
  },
});

export type MailProvider = z.infer<typeof mailProviderSchema>;
export type MailDraftStatus = z.infer<typeof mailDraftStatusSchema>;
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;
export type MailInlineImage = z.infer<typeof mailInlineImageSchema>;
export type MailDraft = z.infer<typeof mailDraftSchema>;
export type ThreadMailSummary = z.infer<typeof threadMailSummarySchema>;
export type MailContract = typeof mailContract;
