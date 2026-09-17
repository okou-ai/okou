import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import {
  mailDraftSchema,
  mailDraftStatusSchema,
  type MailAttachment,
  type MailDraft,
  type MailDraftStatus,
  type MailInlineImage,
} from "@okouai/api-contracts/contracts/mail";
import { connectorAuthMethodHasRequiredScopes } from "@okouai/connectors/connector-auth-method";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { userConnectors } from "@okouai/db/schema/user-connector";
import { convert } from "html-to-text";
import { z } from "zod";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  GmailAuthorizationError,
  gmailResponseRequiresReconnect,
  handleGmailSendError,
  type GmailDraftRejection,
} from "./gmail-error";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { resolveConnectorCredentialAccess } from "./connector-credential-access.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";

const L = logger("api:mail-draft");

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS = 60 * 60 * 1000;
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_ACCESS_TOKEN_ENV = "GMAIL_TOKEN";
const oauthScopesSchema = z.array(z.string());

interface GmailMessagePart {
  readonly partId: string;
  readonly mimeType: string;
  readonly filename: string;
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: {
    readonly attachmentId?: string;
    readonly size: number;
    readonly data?: string;
  };
  readonly parts?: readonly GmailMessagePart[];
}

const gmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() => {
  return z.object({
    partId: z.string(),
    mimeType: z.string(),
    filename: z.string().default(""),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .default([]),
    body: z.object({
      attachmentId: z.string().optional(),
      size: z.number().int().nonnegative().default(0),
      data: z.string().optional(),
    }),
    parts: z.array(gmailMessagePartSchema).optional(),
  });
});

const gmailDraftResourceSchema = z.object({
  id: z.string(),
  message: z.object({
    id: z.string(),
    threadId: z.string(),
    payload: gmailMessagePartSchema,
  }),
});

const gmailMessageResourceSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  payload: gmailMessagePartSchema,
});

const gmailSentResourceSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});

const gmailAttachmentResourceSchema = z.object({
  size: z.number().int().nonnegative(),
  data: z.string(),
});

interface MailConnection extends ConnectorCredentialConnection {
  readonly connectorSlug: "gmail";
  readonly externalEmail: string;
  readonly externalUsername: string | null;
  readonly scopesReady: boolean;
}

interface MailDraftResult {
  readonly kind: "ok";
  readonly mailDraftId: string;
  readonly mailDraft: MailDraft;
}

interface MailDraftLinkResult {
  readonly kind: "ok";
  readonly mailDraftId: string;
}

