import { Buffer } from "node:buffer";
import { convert } from "html-to-text";
import {
  array,
  boolean,
  email,
  iso,
  number,
  object,
  string,
  enum as zEnum,
  url as zUrl,
  type infer as zInfer,
} from "zod";
import type { MailDraftValue } from "./mail-details";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";
const addressSchema = object({
  emailAddress: object({ address: email(), name: string().optional() }),
});
const messageSchema = object({
  id: string().min(1),
  conversationId: string(),
  isDraft: boolean(),
  from: addressSchema.optional(),
  toRecipients: array(addressSchema).default([]),
  ccRecipients: array(addressSchema).default([]),
  bccRecipients: array(addressSchema).default([]),
  replyTo: array(addressSchema).default([]),
  subject: string().default(""),
  body: object({ contentType: zEnum(["text", "html"]), content: string() }),
  webLink: zUrl()
    .refine((value) => {
      return new URL(value).protocol === "https:";
    })
    .optional(),
  sentDateTime: iso.datetime().nullable().optional(),
  internetMessageHeaders: array(
    object({ name: string(), value: string() }),
  ).default([]),
});
const attachmentSchema = object({
  "@odata.type": string(),
  id: string().min(1),
  name: string(),
  contentType: string().nullable().optional(),
  size: number().int().nonnegative(),
  isInline: boolean().default(false),
});
const fileAttachmentSchema = attachmentSchema.extend({
  contentId: string().nullable().optional(),
  contentBytes: string(),
});
const attachmentPageSchema = object({
  value: array(attachmentSchema),
  "@odata.nextLink": zUrl().optional(),
});

export class OutlookAuthorizationError extends Error {
  constructor() {
    super("Outlook authorization is no longer valid");
    this.name = "OutlookAuthorizationError";
  }
}

export class OutlookRequestError extends Error {
  constructor(readonly status: number) {
    super(`Outlook rejected the mail operation (HTTP ${status})`);
    this.name = "OutlookRequestError";
  }
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Prefer: 'IdType="ImmutableId"',
  };
}

async function graphRequest(
  args: {
    readonly url: string;
    readonly accessToken: string;
    readonly method?: "GET" | "POST" | "DELETE";
  },
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(args.url, {
    method: args.method ?? "GET",
    headers: headers(args.accessToken),
    signal,
  });
  if (response.status === 401) {
    throw new OutlookAuthorizationError();
  }
  // Do not include provider bodies: they can contain addresses and message data.
  if (!response.ok && response.status !== 404) {
    throw new OutlookRequestError(response.status);
  }
  return response;
}

export interface OutlookMailValue extends MailDraftValue {
  readonly isDraft: boolean;
  readonly sentAt: string | null;
}

async function getFileAttachment(
  args: {
    readonly accessToken: string;
    readonly messageId: string;
    readonly attachmentId: string;
  },
  signal: AbortSignal,
): Promise<zInfer<typeof fileAttachmentSchema> | null> {
  const response = await graphRequest(
    {
      accessToken: args.accessToken,
      url: `${GRAPH_BASE}/messages/${encodeURIComponent(args.messageId)}/attachments/${encodeURIComponent(args.attachmentId)}`,
    },
    signal,
  );
  if (response.status === 404) {
    return null;
  }
  const body: unknown = await response.json();
  const metadata = attachmentSchema.parse(body);
  return metadata["@odata.type"] === "#microsoft.graph.fileAttachment"
    ? fileAttachmentSchema.parse(body)
    : null;
}

