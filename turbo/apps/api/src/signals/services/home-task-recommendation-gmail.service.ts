import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  readBoundedResponseText,
  safeJsonParse,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../utils";
import { loadAgentConnectorScope } from "./agent-connector-scope.service";
import {
  builtinConnectorCredentialRuntimeValueRef,
  loadBuiltinConnectorCredentialConnection,
  loadBuiltinConnectorCredentialValues,
  refreshBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-runtime.service";
import { resolveConnectorAccount } from "./connector-account-resolution.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import { connectorUrlPermission } from "./connector-url-permission.service";

const GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME = "GMAIL_TOKEN";
const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";
const GMAIL_MESSAGE_LIMIT = 12;
const GMAIL_RESPONSE_MAX_BYTES = 64 * 1024;
const GMAIL_COLLECTION_DEADLINE_MS = 10_000;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const SNIPPET_CHARS = 500;
const HEADER_CHARS = 300;

const gmailMessageListSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
      }),
    )
    .max(100)
    .optional(),
});

const gmailMessageSchema = z.object({
  id: z.string().min(1).max(256),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).max(100).optional(),
  payload: z
    .object({
      headers: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
          }),
        )
        .max(200)
        .optional(),
    })
    .optional(),
});

export interface HomeTaskGmailEvidence {
  readonly ref: string;
  readonly receivedAt: string | null;
  readonly from: string;
  readonly subject: string;
  readonly snippet: string;
  readonly important: boolean;
  readonly unread: boolean;
}

interface HomeTaskGmailScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