interface MailDraftAttachmentSuccess {
  readonly kind: "ok";
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

interface MailDraftErrorResult {
  readonly kind: "not_found" | "conflict";
  readonly message: string;
}

export type MailDraftMutationResult = MailDraftResult | MailDraftErrorResult;

export type MailDraftLinkMutationResult =
  | MailDraftLinkResult
  | MailDraftErrorResult;

type MailDraftAttachmentResult =
  | MailDraftAttachmentSuccess
  | MailDraftErrorResult;

const reconnectMailError = Object.freeze({
  kind: "conflict" as const,
  message: "Reconnect Gmail before continuing",
});

interface MailDraftRow {
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly connectorId: string | null;
  readonly gmailDraftId: string;
  readonly gmailThreadId: string;
  readonly gmailMessageId: string;
  readonly sentGmailMessageId: string | null;
  readonly status: MailDraftStatus;
  readonly senderName: string | null;
  readonly senderAddress: string;
  readonly subject: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | null;
}

interface StoredMailDraftRow {
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly connectorId: string | null;
  readonly gmailDraftId: string | null;
  readonly gmailThreadId: string | null;
  readonly gmailMessageId: string | null;
  readonly sentGmailMessageId: string | null;
  readonly status: MailDraftStatus | null;
  readonly senderName: string | null;
  readonly senderAddress: string | null;
  readonly subject: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | null;
}

interface MailAccessTokenSuccess {
  readonly kind: "ok";
  readonly accessToken: string;
}

interface MailAccessTokenFailure {
  readonly kind: "error";
  readonly message: string;
}

type MailAccessTokenResult = MailAccessTokenSuccess | MailAccessTokenFailure;

interface MailDetails {
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly bodyHtml?: string;
  readonly inlineImages?: readonly MailInlineImage[];
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly attachments: readonly MailAttachment[];
}

interface GmailDraftValue {
  readonly draftId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly details: MailDetails;
}

interface GmailSentValue {
  readonly messageId: string;
  readonly threadId: string;
  readonly details: MailDetails | null;
}

interface MailAccess {
  readonly kind: "ok";
  readonly accessToken: string;
  readonly connection: MailConnection;
}

interface MailAccessFailure {
  readonly kind: "conflict";
  readonly message: string;
  readonly reconnectConnectionId?: string;
}

function linkResult(mailDraftId: string): MailDraftLinkResult {
  return {
    kind: "ok",
    mailDraftId,
  };
}

function okResult(mailDraftId: string, mailDraft: MailDraft): MailDraftResult {
  return {
    ...linkResult(mailDraftId),
    mailDraft,
  };
}

async function loadMailConnections(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly sourceId?: string;
}): Promise<readonly MailConnection[]> {
  const rows = await args.db
    .select({
      connectorId: connectors.id,
      connectorSlug: connectors.connectorSlug,
      authMethod: connectors.authMethod,
      externalEmail: connectors.externalEmail,
      externalUsername: connectors.externalUsername,
      externalId: connectors.externalId,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
      oauthGrantedScopes: connectors.oauthGrantedScopes,
      stateRevision: sql`${connectors.updatedAt}::text`.mapWith(pgTextDecoder),
      storageVersion: connectors.storageVersion,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(userConnectors)
    .innerJoin(
      connectors,
      and(
        eq(connectors.orgId, userConnectors.orgId),
        eq(connectors.userId, userConnectors.userId),
        eq(connectors.connectorSlug, userConnectors.connectorSlug),
      ),
    )
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
        eq(userConnectors.connectorSlug, "gmail"),
        args.sourceId
          ? eq(connectors.id, args.sourceId)
          : eq(connectors.isDefault, true),
      ),
    );

  return rows.flatMap((row): MailConnection[] => {
    if (row.connectorSlug !== "gmail" || !row.externalEmail) {
      return [];
    }
    const accessResult = resolveConnectorCredentialAccess({
      snapshot: args.snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId: args.orgId,
        storageVersion: row.storageVersion,
        userId: args.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      return [];
    }
    const { access } = accessResult;
    const runtimeMethod = access.runtimeMethod;
    const persistedOauthScopes = row.oauthGrantedScopes;
    const oauthScopes = persistedOauthScopes
      ? oauthScopesSchema.parse(JSON.parse(persistedOauthScopes))
      : null;
    return [
      {
        access,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        runtimeMethod,
        externalEmail: row.externalEmail,
        externalUsername: row.externalUsername,
        externalId: row.externalId,
        needsReconnect: row.needsReconnect,
        oauthScopes,
        stateRevision: row.stateRevision,
        storageVersion: access.storageVersion,
        scopesReady:
          oauthScopes === null ||
          connectorAuthMethodHasRequiredScopes(
            runtimeMethod.method,
            oauthScopes,
          ),
        tokenExpiresAt: row.tokenExpiresAt,
      },
    ];
  });
}

interface OwnedMailThreadContext {
  readonly agentId: string;
  readonly gmailConnectorId: string | null;
}

async function loadOwnedMailThreadContext(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<OwnedMailThreadContext | null> {
  const [row] = await args.db
    .select({
      agentId: agents.id,
      gmailConnectorId: chatThreadConnectorSelections.connectorId,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .leftJoin(
      chatThreadConnectorSelections,
      and(
        eq(chatThreadConnectorSelections.chatThreadId, chatThreads.id),
        eq(chatThreadConnectorSelections.connectorSlug, "gmail"),
      ),
    )
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadOwnedMailDraft(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly mailDraftId: string;
}): Promise<MailDraftRow | null> {
  const [row]: readonly StoredMailDraftRow[] = await args.db
    .select({
      id: mailDrafts.id,
      agentId: agents.id,
      chatThreadId: chatThreads.id,
      connectorId: mailDrafts.connectorId,
      gmailDraftId: mailDrafts.gmailDraftId,
      gmailThreadId: mailDrafts.gmailThreadId,
      gmailMessageId: mailDrafts.gmailMessageId,
      sentGmailMessageId: mailDrafts.sentGmailMessageId,
      status: mailDrafts.status,
      senderName: mailDrafts.senderName,
      senderAddress: mailDrafts.senderAddress,
      subject: mailDrafts.subject,
      createdAt: mailDrafts.createdAt,
      updatedAt: mailDrafts.updatedAt,
      sentAt: mailDrafts.sentAt,
    })
    .from(mailDrafts)
    .innerJoin(chatThreads, eq(chatThreads.id, mailDrafts.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(mailDrafts.id, args.mailDraftId),
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
      ),
    )
    .limit(1);
  return mailDraftRow(row);
}

function mailDraftRow(
  row: StoredMailDraftRow | undefined,
): MailDraftRow | null {
  if (
    !row?.gmailDraftId ||
    !row.gmailThreadId ||
    !row.gmailMessageId ||
    !row.senderAddress ||
    row.subject === null
  ) {
    return null;
  }
  const status = mailDraftStatusSchema.safeParse(row.status);
  if (!status.success) {
    return null;
  }
  return {
    ...row,
    gmailDraftId: row.gmailDraftId,
    gmailThreadId: row.gmailThreadId,
    gmailMessageId: row.gmailMessageId,
    status: status.data,
    senderAddress: row.senderAddress,
    subject: row.subject,
  };
}

async function loadLinkedDraft(args: {
  readonly db: ReadonlyDb;
  readonly connectorId: string;
  readonly gmailDraftId: string;
}): Promise<{ readonly id: string; readonly chatThreadId: string } | null> {
  const [row] = await args.db
    .select({ id: mailDrafts.id, chatThreadId: mailDrafts.chatThreadId })
    .from(mailDrafts)
    .where(
      and(
        eq(mailDrafts.connectorId, args.connectorId),
        eq(mailDrafts.gmailDraftId, args.gmailDraftId),
      ),
    )
    .limit(1);
  return row?.chatThreadId ? { ...row, chatThreadId: row.chatThreadId } : null;
}

async function resolveMailAccessToken(
  args: {
    readonly connection: MailConnection;
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly userId: string;
    readonly writeDb: Db;
  },
  signal: AbortSignal,
): Promise<MailAccessTokenResult> {
  if (args.connection.needsReconnect || !args.connection.scopesReady) {
    return { kind: "error", message: "Reconnect Gmail before continuing" };
  }
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    args.connection,
    GMAIL_ACCESS_TOKEN_ENV,
  );
  if (accessTokenValueRef === null) {
    return { kind: "error", message: "Reconnect Gmail before continuing" };
  }
  const values = await loadConnectorCredentialValues({
    connection: args.connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  const expiresAt = args.connection.tokenExpiresAt?.getTime() ?? 0;
  const accessToken = values.get(accessTokenValueRef);
  if (
    accessToken &&
    (expiresAt === 0 || expiresAt > nowDate().getTime() + TOKEN_REFRESH_SKEW_MS)
  ) {
    return { kind: "ok", accessToken };
  }
  const refreshed = await refreshConnectorCredentialAccess(
    {
      connection: args.connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: GMAIL_ACCESS_TOKEN_ENV,
      persist: {
        db: args.writeDb,
        defaultExpiresInMs: DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS,
      },
    },
    signal,
  );
  if (refreshed.kind === "configuration-unavailable") {
    return { kind: "error", message: "Gmail OAuth is not configured" };
  }
  return refreshed.kind === "ok"
    ? { kind: "ok", accessToken: refreshed.accessToken }
    : { kind: "error", message: "Reconnect Gmail before continuing" };
}

function decodeHeader(value: string): string {
  return value.replace(
    /=\?UTF-8\?([BQ])\?([^?]+)\?=/giu,
    (_match, encoding: string, encoded: string) => {
      if (encoding.toLowerCase() === "b") {
        return Buffer.from(encoded, "base64").toString("utf8");
      }
      const binary = encoded
        .replaceAll("_", " ")
        .replace(/=([0-9A-F]{2})/giu, (_escape, hex: string) => {
          return String.fromCharCode(Number.parseInt(hex, 16));
        });
      return Buffer.from(binary, "binary").toString("utf8");
    },
  );
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").flatMap((part): string[] => {
    const candidate = part.trim();
    const angle = candidate.match(/<([^>]+)>/u)?.[1];
    const address = (angle ?? candidate).trim();
    return z.email().safeParse(address).success ? [address] : [];
  });
}

function parseFromHeader(
  value: string | undefined,
  fallback: { readonly address: string; readonly name: string | null },
): { readonly address: string; readonly name?: string } {
  if (!value) {
    return fallback.name
      ? { address: fallback.address, name: fallback.name }
      : { address: fallback.address };
  }
  const decoded = decodeHeader(value).trim();
  const match = decoded.match(/^(.*?)\s*<([^>]+)>$/u);
  if (match?.[2] && z.email().safeParse(match[2]).success) {
    const name = match[1]?.trim().replace(/^"|"$/gu, "");
    return name ? { address: match[2], name } : { address: match[2] };
  }
  if (!z.email().safeParse(decoded).success) {
    throw new Error("Gmail draft has an invalid From header");
  }
  return { address: decoded };
}

function headerValue(part: GmailMessagePart, name: string): string | undefined {
  return part.headers.find((header) => {
    return header.name.toLowerCase() === name.toLowerCase();
  })?.value;
}

function decodedPartBody(part: GmailMessagePart): string | null {
  return part.body.data
    ? Buffer.from(part.body.data, "base64url").toString("utf8")
    : null;
}

function findBodyPart(
  part: GmailMessagePart,
  mimeType: "text/plain" | "text/html",
): string | null {
  if (!part.filename && part.mimeType.toLowerCase() === mimeType) {
    return decodedPartBody(part);
  }
  for (const child of part.parts ?? []) {
    const body = findBodyPart(child, mimeType);
    if (body !== null) {
      return body;
    }
  }
  return null;
}

const htmlAttributesSchema = z.record(z.string(), z.string());

function normalizedContentId(value: string): string {
  return value
    .trim()
    .replace(/^cid:/iu, "")
    .replace(/^<|>$/gu, "")
    .toLowerCase();
}

function inlineImagePartsByContentId(
  part: GmailMessagePart,
): ReadonlyMap<string, GmailMessagePart> {
  const parts = new Map<string, GmailMessagePart>();
  const contentId = headerValue(part, "content-id");
  if (
    contentId &&
    part.partId &&
    part.mimeType.toLowerCase().startsWith("image/")
  ) {
    parts.set(normalizedContentId(contentId), part);
  }
  for (const child of part.parts ?? []) {
    for (const [childContentId, childPart] of inlineImagePartsByContentId(
      child,
    )) {
      parts.set(childContentId, childPart);
    }
  }
  return parts;
}

interface RichMailBody {
  readonly html: string;
  readonly inlineImages: readonly MailInlineImage[];
  readonly inlinePartIds: ReadonlySet<string>;
}

function richMailBody(
  payload: GmailMessagePart,
  htmlBody: string | null,
): RichMailBody | null {
  if (!htmlBody) {
    return null;
  }
  const mimeParts = inlineImagePartsByContentId(payload);
  const inlineImages: MailInlineImage[] = [];
  convert(htmlBody, {
    wordwrap: false,
    formatters: {
      inlineImage(element) {
        const attributes = htmlAttributesSchema.safeParse(element.attribs);
        if (!attributes.success) {
          return;
        }
        const source = attributes.data.src;
        if (!source?.toLowerCase().startsWith("cid:")) {
          return;
        }
        const mimePart = mimeParts.get(normalizedContentId(source));
        if (!mimePart) {
          return;
        }
        inlineImages.push({
          contentId: normalizedContentId(source),
          partId: mimePart.partId,
          alt:
            attributes.data.alt?.trim() ||
            decodeHeader(mimePart.filename) ||
            "Inline email image",
        });
      },
    },
    selectors: [{ selector: "img", format: "inlineImage" }],
  });
  return {
    html: htmlBody,
    inlineImages,
    inlinePartIds: new Set(
      inlineImages.map((image) => {
        return image.partId;
      }),
    ),
  };
}

function attachmentMetadata(
  part: GmailMessagePart,
  inlinePartIds: ReadonlySet<string>,
): readonly MailAttachment[] {
  if (inlinePartIds.has(part.partId)) {
    return [];
  }
  if (part.filename || part.body.attachmentId) {
    return [
      {
        filename: decodeHeader(part.filename || "attachment"),
        contentType: part.mimeType,
        size: part.body.size,
        ...(part.body.data !== undefined || part.body.attachmentId
          ? { partId: part.partId }
          : {}),
      },
    ];
  }
  return (part.parts ?? []).flatMap((child) => {
    return attachmentMetadata(child, inlinePartIds);
  });
}

function mailDetailsFromPayload(
  payload: GmailMessagePart,
  fallbackSender: { readonly address: string; readonly name: string | null },
): MailDetails {
  const from = parseFromHeader(headerValue(payload, "from"), fallbackSender);
  const plainBody = findBodyPart(payload, "text/plain");
  const htmlBody = findBodyPart(payload, "text/html");
  const richBody = richMailBody(payload, htmlBody);
  return {
    from: from.address,
    ...(from.name ? { fromName: from.name } : {}),
    to: parseAddressList(headerValue(payload, "to")),
    cc: parseAddressList(headerValue(payload, "cc")),
    bcc: parseAddressList(headerValue(payload, "bcc")),
    subject: decodeHeader(headerValue(payload, "subject") ?? ""),
    body:
      plainBody ??
      (htmlBody ? convert(htmlBody, { wordwrap: false }).trim() : ""),
    ...(richBody
      ? {
          bodyHtml: richBody.html,
          inlineImages: richBody.inlineImages,
        }
      : {}),
    ...(headerValue(payload, "reply-to")
      ? { replyTo: decodeHeader(headerValue(payload, "reply-to")!) }
      : {}),
    ...(headerValue(payload, "in-reply-to")
      ? { inReplyTo: headerValue(payload, "in-reply-to")! }
      : {}),
    references: (headerValue(payload, "references") ?? "")
      .split(/\s+/u)
      .filter(Boolean),
    attachments: attachmentMetadata(
      payload,
      richBody?.inlinePartIds ?? new Set(),
    ),
  };
}

function findAttachmentPart(
  part: GmailMessagePart,
  partId: string,
): GmailMessagePart | null {
  if (
    part.partId === partId &&
    (part.body.data !== undefined || part.body.attachmentId)
  ) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findAttachmentPart(child, partId);
    if (found) {
      return found;
    }
  }
  return null;
}

async function gmailGetDraftResource(
  args: {
    readonly accessToken: string;
    readonly gmailDraftId: string;
  },
  signal: AbortSignal,
): Promise<z.infer<typeof gmailDraftResourceSchema> | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}?format=full`,
    {
      signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (await gmailResponseRequiresReconnect(response)) {
    throw new GmailAuthorizationError();
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to read Gmail draft (HTTP ${response.status})`);
  }
  return gmailDraftResourceSchema.parse(await response.json());
}

