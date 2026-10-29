import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  threadMailSummarySchema,
  mailDraftSchema,
  mailDraftStatusSchema,
  mailProviderSchema,
  type MailDraft,
  type MailDraftStatus,
  type MailAttachment,
  type MailInlineImage,
  type MailProvider,
  type LinkMailDraftInput,
  type ThreadMailSummary,
} from "@okouai/api-contracts/contracts/mail";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectorAuthMethodHasRequiredScopes } from "@okouai/connectors/connector-auth-method";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { command } from "ccstate";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { convert } from "html-to-text";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  array,
  email,
  lazy,
  number,
  object,
  record,
  string,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { resolveBuiltinConnectorCredentialAccess } from "./builtin-connector-credential-access.service";
import {
  loadBuiltinConnectorCredentialValues$,
  refreshBuiltinConnectorCredentialAccess$,
  builtinConnectorCredentialRuntimeValueRef,
  type BuiltinConnectorCredentialConnection,
} from "./builtin-connector-credential-runtime.service";

import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import {
  GmailAuthorizationError,
  gmailResponseRequiresReconnect,
  handleGmailSendError,
  type GmailDraftRejection,
} from "./gmail-error";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "./connector-catalog-slug-source.service";

import {
  OutlookAuthorizationError,
  OutlookRequestError,
  outlookGetMessage,
  outlookHasRequiredMailScopes,
  outlookGetAttachment,
  outlookSendDraft,
  outlookDeleteDraft,
  type OutlookMailValue,
} from "./outlook-mail";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import type { MailDetails, MailDraftValue } from "./mail-details";

const L = logger("api:mail-draft");

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS = 60 * 60 * 1000;
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_ACCESS_TOKEN_ENV = "GMAIL_TOKEN";
const oauthScopesSchema = array(string());

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

const gmailMessagePartSchema: ZodType<GmailMessagePart> = lazy(() => {
  return object({
    partId: string(),
    mimeType: string(),
    filename: string().default(""),
    headers: array(object({ name: string(), value: string() })).default([]),
    body: object({
      attachmentId: string().optional(),
      size: number().int().nonnegative().default(0),
      data: string().optional(),
    }),
    parts: array(gmailMessagePartSchema).optional(),
  });
});

const gmailDraftResourceSchema = object({
  id: string(),
  message: object({
    id: string(),
    threadId: string(),
    payload: gmailMessagePartSchema,
  }),
});

const gmailMessageResourceSchema = object({
  id: string(),
  threadId: string(),
  payload: gmailMessagePartSchema,
});

const gmailSentResourceSchema = object({
  id: string(),
  threadId: string(),
});

const gmailAttachmentResourceSchema = object({
  size: number().int().nonnegative(),
  data: string(),
});

interface MailConnection extends BuiltinConnectorCredentialConnection {
  readonly connectorSlug: "gmail" | "outlook-mail";
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
  MailDraftLinkResult | MailDraftErrorResult;

type MailDraftAttachmentResult =
  MailDraftAttachmentSuccess | MailDraftErrorResult;

function reconnectMailError(provider: MailProvider): MailDraftErrorResult {
  return {
    kind: "conflict",
    message: `Reconnect ${provider === "gmail" ? "Gmail" : "Outlook"} before continuing`,
  };
}

interface MailDraftRow {
  readonly provider: MailProvider;
  readonly webLink: string | null;
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly connectorId: string | null;
  readonly draftId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly sentMessageId: string | null;
  readonly status: MailDraftStatus;
  readonly senderName: string | null;
  readonly senderAddress: string;
  readonly subject: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sentAt: Date | null;
}

interface StoredMailDraftRow {
  readonly provider: MailProvider;
  readonly outlookMessageId: string | null;
  readonly outlookConversationId: string | null;
  readonly outlookWebLink: string | null;
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

const loadMailCatalog$ = command(
  async (
    { set },
    provider: MailProvider,
  ): Promise<ConnectorRuntimeSelection> => {
    const db = set(writeDb$);
    const plan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [provider === "gmail" ? "gmail" : "outlook-mail"],
    });
    return connectorRuntimeSlugSelectionFromRows(
      plan.selection,
      await db
        .select(plan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, plan.join)
        .where(connectorCatalogCurrentWhere()),
    );
  },
);

async function mailGetProviderDraft(
  args: {
    readonly provider: MailProvider;
    readonly draftId: string;
    readonly accessToken: string;
    readonly fallbackSender: {
      readonly address: string;
      readonly name: string | null;
    };
  },
  signal: AbortSignal,
): Promise<MailDraftValue | OutlookMailValue | null> {
  return args.provider === "outlook"
    ? await outlookGetMessage({ ...args, messageId: args.draftId }, signal)
    : await gmailGetDraft({ ...args, gmailDraftId: args.draftId }, signal);
}