function cleanText(value: string | undefined, cap: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

function header(
  message: z.infer<typeof gmailMessageSchema>,
  name: string,
): string {
  const value = message.payload?.headers?.find((candidate) => {
    return candidate.name.toLowerCase() === name.toLowerCase();
  })?.value;
  return cleanText(value, HEADER_CHARS);
}

function receivedAt(value: string | undefined): string | null {
  if (value === undefined || !/^\d{1,16}$/.test(value)) {
    return null;
  }
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function gmailListUrl(): string {
  const url = new URL("/gmail/v1/users/me/messages", GMAIL_API_ORIGIN);
  url.searchParams.set(
    "q",
    "in:inbox newer_than:14d -category:promotions -category:social",
  );
  url.searchParams.set("maxResults", GMAIL_MESSAGE_LIMIT.toString());
  return url.toString();
}

function gmailMessageUrl(messageId: string): string {
  const url = new URL(
    `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
    GMAIL_API_ORIGIN,
  );
  url.searchParams.set("format", "metadata");
  for (const name of ["Subject", "From", "Date"]) {
    url.searchParams.append("metadataHeaders", name);
  }
  return url.toString();
}

async function gmailJson<T>(
  args: {
    readonly accessToken: string;
    readonly schema: z.ZodType<T>;
    readonly url: string;
  },
  signal: AbortSignal,
): Promise<T | null> {
  const response = await fetch(args.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal,
  });
  signal.throwIfAborted();
  if (!response.ok) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    return null;
  }
  const body = await readBoundedResponseText(
    response,
    GMAIL_RESPONSE_MAX_BYTES,
  );
  if (body.kind !== "text") {
    return null;
  }
  const parsed = args.schema.safeParse(safeJsonParse(body.text));
  return parsed.success ? parsed.data : null;
}

function tokenNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  return (
    tokenExpiresAt !== null &&
    tokenExpiresAt.getTime() <= nowDate().getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

async function gmailAccessToken(
  db: Db,
  scope: HomeTaskGmailScope,
  connectorId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  signal.throwIfAborted();
  const loaded = await loadBuiltinConnectorCredentialConnection({
    db,
    snapshot,
    ...scope,
    connectorSlug: "gmail",
    connectorId,
  });
  signal.throwIfAborted();
  if (loaded.kind !== "ok" || loaded.connection.needsReconnect) {
    return null;
  }
  const connection = loaded.connection;
  const valueRef = builtinConnectorCredentialRuntimeValueRef(
    connection,
    GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (valueRef === null) {
    return null;
  }
  const values = await loadBuiltinConnectorCredentialValues({
    connection,
    db,
    valueRefs: [valueRef],
  });
  signal.throwIfAborted();
  const storedToken = values.get(valueRef);
  if (storedToken === undefined) {
    return null;
  }
  if (!tokenNeedsRefresh(connection.tokenExpiresAt)) {
    return storedToken;
  }
  const refreshed = await refreshBuiltinConnectorCredentialAccess(
    {
      connection,
      db,
      orgId: scope.orgId,
      userId: scope.userId,
      runtimeEnvironmentName: GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
      persist: { db, markNeedsReconnectOnFailure: true },
    },
    signal,
  );
  signal.throwIfAborted();
  return refreshed.kind === "ok" ? refreshed.accessToken : null;
}

async function currentlyAuthorized(
  args: {
    readonly db: Db;
    readonly scope: HomeTaskGmailScope;
    readonly url: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const connectorScope = await loadAgentConnectorScope(args.db, args.scope);
  signal.throwIfAborted();
  if (!connectorScope.allowedConnectorSlugs.includes("gmail")) {
    return false;
  }
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  signal.throwIfAborted();
  const decision = await connectorUrlPermission({
    db: args.db,
    snapshot,
    scope: args.scope,
    connectorSlug: "gmail",
    method: "GET",
    url: args.url,
  });
  signal.throwIfAborted();
  return decision.allowed;
}

async function defaultGmailConnectorId(
  db: Db,
  scope: HomeTaskGmailScope,
): Promise<string | null> {
  const resolved = await resolveConnectorAccount(db, {
    orgId: scope.orgId,
    userId: scope.userId,
    request: {
      target: { kind: "builtin", connectorSlug: "gmail" },
      selection: { kind: "default" },
    },
  });
  return resolved.kind === "resolved" ? resolved.account.connectorId : null;
}

async function gmailConnectionIsUsable(
  db: Db,
  scope: HomeTaskGmailScope,
  connectorId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const snapshot = await loadConnectorRuntimeSnapshot(db);
  signal.throwIfAborted();
  const loaded = await loadBuiltinConnectorCredentialConnection({
    db,
    snapshot,
    ...scope,
    connectorSlug: "gmail",
    connectorId,
  });
  signal.throwIfAborted();
  return (
    loaded.kind === "ok" &&
    !loaded.connection.needsReconnect &&
    builtinConnectorCredentialRuntimeValueRef(
      loaded.connection,
      GMAIL_ACCESS_TOKEN_ENVIRONMENT_NAME,
    ) !== null
  );
}

/**
 * Revalidate Gmail-derived cached cards without reading provider content.
 * Revoking the Agent connector, either URL permission, the default account, or
 * the usable connection hides those cards immediately instead of waiting for
 * the recommendation refresh window.
 */
export async function homeTaskGmailCacheAuthorized(
  db: Db,
  scope: HomeTaskGmailScope,
  parentSignal: AbortSignal,
): Promise<boolean> {
  const attempt = await settleIncludingAbort(
    (async () => {
      const signal = AbortSignal.any([
        parentSignal,
        AbortSignal.timeout(GMAIL_COLLECTION_DEADLINE_MS),
      ]);
      if (
        !(await currentlyAuthorized({ db, scope, url: gmailListUrl() }, signal))
      ) {
        return false;
      }
      if (
        !(await currentlyAuthorized(
          { db, scope, url: gmailMessageUrl("permission-probe") },
          signal,
        ))
      ) {
        return false;
      }
      const connectorId = await defaultGmailConnectorId(db, scope);
      signal.throwIfAborted();
      return connectorId === null
        ? false
        : await gmailConnectionIsUsable(db, scope, connectorId, signal);
    })(),
  );
  if (attempt.ok) {
    return attempt.value;
  }
  parentSignal.throwIfAborted();
  return false;
}

/**
 * Read a small Gmail inbox window only when this exact Agent has both the
 * connector and URL-level read permission. Authority and the selected account
 * are rechecked before any collected provider content is released.
 */
async function collectAuthorizedGmailEvidence(
  db: Db,
  scope: HomeTaskGmailScope,
  parentSignal: AbortSignal,
): Promise<readonly HomeTaskGmailEvidence[]> {
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(GMAIL_COLLECTION_DEADLINE_MS),
  ]);
  const listUrl = gmailListUrl();
  if (!(await currentlyAuthorized({ db, scope, url: listUrl }, signal))) {
    return [];
  }
  const connectorId = await defaultGmailConnectorId(db, scope);
  signal.throwIfAborted();
  if (connectorId === null) {
    return [];
  }
  const accessToken = await gmailAccessToken(db, scope, connectorId, signal);
  if (accessToken === null) {
    return [];
  }
  const list = await gmailJson(
    {
      accessToken,
      schema: gmailMessageListSchema,
      url: listUrl,
    },
    signal,
  );
  const messageIds = list?.messages?.map((message) => {
    return message.id;
  });
  if (!messageIds || messageIds.length === 0) {
    return [];
  }
  const firstDetailUrl = gmailMessageUrl(messageIds[0]!);
  if (
    !(await currentlyAuthorized(
      {
        db,
        scope,
        url: firstDetailUrl,
      },
      signal,
    ))
  ) {
    return [];
  }
  const messages = await Promise.all(
    messageIds.map((messageId) => {
      return gmailJson(
        {
          accessToken,
          schema: gmailMessageSchema,
          url: gmailMessageUrl(messageId),
        },
        signal,
      );
    }),
  );
  signal.throwIfAborted();

  const [currentConnectorId, stillAuthorized] = await Promise.all([
    defaultGmailConnectorId(db, scope),
    currentlyAuthorized({ db, scope, url: firstDetailUrl }, signal),
  ]);
  signal.throwIfAborted();
  if (currentConnectorId !== connectorId || !stillAuthorized) {
    return [];
  }

  return messages.flatMap((message, index): HomeTaskGmailEvidence[] => {
    if (message === null) {
      return [];
    }
    const labels = new Set(message.labelIds ?? []);
    const subject = header(message, "Subject");
    const snippet = cleanText(message.snippet, SNIPPET_CHARS);
    if (subject.length === 0 && snippet.length === 0) {
      return [];
    }
    return [
      {
        ref: `g${(index + 1).toString()}`,
        receivedAt: receivedAt(message.internalDate),
        from: header(message, "From"),
        subject,
        snippet,
        important: labels.has("IMPORTANT"),
        unread: labels.has("UNREAD"),
      },
    ];
  });
}

export async function collectHomeTaskGmailEvidence(
  db: Db,
  scope: HomeTaskGmailScope,
  parentSignal: AbortSignal,
): Promise<readonly HomeTaskGmailEvidence[]> {
  const attempt = await settleIncludingAbort(
    collectAuthorizedGmailEvidence(db, scope, parentSignal),
  );
  if (attempt.ok) {
    return attempt.value;
  }
  // Gmail is optional evidence. Its own timeout/provider failure removes only
  // that source; cancellation of the owning page request still propagates.
  parentSignal.throwIfAborted();
  return [];
}