async function gmailGetDraft(
  args: {
    readonly accessToken: string;
    readonly gmailDraftId: string;
    readonly fallbackSender: {
      readonly address: string;
      readonly name: string | null;
    };
  },
  signal: AbortSignal,
): Promise<GmailDraftValue | null> {
  const draft = await gmailGetDraftResource(args, signal);
  if (!draft) {
    return null;
  }
  return {
    draftId: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    details: mailDetailsFromPayload(draft.message.payload, args.fallbackSender),
  };
}

async function gmailSendLinkedDraft(
  args: {
    readonly accessToken: string;
    readonly gmailDraftId: string;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "sent";
      readonly messageId: string;
      readonly threadId: string;
    }
  | GmailDraftRejection
  | null
> {
  const response = await fetch(`${GMAIL_API_BASE}/drafts/send`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: args.gmailDraftId }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    return await handleGmailSendError(response);
  }
  const message = gmailSentResourceSchema.parse(await response.json());
  return { kind: "sent", messageId: message.id, threadId: message.threadId };
}

async function gmailGetMessageResource(
  args: {
    readonly accessToken: string;
    readonly gmailMessageId: string;
  },
  signal: AbortSignal,
): Promise<z.infer<typeof gmailMessageResourceSchema> | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}?format=full`,
    {
      signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (await gmailResponseRequiresReconnect(response)) {
    throw new GmailAuthorizationError();
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to read sent Gmail message (HTTP ${response.status})`,
    );
  }
  return gmailMessageResourceSchema.parse(await response.json());
}

