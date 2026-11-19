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
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import type { MailDraftValue } from "./mail-details";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";
const MAX_GRAPH_ERROR_BODY_BYTES = 16 * 1024;
const graphErrorCodeSchema = zEnum([
  "ErrorInvalidIdMalformed",
  "BadRequest",
  "badRequest",
  "ErrorInvalidRequest",
  "ErrorAccessDenied",
]);
const graphErrorNodeSchema = object({
  code: zUnknown().optional(),
  innerError: zUnknown().optional(),
  innererror: zUnknown().optional(),
});
const graphErrorResponseSchema = object({ error: graphErrorNodeSchema });
type GraphErrorCode =
  | zInfer<typeof graphErrorCodeSchema>
  | "missing"
  | "unrecognized"
  | "unavailable";
type GraphOperation =
  | "get_message"
  | "list_attachments"
  | "get_attachment"
  | "send_draft"
  | "delete_draft";

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
  constructor(
    readonly status: number,
    readonly operation: GraphOperation,
    readonly graphErrorCode?: GraphErrorCode,
  ) {
    const diagnostic = graphErrorCode ? `; Graph code: ${graphErrorCode}` : "";
    super(`Outlook rejected the mail operation (HTTP ${status}${diagnostic})`);
    this.name = "OutlookRequestError";
  }

  get isInvalidMessageId(): boolean {
    return (
      this.operation === "get_message" &&
      this.status === 400 &&
      this.graphErrorCode === "ErrorInvalidIdMalformed"
    );
  }
}

async function readGraphErrorCode(
  response: Response,
  signal: AbortSignal,
): Promise<GraphErrorCode> {
  const body = await settle(
    readBoundedResponseText(response, MAX_GRAPH_ERROR_BODY_BYTES, signal),
    signal,
  );
  if (!body.ok || body.value.kind !== "text") {
    return "unavailable";
  }
  const parsed = graphErrorResponseSchema.safeParse(
    safeJsonParse(body.value.text),
  );
  if (!parsed.success) {
    return "unavailable";
  }

  // Provider messages and arbitrary codes can contain addresses or mail data.
  // Select the most specific allowlisted code from the Graph error chain.
  let diagnostic: GraphErrorCode = "missing";
  let current: zInfer<typeof graphErrorNodeSchema> | undefined =
    parsed.data.error;
  while (current) {
    const code = graphErrorCodeSchema.safeParse(current.code);
    if (code.success) {
      diagnostic = code.data;
    } else if (diagnostic === "missing" && current.code !== undefined) {
      diagnostic = "unrecognized";
    }
    const inner = graphErrorNodeSchema.safeParse(
      current.innerError ?? current.innererror,
    );
    current = inner.success ? inner.data : undefined;
  }
  return diagnostic;
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Prefer: 'IdType="ImmutableId"',
  };
}

async function graphRequest(
  operation: GraphOperation,
  args: {
    readonly url: string;
    readonly accessToken: string;
    readonly method?: "GET" | "POST" | "DELETE";
  },
  signal: AbortSignal,
): Promise<Response> {
  const method = args.method ?? "GET";
  const response = await fetch(args.url, {
    method,
    headers: headers(args.accessToken),
    signal,
  });
  if (response.status === 401) {
    throw new OutlookAuthorizationError();
  }
  if (!response.ok && response.status !== 404) {
    // A mutation's definitive rejection must be handled as soon as its
    // status is known, even if the provider stalls while writing its body.
    throw new OutlookRequestError(
      response.status,
      operation,
      method === "GET" ? await readGraphErrorCode(response, signal) : undefined,
    );
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
    "get_attachment",
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
    "get_message",
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
      "list_attachments",
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
    "send_draft",
    {
      ...args,
      url: `${GRAPH_BASE}/messages/${encodeURIComponent(args.messageId)}/send`,
      method: "POST",
    },
    signal,
  );
  if (response.status !== 202) {
    throw new OutlookRequestError(response.status, "send_draft");
  }
}

export async function outlookDeleteDraft(
  args: { readonly accessToken: string; readonly messageId: string },
  signal: AbortSignal,
): Promise<void> {
  await graphRequest(
    "delete_draft",
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
