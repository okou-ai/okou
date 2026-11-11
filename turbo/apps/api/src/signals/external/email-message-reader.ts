import { Buffer } from "node:buffer";
import { array, lazy, object, string, type ZodType } from "zod";
import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import type {
  Firewall,
  NetworkPolicy,
} from "@okouai/connectors/firewall-types";
import { plainTextFromHtml } from "../../lib/email-markdown";
import { settle } from "../utils";

export interface SourceEmailMessage {
  readonly providerMessageId: string;
  readonly providerConversationId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly attachmentNames: readonly string[];
}

export class EmailMessageReadError extends Error {
  constructor(
    readonly reason:
      | "permission-required"
      | "provider-unavailable"
      | "ambiguous-message"
      | "authorization-unavailable",
  ) {
    super(`Email context lookup: ${reason}`);
    this.name = "EmailMessageReadError";
  }
}

export interface EmailMessageReader {
  readonly connectorSlug: "gmail" | "outlook-mail";
  readonly accessToken: string;
  readonly messageId: string;
  readonly firewall: Firewall;
  readonly policy: NetworkPolicy;
}

export function emailMessageSearchUrl(
  provider: EmailMessageReader["connectorSlug"],
  messageId: string,
): string {
  const url = new URL(
    provider === "gmail"
      ? "https://gmail.googleapis.com/gmail/v1/users/me/messages"
      : "https://graph.microsoft.com/v1.0/me/messages",
  );
  if (provider === "gmail") {
    url.searchParams.set("q", `rfc822msgid:${messageId}`);
    url.searchParams.set("maxResults", "2");
    url.searchParams.set("includeSpamTrash", "true");
  } else {
    url.searchParams.set(
      "$filter",
      `internetMessageId eq '${messageId.replaceAll("'", "''")}'`,
    );
    url.searchParams.set("$select", "id,internetMessageId");
    url.searchParams.set("$top", "2");
  }
  return url.toString();
}

export function emailMessageReadAllowed(
  reader: Pick<EmailMessageReader, "connectorSlug" | "firewall" | "policy">,
  url: string,
): boolean {
  return (
    matchFirewallRequestDecision(
      [reader.firewall],
      "GET",
      url,
      { [reader.firewall.name]: reader.policy },
      { status: "present", value: reader.connectorSlug },
    ).kind === "allow"
  );
}

async function readJson(
  reader: EmailMessageReader,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!emailMessageReadAllowed(reader, url)) {
    throw new EmailMessageReadError("permission-required");
  }
  const request = await settle(
    fetch(url, {
      headers: {
        Authorization: `Bearer ${reader.accessToken}`,
        ...(reader.connectorSlug === "outlook-mail"
          ? {
              "X-Okou-Connector-Intent": "outlook-mail",
              Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
            }
          : {}),
      },
      redirect: "error",
      signal,
    }),
    signal,
  );
  if (!request.ok) {
    if (request.error instanceof TypeError) {
      throw new EmailMessageReadError("provider-unavailable");
    }
    throw request.error;
  }
  const response = request.value;
  if (response.status === 401) {
    throw new EmailMessageReadError("authorization-unavailable");
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new EmailMessageReadError("provider-unavailable");
  }
  const parsed = await settle(response.json(), signal);
  if (!parsed.ok) {
    if (
      parsed.error instanceof SyntaxError ||
      parsed.error instanceof TypeError
    ) {
      throw new EmailMessageReadError("provider-unavailable");
    }
    throw parsed.error;
  }
  return parsed.value;
}

interface GmailPart {
  readonly mimeType: string;
  readonly filename: string;
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: { readonly data?: string; readonly attachmentId?: string };
  readonly parts: readonly GmailPart[];
}
const gmailPartSchema: ZodType<GmailPart> = lazy(() => {
  return object({
    mimeType: string().default(""),
    filename: string().default(""),
    headers: array(object({ name: string(), value: string() })).default([]),
    body: object({
      data: string().optional(),
      attachmentId: string().optional(),
    }).default({}),
    parts: array(gmailPartSchema).default([]),
  });
});