async function gmailGetMessage(
  args: {
    readonly accessToken: string;
    readonly gmailMessageId: string;
    readonly fallbackSender: {
      readonly address: string;
      readonly name: string | null;
    };
  },
  signal: AbortSignal,
): Promise<GmailSentValue | null> {
  const message = await gmailGetMessageResource(args, signal);
  if (!message) {
    return null;
  }
  return {
    messageId: message.id,
    threadId: message.threadId,
    details: mailDetailsFromPayload(message.payload, args.fallbackSender),
  };
}

async function gmailGetAttachment(
  args: {
    readonly accessToken: string;
    readonly gmailMessageId: string;
    readonly attachmentId: string;
  },
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}/attachments/${encodeURIComponent(args.attachmentId)}`,
    {
      signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (await gmailResponseRequiresReconnect(response)) {
    throw new GmailAuthorizationError();
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to read Gmail attachment (HTTP ${response.status})`,
    );
  }
  const attachment = gmailAttachmentResourceSchema.parse(await response.json());
  return new Uint8Array(Buffer.from(attachment.data, "base64url"));
}

async function gmailDeleteDraft(
  args: {
    readonly accessToken: string;
    readonly gmailDraftId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}`,
    {
      method: "DELETE",
      signal,
      headers: { Authorization: `Bearer ${args.accessToken}` },
    },
  );
  if (await gmailResponseRequiresReconnect(response)) {
    throw new GmailAuthorizationError();
  }
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Gmail rejected draft deletion (HTTP ${response.status})`);
  }
}