export async function outlookGetMessage(
  args: {
    readonly accessToken: string;
    readonly messageId: string;
    readonly fallbackSender: {
      readonly address: string;
      readonly name: string | null;
    };
  },
  signal: AbortSignal,
): Promise<OutlookMailValue | null> {
  const messageUrl = `${GRAPH_BASE}/messages/${encodeURIComponent(args.messageId)}`;
  const response = await graphRequest(
    {
      accessToken: args.accessToken,
      url: `${messageUrl}?$select=id,conversationId,isDraft,from,toRecipients,ccRecipients,bccRecipients,replyTo,subject,body,webLink,sentDateTime,internetMessageHeaders`,
    },
    signal,
  );
  if (response.status === 404) {
    return null;
  }
  const message = messageSchema.parse(await response.json());
  const attachments: zInfer<typeof attachmentSchema>[] = [];
  const attachmentUrl = `${GRAPH_BASE}/messages/${encodeURIComponent(message.id)}/attachments`;
  let next: string | undefined =
    `${attachmentUrl}?$select=id,name,contentType,size,isInline`;
  while (next) {
    const url = new URL(next);
    if (
      url.origin !== "https://graph.microsoft.com" ||
      url.pathname !== new URL(attachmentUrl).pathname
    ) {
      throw new Error("Outlook returned an invalid attachment page URL");
    }
    const pageResponse = await graphRequest(
      { url: next, accessToken: args.accessToken },
      signal,
    );
    if (pageResponse.status === 404) {
      return null;
    }
    const page = attachmentPageSchema.parse(await pageResponse.json());
    attachments.push(...page.value);
    next = page["@odata.nextLink"];
  }
  const inlineImages = await Promise.all(
    attachments
      .filter((attachment) => {
        return (
          attachment.isInline &&
          attachment["@odata.type"] === "#microsoft.graph.fileAttachment" &&
          attachment.contentType?.startsWith("image/")
        );
      })
      .map(async (attachment) => {
        const file = await getFileAttachment(
          { ...args, messageId: message.id, attachmentId: attachment.id },
          signal,
        );
        return file?.contentId
          ? [
              {
                contentId: file.contentId,
                partId: attachment.id,
                alt: attachment.name,
              },
            ]
          : [];
      }),
  );
  const from = message.from?.emailAddress ?? args.fallbackSender;
  const header = (name: string) => {
    return message.internetMessageHeaders.find((item) => {
      return item.name.toLowerCase() === name;
    })?.value;
  };
  return {
    draftId: message.id,
    messageId: message.id,
    threadId: message.conversationId,
    isDraft: message.isDraft,
    sentAt: message.sentDateTime ?? null,
    webLink: message.webLink,
    details: {
      from: from.address,
      fromName: from.name ?? undefined,
      to: message.toRecipients.map((recipient) => {
        return recipient.emailAddress.address;
      }),
      cc: message.ccRecipients.map((recipient) => {
        return recipient.emailAddress.address;
      }),
      bcc: message.bccRecipients.map((recipient) => {
        return recipient.emailAddress.address;
      }),
      replyTo: message.replyTo[0]?.emailAddress.address,
      subject: message.subject,
      body:
        message.body.contentType === "html"
          ? convert(message.body.content, { wordwrap: false })
          : message.body.content,
      bodyHtml:
        message.body.contentType === "html" ? message.body.content : undefined,
      inReplyTo: header("in-reply-to"),
      references: header("references")?.split(/\s+/u).filter(Boolean) ?? [],
      inlineImages: inlineImages.flat(),
      attachments: attachments
        .filter((attachment) => {
          return !attachment.isInline;
        })
        .map((attachment) => {
          return {
            filename: attachment.name,
            contentType: attachment.contentType ?? "application/octet-stream",
            size: attachment.size,
            partId:
              attachment["@odata.type"] === "#microsoft.graph.fileAttachment"
                ? attachment.id
                : undefined,
          };
        }),
    },
  };
}

export async function outlookGetAttachment(
  args: {
    readonly accessToken: string;
    readonly messageId: string;
    readonly attachmentId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
} | null> {
  const attachment = await getFileAttachment(args, signal);
  return attachment
    ? {
        content: new Uint8Array(Buffer.from(attachment.contentBytes, "base64")),
        contentType: attachment.contentType ?? "application/octet-stream",
        filename: attachment.name,
      }
    : null;
}

export async function outlookSendDraft(
  args: { readonly accessToken: string; readonly messageId: string },
  signal: AbortSignal,
): Promise<void> {
  const response = await graphRequest(
    {
      ...args,
      url: `${GRAPH_BASE}/messages/${encodeURIComponent(args.messageId)}/send`,
      method: "POST",
    },
    signal,
  );
  if (response.status !== 202) {
    throw new OutlookRequestError(response.status);
  }
}

export async function outlookDeleteDraft(
  args: { readonly accessToken: string; readonly messageId: string },
  signal: AbortSignal,
): Promise<void> {
  await graphRequest(
    {
      ...args,
      url: `${GRAPH_BASE}/messages/${encodeURIComponent(args.messageId)}`,
      method: "DELETE",
    },
    signal,
  );
}

export function outlookHasRequiredMailScopes(
  scopes: readonly string[],
): boolean {
  const granted = new Set(
    scopes.map((scope) => {
      return scope.replace(/^https:\/\/graph\.microsoft\.com\//u, "");
    }),
  );
  // offline_access is requested for refresh tokens, not reported as a Graph
  // access-token permission. Only the permissions used by this surface matter.
  return granted.has("Mail.ReadWrite") && granted.has("Mail.Send");
}