const loadMailConnections$ = command(
  async (
    { set },
    args: {
      readonly connectorSlug?: "gmail" | "outlook-mail";
      readonly snapshot: ConnectorRuntimeSelection;
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string;
      readonly sourceId?: string;
    },
  ): Promise<readonly MailConnection[]> => {
    const db = set(writeDb$);
    const rows = await db
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
        stateRevision: sql`${connectors.updatedAt}::text`.mapWith(
          pgTextDecoder,
        ),
        storageVersion: connectors.storageVersion,
        tokenExpiresAt: connectors.tokenExpiresAt,
      })
      .from(userBuiltinConnectors)
      .innerJoin(
        connectors,
        and(
          eq(connectors.orgId, userBuiltinConnectors.orgId),
          eq(connectors.userId, userBuiltinConnectors.userId),
          eq(connectors.connectorSlug, userBuiltinConnectors.connectorSlug),
        ),
      )
      .where(
        and(
          eq(userBuiltinConnectors.orgId, args.orgId),
          eq(userBuiltinConnectors.userId, args.userId),
          eq(userBuiltinConnectors.agentId, args.agentId),
          eq(
            userBuiltinConnectors.connectorSlug,
            args.connectorSlug ?? "gmail",
          ),
          args.sourceId
            ? eq(connectors.id, args.sourceId)
            : eq(connectors.isDefault, true),
        ),
      );

    return rows.flatMap((row): MailConnection[] => {
      if (
        (row.connectorSlug !== "gmail" &&
          row.connectorSlug !== "outlook-mail") ||
        !row.externalEmail
      ) {
        return [];
      }
      const accessResult = resolveBuiltinConnectorCredentialAccess({
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
            (row.connectorSlug === "outlook-mail"
              ? outlookHasRequiredMailScopes(oauthScopes)
              : connectorAuthMethodHasRequiredScopes(
                  runtimeMethod.method,
                  oauthScopes,
                )),
          tokenExpiresAt: row.tokenExpiresAt,
        },
      ];
    });
  },
);

interface OwnedMailThreadContext {
  readonly agentId: string;
  readonly connectorId: string | null;
}

const loadOwnedMailThreadContext$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly provider?: MailProvider;
    },
  ): Promise<OwnedMailThreadContext | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        agentId: agents.id,
        connectorId: chatThreadConnectorSelections.connectorId,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .leftJoin(
        chatThreadConnectorSelections,
        and(
          eq(chatThreadConnectorSelections.chatThreadId, chatThreads.id),
          eq(
            chatThreadConnectorSelections.connectorSlug,
            args.provider === "outlook" ? "outlook-mail" : "gmail",
          ),
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
  },
);

const loadOwnedMailDraft$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
  ): Promise<MailDraftRow | null> => {
    const db = set(writeDb$);
    const [row]: readonly StoredMailDraftRow[] = await db
      .select({
        id: mailDrafts.id,
        agentId: agents.id,
        chatThreadId: chatThreads.id,
        connectorId: mailDrafts.connectorId,
        provider: mailDrafts.provider,
        outlookMessageId: mailDrafts.outlookMessageId,
        outlookConversationId: mailDrafts.outlookConversationId,
        outlookWebLink: mailDrafts.outlookWebLink,
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
  },
);

export const listThreadMail$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
    },
    signal: AbortSignal,
  ): Promise<ThreadMailSummary[] | null> => {
    const thread = await set(loadOwnedMailThreadContext$, args);
    signal.throwIfAborted();
    if (!thread) {
      return null;
    }
    const outlookEnabled = await set(requireOutlookChatMail$, args, signal);
    const rows = await set(writeDb$)
      .select({
        mailDraftId: mailDrafts.id,
        status: mailDrafts.status,
        subject: mailDrafts.subject,
        from: mailDrafts.senderAddress,
        createdAt: mailDrafts.createdAt,
      })
      .from(mailDrafts)
      .where(
        and(
          eq(mailDrafts.chatThreadId, args.threadId),
          outlookEnabled ? undefined : eq(mailDrafts.provider, "gmail"),
          inArray(mailDrafts.status, ["draft", "sending", "sent"]),
        ),
      )
      .orderBy(desc(mailDrafts.createdAt), desc(mailDrafts.id));
    signal.throwIfAborted();
    return rows.map((row) => {
      return threadMailSummarySchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
      });
    });
  },
);

function mailDraftRow(
  row: StoredMailDraftRow | undefined,
): MailDraftRow | null {
  if (!row || !row.senderAddress || row.subject === null) {
    return null;
  }
  const status = mailDraftStatusSchema.safeParse(row.status);
  if (!status.success) {
    return null;
  }
  const provider = mailProviderSchema.parse(row.provider);
  const draftId =
    provider === "gmail" ? row.gmailDraftId : row.outlookMessageId;
  const threadId =
    provider === "gmail" ? row.gmailThreadId : row.outlookConversationId;
  const messageId =
    provider === "gmail" ? row.gmailMessageId : row.outlookMessageId;
  if (!draftId || !threadId || !messageId) {
    return null;
  }
  return {
    ...row,
    provider,
    draftId,
    threadId,
    messageId,
    sentMessageId:
      provider === "gmail"
        ? row.sentGmailMessageId
        : status.data === "sent"
          ? messageId
          : null,
    webLink: row.outlookWebLink,
    status: status.data,
    senderAddress: row.senderAddress,
    subject: row.subject,
  };
}

function mailIdentityValues(provider: MailProvider, mail: MailDraftValue) {
  return provider === "gmail"
    ? {
        gmailDraftId: mail.draftId,
        gmailThreadId: mail.threadId,
        gmailMessageId: mail.messageId,
      }
    : {
        outlookMessageId: mail.messageId,
        outlookConversationId: mail.threadId,
        outlookWebLink: mail.webLink ?? null,
      };
}

const requireOutlookChatMail$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.OutlookChatMail, context);
  },
);

const loadLinkedDraft$ = command(
  async (
    { set },
    args: {
      readonly connectorId: string;
      readonly draftId: string;
      readonly provider: MailProvider;
    },
  ): Promise<{ readonly id: string; readonly chatThreadId: string } | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({ id: mailDrafts.id, chatThreadId: mailDrafts.chatThreadId })
      .from(mailDrafts)
      .where(
        and(
          eq(mailDrafts.connectorId, args.connectorId),
          args.provider === "gmail"
            ? eq(mailDrafts.gmailDraftId, args.draftId)
            : eq(mailDrafts.outlookMessageId, args.draftId),
        ),
      )
      .limit(1);
    return row?.chatThreadId
      ? { ...row, chatThreadId: row.chatThreadId }
      : null;
  },
);