function responseDetails(
  row: MailDraftRow,
  details: MailDetails | null,
): MailDetails {
  return (
    details ?? {
      from: row.senderAddress,
      ...(row.senderName ? { fromName: row.senderName } : {}),
      to: [],
      cc: [],
      bcc: [],
      subject: row.subject,
      body: "",
      references: [],
      attachments: [],
    }
  );
}

function responseDraft(args: {
  readonly row: MailDraftRow;
  readonly details: MailDetails | null;
  readonly detailAvailable: boolean;
  readonly accessStatus?: "ready" | "reconnect";
  readonly reconnectConnectionId?: string;
}): MailDraft {
  const details = responseDetails(args.row, args.details);
  return mailDraftSchema.parse({
    version: 3,
    provider: "gmail",
    from: details.from,
    fromName: details.fromName,
    to: details.to,
    cc: details.cc,
    bcc: details.bcc,
    subject: details.subject,
    body: details.body,
    bodyHtml: details.bodyHtml,
    inlineImages: details.inlineImages,
    accessStatus: args.accessStatus ?? "ready",
    reconnectConnectionId: args.reconnectConnectionId,
    replyTo: details.replyTo,
    inReplyTo: details.inReplyTo,
    references: details.references,
    attachments: details.attachments,
    status: args.row.status,
    detailAvailable: args.detailAvailable,
    gmailDraftId: args.row.gmailDraftId,
    gmailThreadId: args.row.gmailThreadId,
    gmailMessageId: args.row.gmailMessageId,
    sentGmailMessageId: args.row.sentGmailMessageId ?? undefined,
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
    sentAt: args.row.sentAt?.toISOString(),
  });
}

async function markGmailNeedsReconnect(args: {
  readonly db: Db;
  readonly connectorId: string;
}): Promise<void> {
  await args.db
    .update(connectors)
    .set({
      needsReconnect: true,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(connectors.id, args.connectorId));
}

async function runGmailOperation<T>(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly operation: () => Promise<T>;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "reconnect" }
  | { readonly kind: "error"; readonly error: unknown }
> {
  const result = await settle(args.operation(), signal);
  signal.throwIfAborted();
  if (result.ok) {
    return { kind: "ok", value: result.value };
  }
  if (!(result.error instanceof GmailAuthorizationError)) {
    return { kind: "error", error: result.error };
  }
  await markGmailNeedsReconnect(args);
  signal.throwIfAborted();
  return { kind: "reconnect" };
}

function reconnectDraftResult(
  row: MailDraftRow,
  reconnectConnectionId?: string,
): MailDraftResult {
  return okResult(
    row.id,
    responseDraft({
      row,
      details: null,
      detailAvailable: false,
      accessStatus: "reconnect",
      reconnectConnectionId,
    }),
  );
}

function accessReconnectDraftResult(
  row: MailDraftRow,
  access: MailAccessFailure,
): MailDraftResult {
  return reconnectDraftResult(
    row,
    access.reconnectConnectionId ?? row.connectorId ?? undefined,
  );
}

async function connectionForRow(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly orgId: string;
  readonly userId: string;
  readonly row: MailDraftRow;
}): Promise<MailConnection | null> {
  const connections = await loadMailConnections({
    db: args.db,
    snapshot: args.snapshot,
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.row.agentId,
    sourceId: args.row.connectorId ?? undefined,
  });
  const linked = connections.find((connection) => {
    return connection.connectorId === args.row.connectorId;
  });
  if (linked || args.row.connectorId !== null) {
    return linked ?? null;
  }
  const senderAddress = args.row.senderAddress.toLowerCase();
  return (
    connections.find((connection) => {
      return connection.externalEmail.toLowerCase() === senderAddress;
    }) ?? null
  );
}

async function accessForRow(
  args: {
    readonly db: ReadonlyDb;
    readonly writeDb: Db;
    readonly snapshot: ConnectorRuntimeSnapshot;
    readonly orgId: string;
    readonly userId: string;
    readonly row: MailDraftRow;
  },
  signal: AbortSignal,
): Promise<MailAccess | MailAccessFailure> {
  const connection = await connectionForRow(args);
  if (!connection) {
    return { kind: "conflict", message: "Reconnect Gmail before continuing" };
  }
  const access = await resolveMailAccessToken(
    {
      connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      writeDb: args.writeDb,
    },
    signal,
  );
  return access.kind === "ok"
    ? { ...access, connection }
    : {
        kind: "conflict",
        message: access.message,
        reconnectConnectionId: connection.connectorId,
      };
}

async function persistLinkedDraft(args: {
  readonly db: Db;
  readonly gmail: GmailDraftValue;
  readonly connection: MailConnection;
  readonly threadId: string;
}): Promise<
  | { readonly kind: "created"; readonly mailDraftId: string }
  | {
      readonly kind: "existing";
      readonly mailDraftId: string;
      readonly chatThreadId: string;
    }