async function gmailBody(
  reader: EmailMessageReader,
  id: string,
  root: GmailPart,
  signal: AbortSignal,
) {
  const plain: string[] = [];
  const html: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const part = pending.pop();
    if (!part) {
      break;
    }
    pending.push(...[...part.parts].reverse());
    if (
      part.filename ||
      (part.mimeType !== "text/plain" && part.mimeType !== "text/html")
    ) {
      continue;
    }
    let data = part.body.data;
    if (data === undefined && part.body.attachmentId) {
      const attachment = await readJson(
        reader,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        signal,
      );
      if (attachment !== null) {
        data = object({ data: string() }).parse(attachment).data;
      }
    }
    if (data !== undefined) {
      (part.mimeType === "text/plain" ? plain : html).push(
        Buffer.from(data, "base64url").toString("utf8"),
      );
    }
  }
  return plain.join("\n\n") || plainTextFromHtml(html.join("\n\n"));
}

async function readGmailMessage(
  reader: EmailMessageReader,
  signal: AbortSignal,
): Promise<SourceEmailMessage | null> {
  const list = await readJson(
    reader,
    emailMessageSearchUrl("gmail", reader.messageId),
    signal,
  );
  if (list === null) {
    return null;
  }
  const ids = object({
    messages: array(object({ id: string() })).default([]),
  }).parse(list).messages;
  if (ids.length > 1) {
    throw new EmailMessageReadError("ambiguous-message");
  }
  if (ids.length === 0) {
    return null;
  }
  const id = ids[0]!.id;
  const raw = await readJson(
    reader,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    signal,
  );
  if (raw === null) {
    return null;
  }
  const message = object({
    id: string(),
    threadId: string(),
    payload: gmailPartSchema,
  }).parse(raw);
  const headers = Object.fromEntries(
    message.payload.headers.map((header) => {
      return [header.name.toLowerCase(), header.value];
    }),
  );
  if (headers["message-id"]?.trim() !== reader.messageId) {
    return null;
  }
  const parts = [message.payload];
  const attachmentNames: string[] = [];
  while (parts.length > 0) {
    const part = parts.pop();
    if (!part) {
      break;
    }
    if (part.filename) {
      attachmentNames.push(part.filename);
    }
    parts.push(...part.parts);
  }
  return {
    providerMessageId: message.id,
    providerConversationId: message.threadId,
    headers,
    body: await gmailBody(reader, message.id, message.payload, signal),
    attachmentNames,
  };
}

async function readOutlookMessage(
  reader: EmailMessageReader,
  signal: AbortSignal,
): Promise<SourceEmailMessage | null> {
  const list = await readJson(
    reader,
    emailMessageSearchUrl("outlook-mail", reader.messageId),
    signal,
  );
  if (list === null) {
    return null;
  }
  const ids = object({
    value: array(object({ id: string(), internetMessageId: string() })),
  }).parse(list).value;
  if (ids.length > 1) {
    throw new EmailMessageReadError("ambiguous-message");
  }
  if (ids.length === 0 || ids[0]!.internetMessageId !== reader.messageId) {
    return null;
  }
  const raw = await readJson(
    reader,
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(ids[0]!.id)}?$select=id,conversationId,internetMessageId,internetMessageHeaders,subject,body`,
    signal,
  );
  if (raw === null) {
    return null;
  }
  const message = object({
    id: string(),
    conversationId: string(),
    internetMessageId: string(),
    subject: string(),
    internetMessageHeaders: array(
      object({ name: string(), value: string() }),
    ).default([]),
    body: object({ contentType: string(), content: string() }),
  }).parse(raw);
  if (message.internetMessageId !== reader.messageId) {
    return null;
  }
  return {
    providerMessageId: message.id,
    providerConversationId: message.conversationId,
    headers: {
      ...Object.fromEntries(
        message.internetMessageHeaders.map((header) => {
          return [header.name.toLowerCase(), header.value];
        }),
      ),
      subject: message.subject,
      "message-id": message.internetMessageId,
    },
    body:
      message.body.contentType.toLowerCase() === "html"
        ? plainTextFromHtml(message.body.content)
        : message.body.content,
    attachmentNames: [],
  };
}

export async function readConnectedEmailMessage(
  reader: EmailMessageReader,
  signal: AbortSignal,
): Promise<SourceEmailMessage | null> {
  return reader.connectorSlug === "gmail"
    ? await readGmailMessage(reader, signal)
    : await readOutlookMessage(reader, signal);
}