const resolveMailAccessToken$ = command(
  async (
    { set },
    args: {
      readonly connection: MailConnection;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<MailAccessTokenResult> => {
    if (args.connection.needsReconnect || !args.connection.scopesReady) {
      return {
        kind: "error",
        message:
          args.connection.connectorSlug === "gmail"
            ? "Reconnect Gmail before continuing"
            : "Reconnect Outlook before continuing",
      };
    }
    const accessTokenValueRef = builtinConnectorCredentialRuntimeValueRef(
      args.connection,
      args.connection.connectorSlug === "gmail"
        ? GMAIL_ACCESS_TOKEN_ENV
        : "OUTLOOK_MAIL_TOKEN",
    );
    if (accessTokenValueRef === null) {
      return {
        kind: "error",
        message:
          args.connection.connectorSlug === "gmail"
            ? "Reconnect Gmail before continuing"
            : "Reconnect Outlook before continuing",
      };
    }
    const values = await set(
      loadBuiltinConnectorCredentialValues$,
      {
        connection: args.connection,
        valueRefs: [accessTokenValueRef],
      },
      signal,
    );
    const expiresAt = args.connection.tokenExpiresAt?.getTime() ?? 0;
    const accessToken = values.get(accessTokenValueRef);
    if (
      accessToken &&
      (expiresAt === 0 ||
        expiresAt > nowDate().getTime() + TOKEN_REFRESH_SKEW_MS)
    ) {
      return { kind: "ok", accessToken };
    }
    const refreshed = await set(
      refreshBuiltinConnectorCredentialAccess$,
      {
        connection: args.connection,
        orgId: args.orgId,
        userId: args.userId,
        runtimeEnvironmentName:
          args.connection.connectorSlug === "gmail"
            ? GMAIL_ACCESS_TOKEN_ENV
            : "OUTLOOK_MAIL_TOKEN",
        persist: {
          defaultExpiresInMs: DEFAULT_ACCESS_TOKEN_EXPIRES_IN_MS,
        },
      },
      signal,
    );
    if (refreshed.kind === "configuration-unavailable") {
      return {
        kind: "error",
        message:
          args.connection.connectorSlug === "gmail"
            ? "Gmail OAuth is not configured"
            : "Outlook OAuth is not configured",
      };
    }
    return refreshed.kind === "ok"
      ? { kind: "ok", accessToken: refreshed.accessToken }
      : {
          kind: "error",
          message:
            args.connection.connectorSlug === "gmail"
              ? "Reconnect Gmail before continuing"
              : "Reconnect Outlook before continuing",
        };
  },
);

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
    return email().safeParse(address).success ? [address] : [];
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
  if (match?.[2] && email().safeParse(match[2]).success) {
    const name = match[1]?.trim().replace(/^"|"$/gu, "");
    return name ? { address: match[2], name } : { address: match[2] };
  }
  if (!email().safeParse(decoded).success) {
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

const htmlAttributesSchema = record(string(), string());

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
  _signal: AbortSignal,
): Promise<zInfer<typeof gmailDraftResourceSchema> | null> {
  const acceptedResponse = await settle(
    accept(
      fetch(
        `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}?format=full`,
        {
          headers: { Authorization: `Bearer ${args.accessToken}` },
        },
      ),
      [200, 404],
    ),
  );
  let response: Response;
  if (acceptedResponse.ok) {
    response = acceptedResponse.value;
  } else if (
    acceptedResponse.error instanceof HttpStatusError &&
    acceptedResponse.error.status >= 300
  ) {
    response = acceptedResponse.error.response;
  } else {
    throw acceptedResponse.error;
  }
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
): Promise<MailDraftValue | null> {
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
  _signal: AbortSignal,
): Promise<
  | {
      readonly kind: "sent";
      readonly messageId: string;
      readonly threadId: string;
    }
  | GmailDraftRejection
  | null
> {
  const acceptedResponse2 = await settle(
    accept(
      fetch(`${GMAIL_API_BASE}/drafts/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: args.gmailDraftId }),
      }),
      [200, 404],
    ),
  );
  let response: Response;
  if (acceptedResponse2.ok) {
    response = acceptedResponse2.value;
  } else if (
    acceptedResponse2.error instanceof HttpStatusError &&
    acceptedResponse2.error.status >= 300
  ) {
    response = acceptedResponse2.error.response;
  } else {
    throw acceptedResponse2.error;
  }
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
  _signal: AbortSignal,
): Promise<zInfer<typeof gmailMessageResourceSchema> | null> {
  const acceptedResponse3 = await settle(
    accept(
      fetch(
        `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}?format=full`,
        {
          headers: { Authorization: `Bearer ${args.accessToken}` },
        },
      ),
      [200, 404],
    ),
  );
  let response: Response;
  if (acceptedResponse3.ok) {
    response = acceptedResponse3.value;
  } else if (
    acceptedResponse3.error instanceof HttpStatusError &&
    acceptedResponse3.error.status >= 300
  ) {
    response = acceptedResponse3.error.response;
  } else {
    throw acceptedResponse3.error;
  }
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
  _signal: AbortSignal,
): Promise<Uint8Array | null> {
  const acceptedResponse4 = await settle(
    accept(
      fetch(
        `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.gmailMessageId)}/attachments/${encodeURIComponent(args.attachmentId)}`,
        {
          headers: { Authorization: `Bearer ${args.accessToken}` },
        },
      ),
      [200, 404],
    ),
  );
  let response: Response;
  if (acceptedResponse4.ok) {
    response = acceptedResponse4.value;
  } else if (
    acceptedResponse4.error instanceof HttpStatusError &&
    acceptedResponse4.error.status >= 300
  ) {
    response = acceptedResponse4.error.response;
  } else {
    throw acceptedResponse4.error;
  }
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
  _signal: AbortSignal,
): Promise<void> {
  const acceptedResponse5 = await settle(
    accept(
      fetch(
        `${GMAIL_API_BASE}/drafts/${encodeURIComponent(args.gmailDraftId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${args.accessToken}` },
        },
      ),
      [204, 404],
    ),
  );
  let response: Response;
  if (acceptedResponse5.ok) {
    response = acceptedResponse5.value;
  } else if (
    acceptedResponse5.error instanceof HttpStatusError &&
    acceptedResponse5.error.status >= 300
  ) {
    response = acceptedResponse5.error.response;
  } else {
    throw acceptedResponse5.error;
  }
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
    provider: args.row.provider,
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
    ...(args.row.provider === "gmail"
      ? {
          gmailDraftId: args.row.draftId,
          gmailThreadId: args.row.threadId,
          gmailMessageId: args.row.messageId,
          sentGmailMessageId: args.row.sentMessageId ?? undefined,
        }
      : {
          outlookMessageId: args.row.messageId,
          outlookConversationId: args.row.threadId,
          outlookWebLink: args.row.webLink ?? undefined,
        }),
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
    sentAt: args.row.sentAt?.toISOString(),
  });
}

const markMailNeedsReconnect$ = command(
  async (
    { set },
    args: {
      readonly connection: MailConnection;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(connectors)
      .set({
        needsReconnect: true,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(connectors.id, args.connection.connectorId));
  },
);

function mailOperationResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
):
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "reconnect" }
  | { readonly kind: "error"; readonly error: unknown } {
  if (result.ok) {
    return { kind: "ok", value: result.value };
  }
  return result.error instanceof GmailAuthorizationError ||
    result.error instanceof OutlookAuthorizationError
    ? { kind: "reconnect" }
    : { kind: "error", error: result.error };
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

const connectionForRow$ = command(
  async (
    { set },
    args: {
      readonly snapshot: ConnectorRuntimeSelection;
      readonly orgId: string;
      readonly userId: string;
      readonly row: MailDraftRow;
    },
  ): Promise<MailConnection | null> => {
    const connections = await set(loadMailConnections$, {
      connectorSlug: args.row.provider === "gmail" ? "gmail" : "outlook-mail",
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
  },
);

const accessForRow$ = command(
  async (
    { set },
    args: {
      readonly snapshot: ConnectorRuntimeSelection;
      readonly orgId: string;
      readonly userId: string;
      readonly row: MailDraftRow;
    },
    signal: AbortSignal,
  ): Promise<MailAccess | MailAccessFailure> => {
    const connection = await set(connectionForRow$, args);
    signal.throwIfAborted();
    if (!connection) {
      return {
        kind: "conflict",
        message:
          args.row.provider === "gmail"
            ? "Reconnect Gmail before continuing"
            : "Reconnect Outlook before continuing",
      };
    }
    const access = await set(
      resolveMailAccessToken$,
      {
        connection,
        orgId: args.orgId,
        userId: args.userId,
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
  },
);

const persistLinkedDraft$ = command(
  async (
    { set },
    args: {
      readonly mail: MailDraftValue;
      readonly provider: MailProvider;
      readonly connection: MailConnection;
      readonly threadId: string;
    },
  ): Promise<
    | { readonly kind: "created"; readonly mailDraftId: string }
    | {
        readonly kind: "existing";
        readonly mailDraftId: string;
        readonly chatThreadId: string;
      }
  > => {
    const db = set(writeDb$);
    const mailDraftId = randomUUID();
    const createdAt = nowDate();
    const [inserted] = await db
      .insert(mailDrafts)
      .values({
        id: mailDraftId,
        chatThreadId: args.threadId,
        connectorId: args.connection.connectorId,
        provider: args.provider,
        ...mailIdentityValues(args.provider, args.mail),
        status: "draft",
        senderName: args.mail.details.fromName ?? null,
        senderAddress: args.mail.details.from,
        subject: args.mail.details.subject,
        createdAt,
        updatedAt: createdAt,
      })
      .onConflictDoNothing({
        target: [
          mailDrafts.connectorId,
          args.provider === "gmail"
            ? mailDrafts.gmailDraftId
            : mailDrafts.outlookMessageId,
        ],
      })
      .returning({ id: mailDrafts.id });
    if (!inserted) {
      const [existing] = await db
        .select({ id: mailDrafts.id, chatThreadId: mailDrafts.chatThreadId })
        .from(mailDrafts)
        .where(
          and(
            eq(mailDrafts.connectorId, args.connection.connectorId),
            args.provider === "gmail"
              ? eq(mailDrafts.gmailDraftId, args.mail.draftId)
              : eq(mailDrafts.outlookMessageId, args.mail.messageId),
          ),
        )
        .limit(1);
      if (!existing?.chatThreadId) {
        throw new Error("Linked mail draft row could not be loaded");
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
  },
);

const markDeleted$ = command(
  async (
    { set },
    args: {
      readonly row: MailDraftRow;
    },
  ): Promise<MailDraftRow> => {
    const db = set(writeDb$);
    const updatedAt = nowDate();
    const [deleted] = await db
      .update(mailDrafts)
      .set({ status: "deleted", updatedAt })
      .where(
        and(eq(mailDrafts.id, args.row.id), eq(mailDrafts.status, "draft")),
      )
      .returning({ id: mailDrafts.id });
    if (deleted) {
      return { ...args.row, status: "deleted", updatedAt };
    }
    // A stale provider miss must not overwrite an overlapping send or its
    // confirmed sent record. Read back the winning business transition.
    const [current] = await db
      .select({
        status: mailDrafts.status,
        sentAt: mailDrafts.sentAt,
        sentGmailMessageId: mailDrafts.sentGmailMessageId,
      })
      .from(mailDrafts)
      .where(eq(mailDrafts.id, args.row.id));
    return {
      ...args.row,
      status: current ? mailDraftStatusSchema.parse(current.status) : "deleted",
      sentAt: current?.sentAt ?? null,
      sentMessageId:
        args.row.provider === "gmail"
          ? (current?.sentGmailMessageId ?? null)
          : args.row.messageId,
    };
  },
);

const updateRowFromDraft$ = command(
  async (
    { set },
    args: {
      readonly row: MailDraftRow;
      readonly mail: MailDraftValue;
    },
  ): Promise<MailDraftRow> => {
    const db = set(writeDb$);
    const updatedAt = nowDate();
    await db
      .update(mailDrafts)
      .set({
        ...mailIdentityValues(args.row.provider, args.mail),
        senderName: args.mail.details.fromName ?? null,
        senderAddress: args.mail.details.from,
        subject: args.mail.details.subject,
        updatedAt,
      })
      .where(eq(mailDrafts.id, args.row.id));
    return {
      ...args.row,
      threadId: args.mail.threadId,
      messageId: args.mail.messageId,
      webLink: args.mail.webLink ?? args.row.webLink,
      senderName: args.mail.details.fromName ?? null,
      senderAddress: args.mail.details.from,
      subject: args.mail.details.subject,
      updatedAt,
    };
  },
);

const loadOutlookDraftDetails$ = command(
  async (
    { set },
    args: { readonly row: MailDraftRow; readonly access: MailAccess },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    const result = mailOperationResult(
      await settle(
        outlookGetMessage(
          {
            accessToken: args.access.accessToken,
            messageId: args.row.messageId,
            fallbackSender: {
              address: args.access.connection.externalEmail,
              name: args.access.connection.externalUsername,
            },
          },
          signal,
        ),
        signal,
      ),
    );
    if (result.kind === "reconnect") {
      await set(markMailNeedsReconnect$, {
        connection: args.access.connection,
      });
      signal.throwIfAborted();
      return reconnectDraftResult(args.row, args.access.connection.connectorId);
    }
    if (result.kind === "error") {
      throw result.error;
    }
    const mail = result.value;
    if (!mail) {
      // A sent copy may not exist yet after 202 Accepted. Never turn that
      // propagation delay into a deleted draft or another send attempt.
      const row =
        args.row.status === "draft"
          ? await set(markDeleted$, { row: args.row })
          : args.row;
      signal.throwIfAborted();
      return okResult(
        row.id,
        responseDraft({ row, details: null, detailAvailable: false }),
      );
    }
    return await set(publishOutlookMessage$, { row: args.row, mail }, signal);
  },
);

const publishOutlookMessage$ = command(
  async (
    { set },
    args: { readonly row: MailDraftRow; readonly mail: OutlookMailValue },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    const updatedAt = nowDate();
    const sentAt =
      !args.mail.isDraft && args.mail.sentAt
        ? new Date(args.mail.sentAt)
        : args.row.sentAt;
    const status = sentAt
      ? "sent"
      : !args.mail.isDraft
        ? "sending"
        : args.row.status;
    const [stored] = await set(writeDb$)
      .update(mailDrafts)
      .set({
        ...mailIdentityValues("outlook", args.mail),
        senderName: args.mail.details.fromName ?? null,
        senderAddress: args.mail.details.from,
        subject: args.mail.details.subject,
        ...(status === "sent" || status === "sending"
          ? {
              status: sql`CASE WHEN ${mailDrafts.status} = 'sent' THEN 'sent' ELSE ${status} END`,
              sentAt: sql`COALESCE(${sql.param(sentAt, mailDrafts.sentAt)}, ${mailDrafts.sentAt})`,
            }
          : {}),
        updatedAt,
      })
      .where(
        and(
          eq(mailDrafts.id, args.row.id),
          inArray(mailDrafts.status, ["draft", "sending", "sent"]),
        ),
      )
      .returning({ status: mailDrafts.status, sentAt: mailDrafts.sentAt });
    signal.throwIfAborted();
    const storedSentAt = stored?.sentAt ?? sentAt;
    const row: MailDraftRow = {
      ...args.row,
      status: stored?.status ?? "deleted",
      draftId: args.mail.draftId,
      messageId: args.mail.messageId,
      threadId: args.mail.threadId,
      sentAt: storedSentAt,
      sentMessageId: storedSentAt ? args.mail.messageId : null,
      webLink: args.mail.webLink ?? args.row.webLink,
      senderName: args.mail.details.fromName ?? null,
      senderAddress: args.mail.details.from,
      subject: args.mail.details.subject,
      updatedAt,
    };
    return okResult(
      row.id,
      responseDraft({ row, details: args.mail.details, detailAvailable: true }),
    );
  },
);

const sendOutlookDraft$ = command(
  async (
    { set },
    args: { readonly row: MailDraftRow; readonly access: MailAccess },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult | GmailDraftRejection> => {
    const current = await set(loadOutlookDraftDetails$, args, signal);
    if (
      current.kind !== "ok" ||
      current.mailDraft.accessStatus === "reconnect" ||
      current.mailDraft.status !== "draft"
    ) {
      return current;
    }
    const [accepted] = await set(writeDb$)
      .update(mailDrafts)
      .set({ status: "sending", updatedAt: nowDate() })
      .where(
        and(eq(mailDrafts.id, args.row.id), eq(mailDrafts.status, "draft")),
      )
      .returning({ id: mailDrafts.id });
    signal.throwIfAborted();
    if (!accepted) {
      return {
        kind: "conflict",
        message: "This mail draft can no longer be sent",
      };
    }
    // The business transition selects one sender. Unknown network/provider
    // outcomes remain sending and can only be reconciled by reading Outlook.
    const result = await settle(
      outlookSendDraft(
        { accessToken: args.access.accessToken, messageId: args.row.messageId },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      const error = result.error;
      if (
        error instanceof OutlookAuthorizationError ||
        (error instanceof OutlookRequestError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408)
      ) {
        await set(writeDb$)
          .update(mailDrafts)
          .set({ status: "draft", updatedAt: nowDate() })
          .where(
            and(
              eq(mailDrafts.id, args.row.id),
              eq(mailDrafts.status, "sending"),
            ),
          );
        signal.throwIfAborted();
        if (error instanceof OutlookAuthorizationError) {
          await set(markMailNeedsReconnect$, {
            connection: args.access.connection,
          });
          signal.throwIfAborted();
          return reconnectDraftResult(
            args.row,
            args.access.connection.connectorId,
          );
        }
        return {
          kind: "rejected",
          message:
            "Outlook rejected this draft. Open it in Outlook and check the recipients, content and account permissions before trying again.",
        };
      }
      return okResult(args.row.id, { ...current.mailDraft, status: "sending" });
    }
    // A 202 is a successful send submission, just as Gmail's 200 is. It does
    // not promise recipient delivery or require waiting for Sent Items.
    const sentAt = nowDate();
    await set(writeDb$)
      .update(mailDrafts)
      .set({ status: "sent", sentAt, updatedAt: sentAt })
      .where(
        and(eq(mailDrafts.id, args.row.id), eq(mailDrafts.status, "sending")),
      );
    signal.throwIfAborted();
    return okResult(args.row.id, {
      ...current.mailDraft,
      status: "sent",
      sentAt: sentAt.toISOString(),
      updatedAt: sentAt.toISOString(),
    });
  },
);

const deleteOutlookDraft$ = command(
  async (
    { set },
    args: { readonly row: MailDraftRow; readonly access: MailAccess },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    // The user may already have sent the draft from Outlook. Its immutable ID
    // now resolves to the sent copy, which deleting a stale draft must preserve.
    const current = await set(loadOutlookDraftDetails$, args, signal);
    if (
      current.kind !== "ok" ||
      current.mailDraft.accessStatus === "reconnect"
    ) {
      return current;
    }
    if (current.mailDraft.status !== "draft") {
      return {
        kind: "conflict",
        message: "Only an active draft can be deleted",
      };
    }
    const [deleted] = await set(writeDb$)
      .update(mailDrafts)
      .set({ status: "deleted", updatedAt: nowDate() })
      .where(
        and(eq(mailDrafts.id, args.row.id), eq(mailDrafts.status, "draft")),
      )
      .returning({ id: mailDrafts.id });
    signal.throwIfAborted();
    if (!deleted) {
      return {
        kind: "conflict",
        message: "Only an active draft can be deleted",
      };
    }
    const result = mailOperationResult(
      await settle(
        outlookDeleteDraft(
          {
            accessToken: args.access.accessToken,
            messageId: args.row.messageId,
          },
          signal,
        ),
        signal,
      ),
    );
    if (result.kind !== "ok") {
      // DELETE is idempotent. Restore the review record on failure; the next
      // provider read distinguishes an existing draft from completed deletion.
      await set(writeDb$)
        .update(mailDrafts)
        .set({ status: "draft", updatedAt: nowDate() })
        .where(
          and(eq(mailDrafts.id, args.row.id), eq(mailDrafts.status, "deleted")),
        );
      signal.throwIfAborted();
      if (result.kind === "reconnect") {
        await set(markMailNeedsReconnect$, {
          connection: args.access.connection,
        });
        signal.throwIfAborted();
        return reconnectDraftResult(
          args.row,
          args.access.connection.connectorId,
        );
      }
      throw result.error;
    }
    return okResult(args.row.id, { ...current.mailDraft, status: "deleted" });
  },
);

const loadMailDraftDetails$ = command(
  async (
    { set },
    args: {
      readonly snapshot: ConnectorRuntimeSelection;
      readonly orgId: string;
      readonly userId: string;
      readonly row: MailDraftRow;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    if (args.row.status === "deleted") {
      return okResult(
        args.row.id,
        responseDraft({ row: args.row, details: null, detailAvailable: false }),
      );
    }
    const access = await set(accessForRow$, args, signal);
    if (args.row.provider === "outlook") {
      return access.kind === "ok"
        ? await set(loadOutlookDraftDetails$, { row: args.row, access }, signal)
        : accessReconnectDraftResult(args.row, access);
    }

    if (args.row.status === "sent") {
      const sentGmailMessageId = args.row.sentMessageId;
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
      const sentResult = mailOperationResult(
        await settle(
          gmailGetMessage(
            {
              accessToken: access.accessToken,
              gmailMessageId: sentGmailMessageId,
              fallbackSender: {
                address: access.connection.externalEmail,
                name: access.connection.externalUsername,
              },
            },
            signal,
          ),
          signal,
        ),
      );
      signal.throwIfAborted();
      if (sentResult.kind === "reconnect") {
        await set(markMailNeedsReconnect$, { connection: access.connection });
        signal.throwIfAborted();
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
    const gmailResult = mailOperationResult(
      await settle(
        gmailGetDraft(
          {
            accessToken: access.accessToken,
            gmailDraftId: args.row.draftId,
            fallbackSender: {
              address: access.connection.externalEmail,
              name: access.connection.externalUsername,
            },
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (gmailResult.kind === "reconnect") {
      await set(markMailNeedsReconnect$, { connection: access.connection });
      signal.throwIfAborted();
      return reconnectDraftResult(args.row, access.connection.connectorId);
    }
    if (gmailResult.kind === "error") {
      throw gmailResult.error;
    }
    const gmail = gmailResult.value;
    if (!gmail) {
      const deleted = await set(markDeleted$, { row: args.row });
      signal.throwIfAborted();
      return okResult(
        args.row.id,
        responseDraft({ row: deleted, details: null, detailAvailable: false }),
      );
    }
    const updatedRow = await set(updateRowFromDraft$, {
      row: args.row,
      mail: gmail,
    });
    signal.throwIfAborted();
    return okResult(
      args.row.id,
      responseDraft({
        row: updatedRow,
        details: gmail.details,
        detailAvailable: true,
      }),
    );
  },
);

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
    if (!args.row.sentMessageId) {
      return null;
    }
    const message = await gmailGetMessageResource(
      {
        accessToken: args.accessToken,
        gmailMessageId: args.row.sentMessageId,
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
      gmailDraftId: args.row.draftId,
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

const sendGmailDraftWithAccess$ = command(
  async (
    { set },
    args: {
      readonly access: MailAccess;
      readonly row: MailDraftRow;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "ok";
        readonly current: MailDraftValue;
        readonly sent: {
          readonly messageId: string;
          readonly threadId: string;
        };
      }
    | { readonly kind: "missing" }
    | { readonly kind: "reconnect" }
    | GmailDraftRejection
  > => {
    const currentResult = mailOperationResult(
      await settle(
        gmailGetDraft(
          {
            accessToken: args.access.accessToken,
            gmailDraftId: args.row.draftId,
            fallbackSender: {
              address: args.access.connection.externalEmail,
              name: args.access.connection.externalUsername,
            },
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (currentResult.kind === "reconnect") {
      await set(markMailNeedsReconnect$, {
        connection: args.access.connection,
      });
      signal.throwIfAborted();
      return currentResult;
    }
    if (currentResult.kind === "error") {
      throw currentResult.error;
    }
    if (!currentResult.value) {
      return { kind: "missing" };
    }
    const sentResult = mailOperationResult(
      await settle(
        gmailSendLinkedDraft(
          {
            accessToken: args.access.accessToken,
            gmailDraftId: args.row.draftId,
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (sentResult.kind === "reconnect") {
      await set(markMailNeedsReconnect$, {
        connection: args.access.connection,
      });
      signal.throwIfAborted();
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
  },
);

const resolveMailLinkConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly agentId?: string;
      readonly provider: MailProvider;
      readonly snapshot: ConnectorRuntimeSelection;
    },
    signal: AbortSignal,
  ): Promise<
    | MailDraftErrorResult
    | { readonly kind: "ok"; readonly connection: MailConnection }
  > => {
    const thread = await set(loadOwnedMailThreadContext$, {
      ...args,
      provider: args.provider,
    });
    signal.throwIfAborted();
    if (!thread || (args.agentId && thread.agentId !== args.agentId)) {
      return { kind: "not_found", message: "Chat thread not found" };
    }
    const connections = (
      await set(loadMailConnections$, {
        connectorSlug: args.provider === "gmail" ? "gmail" : "outlook-mail",
        snapshot: args.snapshot,
        orgId: args.orgId,
        userId: args.userId,
        agentId: thread.agentId,
        sourceId: thread.connectorId ?? undefined,
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
            ? `Connect and authorize ${args.provider === "gmail" ? "Gmail" : "Outlook"} for this agent first`
            : `The agent has more than one ${args.provider === "gmail" ? "Gmail" : "Outlook"} connection`,
      };
    }
    return { kind: "ok", connection };
  },
);

export const linkMailDraft$ = command(
  async (
    { set },
    args: LinkMailDraftInput & {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftLinkMutationResult> => {
    const provider = args.provider ?? "gmail";
    if (
      provider === "outlook" &&
      !(await set(requireOutlookChatMail$, args, signal))
    ) {
      return { kind: "not_found", message: "Outlook chat mail is not enabled" };
    }
    const draftId =
      args.provider === "outlook" ? args.outlookMessageId : args.gmailDraftId;
    const snapshot = await set(loadMailCatalog$, provider);
    signal.throwIfAborted();
    const selection = await set(
      resolveMailLinkConnection$,
      { ...args, provider, snapshot },
      signal,
    );
    if (selection.kind !== "ok") {
      return selection;
    }
    const connection = selection.connection;
    const providerName = provider === "gmail" ? "Gmail" : "Outlook";
    const existing = await set(loadLinkedDraft$, {
      connectorId: connection.connectorId,
      provider,
      draftId,
    });
    signal.throwIfAborted();
    if (existing) {
      return existing.chatThreadId === args.threadId
        ? linkResult(existing.id)
        : {
            kind: "conflict",
            message: `This ${providerName} draft is already linked to another chat`,
          };
    }
    const access = await set(
      resolveMailAccessToken$,
      {
        connection,
        orgId: args.orgId,
        userId: args.userId,
      },
      signal,
    );
    if (access.kind !== "ok") {
      return { kind: "conflict", message: access.message };
    }
    const mailResult = mailOperationResult(
      await settle(
        mailGetProviderDraft(
          {
            provider,
            draftId,
            accessToken: access.accessToken,
            fallbackSender: {
              address: connection.externalEmail,
              name: connection.externalUsername,
            },
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (mailResult.kind === "reconnect") {
      await set(markMailNeedsReconnect$, { connection });
      signal.throwIfAborted();
      return reconnectMailError(provider);
    }
    if (mailResult.kind === "error") {
      throw mailResult.error;
    }
    const mail = mailResult.value;
    if (!mail) {
      return { kind: "not_found", message: `${providerName} draft not found` };
    }
    if ("isDraft" in mail && !mail.isDraft) {
      return {
        kind: "conflict",
        message: "Only an Outlook draft can be linked",
      };
    }
    const persisted = await set(persistLinkedDraft$, {
      mail,
      provider,
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
        message: `This ${providerName} draft is already linked to another chat`,
      };
    }
    return linkResult(persisted.mailDraftId);
  },
);

export const getMailDraft$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    const row = await set(loadOwnedMailDraft$, { ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (
      row.provider === "outlook" &&
      !(await set(requireOutlookChatMail$, args, signal))
    ) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const snapshot = await set(loadMailCatalog$, row.provider);
    signal.throwIfAborted();
    return await set(
      loadMailDraftDetails$,
      {
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
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
      readonly partId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftAttachmentResult> => {
    const row = await set(loadOwnedMailDraft$, { ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (
      row.provider === "outlook" &&
      !(await set(requireOutlookChatMail$, args, signal))
    ) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    const snapshot = await set(loadMailCatalog$, row.provider);
    signal.throwIfAborted();
    const access = await set(
      accessForRow$,
      {
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
    if (row.provider === "outlook") {
      const result = mailOperationResult(
        await settle(
          outlookGetAttachment(
            {
              accessToken: access.accessToken,
              messageId: row.messageId,
              attachmentId: args.partId,
            },
            signal,
          ),
          signal,
        ),
      );
      if (result.kind === "reconnect") {
        await set(markMailNeedsReconnect$, { connection: access.connection });
        signal.throwIfAborted();
        return reconnectMailError(row.provider);
      }
      if (result.kind === "error") {
        throw result.error;
      }
      return result.value
        ? { kind: "ok", ...result.value }
        : { kind: "not_found", message: "Mail draft attachment not found" };
    }
    const sourceResult = mailOperationResult(
      await settle(
        gmailAttachmentSource(
          {
            accessToken: access.accessToken,
            row,
            partId: args.partId,
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (sourceResult.kind === "reconnect") {
      await set(markMailNeedsReconnect$, { connection: access.connection });
      signal.throwIfAborted();
      return reconnectMailError(row.provider);
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
    const contentResult = mailOperationResult(
      await settle(
        gmailAttachmentContent(
          {
            accessToken: access.accessToken,
            messageId: source.messageId,
            part: source.part,
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (contentResult.kind === "reconnect") {
      await set(markMailNeedsReconnect$, { connection: access.connection });
      signal.throwIfAborted();
      return reconnectMailError(row.provider);
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
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult> => {
    const row = await set(loadOwnedMailDraft$, { ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (
      row.provider === "outlook" &&
      !(await set(requireOutlookChatMail$, args, signal))
    ) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.status !== "draft") {
      return {
        kind: "conflict",
        message: "Only an active draft can be deleted",
      };
    }
    const snapshot = await set(loadMailCatalog$, row.provider);
    signal.throwIfAborted();
    const access = await set(
      accessForRow$,
      {
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
    if (row.provider === "outlook") {
      return await set(deleteOutlookDraft$, { row, access }, signal);
    }
    const deletion = mailOperationResult(
      await settle(
        gmailDeleteDraft(
          {
            accessToken: access.accessToken,
            gmailDraftId: row.draftId,
          },
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    if (deletion.kind === "reconnect") {
      await set(markMailNeedsReconnect$, { connection: access.connection });
      signal.throwIfAborted();
      return reconnectMailError(row.provider);
    }
    if (deletion.kind === "error") {
      throw deletion.error;
    }
    const updatedAt = nowDate();
    const [deleted] = await set(writeDb$)
      .update(mailDrafts)
      .set({ status: "deleted", updatedAt })
      .where(and(eq(mailDrafts.id, row.id), eq(mailDrafts.status, "draft")))
      .returning({ id: mailDrafts.id });
    signal.throwIfAborted();
    if (!deleted) {
      return {
        kind: "conflict",
        message: "Only an active draft can be deleted",
      };
    }
    const deletedDraft = responseDraft({
      row: { ...row, status: "deleted", updatedAt },
      details: null,
      detailAvailable: false,
    });
    return okResult(row.id, deletedDraft);
  },
);

export const sendMailDraft$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly mailDraftId: string;
    },
    signal: AbortSignal,
  ): Promise<MailDraftMutationResult | GmailDraftRejection> => {
    const row = await set(loadOwnedMailDraft$, { ...args });
    signal.throwIfAborted();
    if (!row) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (
      row.provider === "outlook" &&
      !(await set(requireOutlookChatMail$, args, signal))
    ) {
      return { kind: "not_found", message: "Mail draft not found" };
    }
    if (row.status !== "draft") {
      return {
        kind: "conflict",
        message: "This mail draft can no longer be sent",
      };
    }
    const snapshot = await set(loadMailCatalog$, row.provider);
    signal.throwIfAborted();
    const access = await set(
      accessForRow$,
      {
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
    if (row.provider === "outlook") {
      return await set(sendOutlookDraft$, { row, access }, signal);
    }
    const gmail = await set(
      sendGmailDraftWithAccess$,
      {
        access,

        row,
      },
      signal,
    );
    signal.throwIfAborted();
    if (gmail.kind === "reconnect") {
      return reconnectMailError(row.provider);
    }
    if (gmail.kind === "rejected") {
      return gmail;
    }
    if (gmail.kind === "missing") {
      const deleted = await set(markDeleted$, { row });
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
      threadId: gmail.sent.threadId,
      messageId: gmail.current.messageId,
      sentMessageId: gmail.sent.messageId,
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