> {
  const mailDraftId = randomUUID();
  const createdAt = nowDate();
  const result = await args.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(mailDrafts)
      .values({
        id: mailDraftId,
        chatThreadId: args.threadId,
        connectorId: args.connection.connectorId,
        gmailDraftId: args.gmail.draftId,
        gmailThreadId: args.gmail.threadId,
        gmailMessageId: args.gmail.messageId,
        status: "draft",
        senderName: args.gmail.details.fromName ?? null,
        senderAddress: args.gmail.details.from,
        subject: args.gmail.details.subject,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing({
        target: [mailDrafts.connectorId, mailDrafts.gmailDraftId],
      })
      .returning({ id: mailDrafts.id });
    if (!inserted) {
      const existing = await loadLinkedDraft({
        db: tx,
        connectorId: args.connection.connectorId,
        gmailDraftId: args.gmail.draftId,
      });
      if (!existing) {
        throw new Error("Linked Gmail draft row could not be loaded");
      }
      return {
        kind: "existing" as const,
        mailDraftId: existing.id,
        chatThreadId: existing.chatThreadId,
      };
    }
    return {
      kind: "created" as const,
      mailDraftId,
    };
  });
  return result;
}

async function markDeleted(args: {
  readonly db: Db;
  readonly row: MailDraftRow;
}): Promise<MailDraftRow> {
  const updatedAt = nowDate();
  await args.db
    .update(mailDrafts)
    .set({ status: "deleted", updatedAt })
    .where(eq(mailDrafts.id, args.row.id));
  return { ...args.row, status: "deleted", updatedAt };
}

async function updateRowFromDraft(args: {
  readonly db: Db;
  readonly row: MailDraftRow;
  readonly gmail: GmailDraftValue;
}): Promise<MailDraftRow> {
  const updatedAt = nowDate();
  await args.db
    .update(mailDrafts)
    .set({
      gmailThreadId: args.gmail.threadId,
      gmailMessageId: args.gmail.messageId,
      senderName: args.gmail.details.fromName ?? null,
      senderAddress: args.gmail.details.from,
      subject: args.gmail.details.subject,
      updatedAt,
    })
    .where(eq(mailDrafts.id, args.row.id));
  return {
    ...args.row,
    gmailThreadId: args.gmail.threadId,
    gmailMessageId: args.gmail.messageId,
    senderName: args.gmail.details.fromName ?? null,
    senderAddress: args.gmail.details.from,
    subject: args.gmail.details.subject,
    updatedAt,
  };
}

async function getMailDraft(
  args: {
    readonly db: ReadonlyDb;
    readonly writeDb: Db;
    readonly snapshot: ConnectorRuntimeSnapshot;
    readonly orgId: string;
    readonly userId: string;
    readonly row: MailDraftRow;
  },
  signal: AbortSignal,
): Promise<MailDraftMutationResult> {
  if (args.row.status === "deleted") {
    return okResult(
      args.row.id,
      responseDraft({ row: args.row, details: null, detailAvailable: false }),
    );
  }
  const access = await accessForRow(args, signal);
  if (args.row.status === "sent") {
    const sentGmailMessageId = args.row.sentGmailMessageId;
    const stored = okResult(
      args.row.id,
      responseDraft({ row: args.row, details: null, detailAvailable: false }),
    );
    if (access.kind !== "ok" || !sentGmailMessageId) {
      return access.kind === "ok"
        ? stored
        : accessReconnectDraftResult(args.row, access);
    }
    let sent: GmailSentValue | null = null;
    const sentResult = await runGmailOperation(
      {
        db: args.writeDb,
        connectorId: access.connection.connectorId,
        operation: async () => {
          return await gmailGetMessage(
            {
              accessToken: access.accessToken,
              gmailMessageId: sentGmailMessageId,
              fallbackSender: {
                address: access.connection.externalEmail,
                name: access.connection.externalUsername,
              },
            },
            signal,
          );
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (sentResult.kind === "reconnect") {
      return reconnectDraftResult(args.row, access.connection.connectorId);
    }
    if (sentResult.kind === "error") {
      L.warn("Failed to enrich sent Gmail draft card", {
        mailDraftId: args.row.id,
        gmailMessageId: sentGmailMessageId,
        error: sentResult.error,
      });
    } else {
      sent = sentResult.value;
    }
    return sent
      ? okResult(
          args.row.id,
          responseDraft({
            row: args.row,
            details: sent.details,
            detailAvailable: sent.details !== null,
          }),
        )
      : stored;
  }
  if (access.kind !== "ok") {
    return accessReconnectDraftResult(args.row, access);
  }
  const gmailResult = await runGmailOperation(
    {
      db: args.writeDb,
      connectorId: access.connection.connectorId,
      operation: async () => {
        return await gmailGetDraft(
          {
            accessToken: access.accessToken,
            gmailDraftId: args.row.gmailDraftId,
            fallbackSender: {
              address: access.connection.externalEmail,
              name: access.connection.externalUsername,
            },
          },
          signal,
        );
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (gmailResult.kind === "reconnect") {
    return reconnectDraftResult(args.row, access.connection.connectorId);
  }
  if (gmailResult.kind === "error") {
    throw gmailResult.error;
  }
  const gmail = gmailResult.value;
  if (!gmail) {
    const deleted = await markDeleted({ db: args.writeDb, row: args.row });
    return okResult(
      args.row.id,
      responseDraft({ row: deleted, details: null, detailAvailable: false }),
    );
  }
  const updatedRow = await updateRowFromDraft({
    db: args.writeDb,
    row: args.row,
    gmail,
  });
  return okResult(
    args.row.id,
    responseDraft({
      row: updatedRow,
      details: gmail.details,
      detailAvailable: true,
    }),
  );
}

async function gmailAttachmentSource(
  args: {
    readonly accessToken: string;
    readonly row: MailDraftRow;
    readonly partId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly messageId: string;
  readonly part: GmailMessagePart;
} | null> {
  if (args.row.status === "deleted") {
    return null;
  }
  if (args.row.status === "sent") {
    if (!args.row.sentGmailMessageId) {
      return null;
    }
    const message = await gmailGetMessageResource(
      {
        accessToken: args.accessToken,
        gmailMessageId: args.row.sentGmailMessageId,
      },
      signal,
    );
    const part = message
      ? findAttachmentPart(message.payload, args.partId)
      : null;
    return message &&
      part &&
      (part.body.data !== undefined || part.body.attachmentId)
      ? {
          messageId: message.id,
          part,
        }
      : null;
  }
  const draft = await gmailGetDraftResource(
    {
      accessToken: args.accessToken,
      gmailDraftId: args.row.gmailDraftId,
    },
    signal,
  );
  const part = draft
    ? findAttachmentPart(draft.message.payload, args.partId)
    : null;
  return draft &&
    part &&
    (part.body.data !== undefined || part.body.attachmentId)
    ? {
        messageId: draft.message.id,
        part,
      }
    : null;
}

async function gmailAttachmentContent(
  args: {
    readonly accessToken: string;
    readonly messageId: string;
    readonly part: GmailMessagePart;
  },
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (args.part.body.data !== undefined) {
    return new Uint8Array(Buffer.from(args.part.body.data, "base64url"));
  }
  const attachmentId = args.part.body.attachmentId;
  if (!attachmentId) {
    return null;
  }
  return await gmailGetAttachment(
    {
      accessToken: args.accessToken,
      gmailMessageId: args.messageId,
      attachmentId,
    },
    signal,
  );
}

async function sendGmailDraftWithAccess(
  args: {
    readonly access: MailAccess;
    readonly db: Db;
    readonly row: MailDraftRow;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly current: GmailDraftValue;
      readonly sent: { readonly messageId: string; readonly threadId: string };
    }
  | { readonly kind: "missing" }
  | { readonly kind: "reconnect" }
  | GmailDraftRejection
> {
  const currentResult = await runGmailOperation(
    {
      db: args.db,
      connectorId: args.access.connection.connectorId,
      operation: async () => {
        return await gmailGetDraft(
          {
            accessToken: args.access.accessToken,
            gmailDraftId: args.row.gmailDraftId,
            fallbackSender: {
              address: args.access.connection.externalEmail,
              name: args.access.connection.externalUsername,
            },
          },
          signal,
        );
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (currentResult.kind === "reconnect") {
    return currentResult;
  }
  if (currentResult.kind === "error") {
    throw currentResult.error;
  }
  if (!currentResult.value) {
    return { kind: "missing" };
  }
  const sentResult = await runGmailOperation(
    {
      db: args.db,
      connectorId: args.access.connection.connectorId,
      operation: async () => {
        return await gmailSendLinkedDraft(
          {
            accessToken: args.access.accessToken,
            gmailDraftId: args.row.gmailDraftId,
          },
          signal,
        );
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (sentResult.kind === "reconnect") {
    return sentResult;
  }
  if (sentResult.kind === "error") {
    throw sentResult.error;
  }
  if (sentResult.value?.kind === "rejected") {
    return sentResult.value;
  }
  return sentResult.value
    ? { kind: "ok", current: currentResult.value, sent: sentResult.value }
    : { kind: "missing" };
}

export const linkMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly agentId?: string;
      readonly gmailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftLinkMutationResult> => {
    const db = get(db$);
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const thread = await loadOwnedMailThreadContext({ db, ...args });
    signal.throwIfAborted();
    if (!thread || (args.agentId && thread.agentId !== args.agentId)) {
      return { kind: "not_found", message: "Chat thread not found" };
    }
    const connections = (
      await loadMailConnections({
        db,
        snapshot,
        orgId: args.orgId,
        userId: args.userId,
        agentId: thread.agentId,
        sourceId: thread.gmailConnectorId ?? undefined,
      })
    ).filter((connection) => {
      return !connection.needsReconnect && connection.scopesReady;
    });
    signal.throwIfAborted();
    const connection = connections.length === 1 ? connections[0] : undefined;
    if (!connection) {
      return {
        kind: "conflict",
        message:
          connections.length === 0
            ? "Connect and authorize Gmail for this agent first"
            : "The agent has more than one Gmail connection",
      };
    }
    const existing = await loadLinkedDraft({
      db,
      connectorId: connection.connectorId,
      gmailDraftId: args.gmailDraftId,
    });
    signal.throwIfAborted();
    if (existing) {
      return existing.chatThreadId === args.threadId
        ? linkResult(existing.id)
        : {
            kind: "conflict",
            message: "This Gmail draft is already linked to another chat",
          };
    }
    const access = await resolveMailAccessToken(
      {
        connection,
        db,
        orgId: args.orgId,
        userId: args.userId,
        writeDb: set(writeDb$),
      },
      signal,
    );
    if (access.kind !== "ok") {
      return { kind: "conflict", message: access.message };
    }
    const gmailResult = await runGmailOperation(
      {
        db: set(writeDb$),
        connectorId: connection.connectorId,
        operation: async () => {
          return await gmailGetDraft(
            {
              accessToken: access.accessToken,
              gmailDraftId: args.gmailDraftId,
              fallbackSender: {
                address: connection.externalEmail,
                name: connection.externalUsername,
              },
            },
            signal,
          );
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (gmailResult.kind === "reconnect") {
      return reconnectMailError;
    }
    if (gmailResult.kind === "error") {
      throw gmailResult.error;
    }
    const gmail = gmailResult.value;
    if (!gmail) {
      return { kind: "not_found", message: "Gmail draft not found" };
    }
    const persisted = await persistLinkedDraft({
      db: set(writeDb$),
      gmail,
      connection,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (
      persisted.kind === "existing" &&
      persisted.chatThreadId !== args.threadId
    ) {
      return {
        kind: "conflict",
        message: "This Gmail draft is already linked to another chat",
      };
    }
    return linkResult(persisted.mailDraftId);
  },
);

export const getMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    return await getMailDraft(
      {
        db,
        writeDb: set(writeDb$),
        snapshot,
        orgId: args.orgId,
        userId: args.userId,
        row,
      },
      signal,
    );
  },
);

export const getMailDraftAttachment$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
      readonly partId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftAttachmentResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const access = await accessForRow(
      {
        db,
        writeDb: set(writeDb$),
        snapshot,
        orgId: args.orgId,
        userId: args.userId,
        row,
      },
      signal,
    );
    if (access.kind !== "ok") {
      return access;
    }
    const sourceResult = await runGmailOperation(
      {
        db: set(writeDb$),
        connectorId: access.connection.connectorId,
        operation: async () => {
          return await gmailAttachmentSource(
            {
              accessToken: access.accessToken,
              row,
              partId: args.partId,
            },
            signal,
          );
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (sourceResult.kind === "reconnect") {
      return reconnectMailError;
    }
    if (sourceResult.kind === "error") {
      throw sourceResult.error;
    }
    const source = sourceResult.value;
    if (!source) {
      return {
        kind: "not_found",
        message: "Mail draft attachment not found",
      };
    }
    const contentResult = await runGmailOperation(
      {
        db: set(writeDb$),
        connectorId: access.connection.connectorId,
        operation: async () => {
          return await gmailAttachmentContent(
            {
              accessToken: access.accessToken,
              messageId: source.messageId,
              part: source.part,
            },
            signal,
          );
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (contentResult.kind === "reconnect") {
      return reconnectMailError;
    }
    if (contentResult.kind === "error") {
      throw contentResult.error;
    }
    const content = contentResult.value;
    if (!content) {
      return {
        kind: "not_found",
        message: "Mail draft attachment not found",
      };
    }
    return {
      kind: "ok",
      content,
      contentType: source.part.mimeType,
      filename: decodeHeader(source.part.filename || "attachment"),
    };
  },
);

export const deleteMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.status !== "draft") {
      return {
        kind: "conflict",
        message: "Only an active draft can be deleted",
      };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const access = await accessForRow(
      {
        db,
        writeDb: set(writeDb$),
        snapshot,
        orgId: args.orgId,
        userId: args.userId,
        row,
      },
      signal,
    );
    if (access.kind !== "ok") {
      return access;
    }
    const deletion = await runGmailOperation(
      {
        db: set(writeDb$),
        connectorId: access.connection.connectorId,
        operation: async () => {
          await gmailDeleteDraft(
            {
              accessToken: access.accessToken,
              gmailDraftId: row.gmailDraftId,
            },
            signal,
          );
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (deletion.kind === "reconnect") {
      return reconnectMailError;
    }
    if (deletion.kind === "error") {
      throw deletion.error;
    }
    const deletedDraft = responseDraft({
      row: { ...row, status: "deleted" },
      details: null,
      detailAvailable: false,
    });
    return okResult(row.id, deletedDraft);
  },
);

export const sendMailDraft$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult | GmailDraftRejection> => {
    const db = get(db$);
    const row = await loadOwnedMailDraft({ db, ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.status !== "draft") {
      return {
        kind: "conflict",
        message: "This mail draft can no longer be sent",
      };
    }
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const access = await accessForRow(
      {
        db,
        writeDb: set(writeDb$),
        snapshot,
        orgId: args.orgId,
        userId: args.userId,
        row,
      },
      signal,
    );
    if (access.kind !== "ok") {
      return access;
    }
    const gmail = await sendGmailDraftWithAccess(
      {
        access,
        db: set(writeDb$),
        row,
      },
      signal,
    );
    signal.throwIfAborted();
    if (gmail.kind === "reconnect") {
      return reconnectMailError;
    }
    if (gmail.kind === "rejected") {
      return gmail;
    }
    if (gmail.kind === "missing") {
      const deleted = await markDeleted({ db: set(writeDb$), row });
      signal.throwIfAborted();
      return okResult(
        row.id,
        responseDraft({ row: deleted, details: null, detailAvailable: false }),
      );
    }
    const sentAt = nowDate();
    await set(writeDb$)
      .update(mailDrafts)
      .set({
        status: "sent",
        gmailThreadId: gmail.sent.threadId,
        gmailMessageId: gmail.current.messageId,
        sentGmailMessageId: gmail.sent.messageId,
        senderName: gmail.current.details.fromName ?? null,
        senderAddress: gmail.current.details.from,
        subject: gmail.current.details.subject,
        sentAt,
        updatedAt: sentAt,
      })
      .where(eq(mailDrafts.id, row.id));
    signal.throwIfAborted();
    const sentRow: MailDraftRow = {
      ...row,
      status: "sent",
      gmailThreadId: gmail.sent.threadId,
      gmailMessageId: gmail.current.messageId,
      sentGmailMessageId: gmail.sent.messageId,
      senderName: gmail.current.details.fromName ?? null,
      senderAddress: gmail.current.details.from,
      subject: gmail.current.details.subject,
      sentAt,
      updatedAt: sentAt,
    };
    return okResult(
      row.id,
      responseDraft({
        row: sentRow,
        details: gmail.current.details,
        detailAvailable: true,
      }),
    );
  },
);
