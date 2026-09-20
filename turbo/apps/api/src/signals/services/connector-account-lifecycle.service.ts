import { Buffer } from "node:buffer";

import {
  connectorAccountTargetKey,
  type ConnectorAccountConnection,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorReconnectReasonSchema,
  type ConnectorReconnectReason,
} from "@okouai/api-contracts/contracts/connector-schemas";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorAuthMethodHasRequiredScopes } from "@okouai/connectors/connector-auth-method";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { secrets } from "@okouai/db/schema/secret";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "../../lib/db-types";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import { reprojectWorkflowAutomationsForOwner } from "./workflow-automation-account-projection.service";
import { invalidateNotionPendingEventsForConnector } from "./notion-automation-account.service";
import { isConnectorCatalogUnavailableError } from "./connector-catalog-reader.service";
import {
  builtinConnectorCredentialStorageIsCompatible,
  resolveStoredBuiltinConnectorRuntimeMethod,
} from "./builtin-connector-credential-access.service";
import {
  customConnectorAccountAuthMethodIsCompatible,
  customConnectorAccountHasRequiredCredentialMaterial,
  customConnectorAccountStorageIsCompatible,
} from "./custom-connector-credential-access.service";
import {
  builtinConnectorCredentialReconnectReasonWithMethod,
  connectorCredentialStatusForAccess,
  builtinConnectorCredentialStatusWithMethod,
} from "./connector-credential-status.service";
import {
  loadConnectorRuntimeSelection,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSelection,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";

const log = logger("connector-account-lifecycle");

const accessTokenSecret = alias(secrets, "connector_account_access_token");
const refreshTokenSecret = alias(secrets, "connector_account_refresh_token");
const oauthScopesSchema = z.array(z.string());
const cursorSchema = z
  .object({
    createdAt: z.string().datetime(),
    id: z.uuid(),
  })
  .strict();

async function loadCurrentConnectorRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot | null> {
  const result = await settle(loadConnectorRuntimeSnapshot(db));
  if (result.ok) {
    return result.value;
  }
  if (!isConnectorCatalogUnavailableError(result.error)) {
    throw result.error;
  }
  log.warn("Connector catalog unavailable while resolving account lifecycle", {
    error: result.error,
  });
  return null;
}

interface ConnectorAccountCursor {
  readonly createdAt: Date;
  readonly id: string;
}

function accountSelection() {
  return {
    id: connectors.id,
    connectorSlug: connectors.connectorSlug,
    customConnectorId: connectors.customConnectorId,
    displayName: connectors.displayName,
    isDefault: connectors.isDefault,
    authMethod: connectors.authMethod,
    automaticAuthType: connectors.automaticAuthType,
    storageVersion: connectors.storageVersion,
    externalId: connectors.externalId,
    externalUsername: connectors.externalUsername,
    externalEmail: connectors.externalEmail,
    oauthScopes: connectors.oauthScopes,
    oauthGrantedScopes: connectors.oauthGrantedScopes,
    tokenExpiresAt: connectors.tokenExpiresAt,
    needsReconnect: connectors.needsReconnect,
    reconnectReason: connectors.reconnectReason,
    createdAt: connectors.createdAt,
    updatedAt: connectors.updatedAt,
    definitionAuthMode: orgCustomConnectors.authMode,
    definitionMcpTransport: orgCustomConnectors.mcpTransport,
    definitionStorageVersion: orgCustomConnectors.storageVersion,
    providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    accessTokenId: accessTokenSecret.id,
    refreshTokenId: refreshTokenSecret.id,
    automaticOAuthBindingId:
      customConnectorAccountOauthBindings.connectorAccountId,
  };
}

type ConnectorAccountRow = Awaited<
  ReturnType<typeof loadConnectorAccountRows>
>[number];

function targetCondition(target: ConnectorAccountTarget): SQL {
  return target.kind === "builtin"
    ? eq(connectors.connectorSlug, target.connectorSlug)
    : eq(connectors.customConnectorId, target.customConnectorId);
}

function parseReconnectReason(
  value: string | null,
): ConnectorReconnectReason | null {
  if (value === null) {
    return null;
  }
  const parsed = connectorReconnectReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseOauthScopes(value: string | null): string[] | null {
  return value === null ? null : oauthScopesSchema.parse(JSON.parse(value));
}

function encodeCursor(row: ConnectorAccountRow): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): ConnectorAccountCursor | null {
  const parsed = cursorSchema.safeParse(
    safeJsonParse(Buffer.from(raw, "base64url").toString("utf8")),
  );
  return parsed.success
    ? { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id }
    : null;
}

async function loadConnectorAccountRows(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target?: ConnectorAccountTarget;
    readonly connectionId?: string;
    readonly connectionIds?: readonly string[];
    readonly cursor?: ConnectorAccountCursor;
    readonly limit?: number;
    readonly search?: string;
    readonly defaultOnly?: boolean;
  },
) {
  const searchPattern = args.search
    ? `%${args.search
        .replaceAll("\\", String.raw`\\`)
        .replaceAll("%", String.raw`\%`)
        .replaceAll("_", String.raw`\_`)}%`
    : undefined;
  const cursorCondition = args.cursor
    ? or(
        lt(connectors.createdAt, args.cursor.createdAt),
        and(
          eq(connectors.createdAt, args.cursor.createdAt),
          lt(connectors.id, args.cursor.id),
        ),
      )
    : undefined;
  const searchCondition =
    searchPattern === undefined
      ? undefined
      : or(
          ilike(sql`${connectors.id}::text`, searchPattern),
          ilike(connectors.displayName, searchPattern),
          ilike(connectors.externalEmail, searchPattern),
          ilike(connectors.externalUsername, searchPattern),
          ilike(connectors.externalId, searchPattern),
        );
  return await db
    .select(accountSelection())
    .from(connectors)
    .leftJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .leftJoin(
      accessTokenSecret,
      and(
        eq(accessTokenSecret.connectorId, connectors.id),
        eq(accessTokenSecret.name, "access_token"),
      ),
    )
    .leftJoin(
      refreshTokenSecret,
      and(
        eq(refreshTokenSecret.connectorId, connectors.id),
        eq(refreshTokenSecret.name, "refresh_token"),
      ),
    )
    .leftJoin(
      customConnectorAccountOauthBindings,
      and(
        eq(
          customConnectorAccountOauthBindings.connectorAccountId,
          connectors.id,
        ),
        eq(
          customConnectorAccountOauthBindings.customConnectorId,
          orgCustomConnectors.id,
        ),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        args.target ? targetCondition(args.target) : undefined,
        args.connectionId ? eq(connectors.id, args.connectionId) : undefined,
        args.connectionIds
          ? inArray(connectors.id, [...args.connectionIds])
          : undefined,
        args.defaultOnly ? eq(connectors.isDefault, true) : undefined,
        cursorCondition,
        searchCondition,
      ),
    )
    .orderBy(desc(connectors.createdAt), desc(connectors.id))
    .limit(args.limit ?? 2_147_483_647);
}

async function loadConnectorAccountSummaryGroups(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
) {
  const tokenExpired = sql`CASE WHEN ${and(
    isNotNull(connectors.tokenExpiresAt),
    lte(connectors.tokenExpiresAt, sql`clock_timestamp()`),
  )} THEN TRUE ELSE FALSE END`.mapWith(pgBooleanDecoder);
  const hasAccessToken = sql`CASE WHEN ${isNotNull(
    accessTokenSecret.id,
  )} THEN TRUE ELSE FALSE END`.mapWith(pgBooleanDecoder);
  const hasRefreshToken = sql`CASE WHEN ${isNotNull(
    refreshTokenSecret.id,
  )} THEN TRUE ELSE FALSE END`.mapWith(pgBooleanDecoder);
  const hasAutomaticOAuthBinding = sql`CASE WHEN ${isNotNull(
    customConnectorAccountOauthBindings.connectorAccountId,
  )} THEN TRUE ELSE FALSE END`.mapWith(pgBooleanDecoder);
  return await db
    .select({
      connectorSlug: connectors.connectorSlug,
      customConnectorId: connectors.customConnectorId,
      authMethod: connectors.authMethod,
      automaticAuthType: connectors.automaticAuthType,
      storageVersion: connectors.storageVersion,
      needsReconnect: connectors.needsReconnect,
      definitionAuthMode: orgCustomConnectors.authMode,
      definitionMcpTransport: orgCustomConnectors.mcpTransport,
      definitionStorageVersion: orgCustomConnectors.storageVersion,
      providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
      tokenExpired,
      hasAccessToken,
      hasRefreshToken,
      hasAutomaticOAuthBinding,
      accountCount: count(),
    })
    .from(connectors)
    .leftJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .leftJoin(
      accessTokenSecret,
      and(
        eq(accessTokenSecret.connectorId, connectors.id),
        eq(accessTokenSecret.name, "access_token"),
      ),
    )
    .leftJoin(
      refreshTokenSecret,
      and(
        eq(refreshTokenSecret.connectorId, connectors.id),
        eq(refreshTokenSecret.name, "refresh_token"),
      ),
    )
    .leftJoin(
      customConnectorAccountOauthBindings,
      and(
        eq(
          customConnectorAccountOauthBindings.connectorAccountId,
          connectors.id,
        ),
        eq(
          customConnectorAccountOauthBindings.customConnectorId,
          orgCustomConnectors.id,
        ),
      ),
    )
    .where(
      and(eq(connectors.orgId, args.orgId), eq(connectors.userId, args.userId)),
    )
    .groupBy(
      connectors.connectorSlug,
      connectors.customConnectorId,
      connectors.authMethod,
      connectors.automaticAuthType,
      connectors.storageVersion,
      connectors.needsReconnect,
      orgCustomConnectors.authMode,
      orgCustomConnectors.mcpTransport,
      orgCustomConnectors.storageVersion,
      orgCustomConnectorOauthConfigs.providerAdapter,
      tokenExpired,
      hasAccessToken,
      hasRefreshToken,
      hasAutomaticOAuthBinding,
    );
}

async function customTargetIsVisible(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly customConnectorId: string;
  },
): Promise<boolean> {
  const [definition] = await db
    .select({ providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(orgCustomConnectors.id, args.customConnectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
      ),
    )
    .limit(1);
  return (
    definition !== undefined &&
    !isIntegrationManagedCustomConnectorProviderAdapter(
      definition.providerAdapter,
    )
  );
}

function builtinConnection(
  row: ConnectorAccountRow,
  snapshot: ConnectorRuntimeSelection,
  now: Date,
  includeScopeMismatch = false,
): ConnectorAccountConnection | null {
  const parsedSlug = connectorSlugSchema.safeParse(row.connectorSlug);
  if (!parsedSlug.success || !snapshot.connectors.has(parsedSlug.data)) {
    return null;
  }
  const target = {
    kind: "builtin" as const,
    connectorSlug: parsedSlug.data,
  };
  const runtimeMethod = resolveStoredBuiltinConnectorRuntimeMethod({
    snapshot,
    stored: {
      authMethodId: row.authMethod,
      connectorId: row.id,
      connectorSlug: parsedSlug.data,
    },
  });
  const storageCompatible =
    runtimeMethod !== undefined &&
    builtinConnectorCredentialStorageIsCompatible({
      runtimeMethod,
      automaticAuthType: row.automaticAuthType,
      storageVersion: row.storageVersion,
    });
  const credentialStatus = runtimeMethod
    ? builtinConnectorCredentialStatusWithMethod({
        method: runtimeMethod.method,
        automaticAuthType: row.automaticAuthType,
        storedNeedsReconnect: row.needsReconnect,
        tokenExpiresAt: row.tokenExpiresAt,
        now,
      })
    : "reconnect-required";
  const connectionStatus =
    storageCompatible && credentialStatus === "available"
      ? "connected"
      : "reconnect-required";
  return {
    id: row.id,
    target,
    authMethod: row.authMethod,
    displayName: row.displayName,
    isDefault: row.isDefault,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: parseOauthScopes(row.oauthGrantedScopes),
    ...(includeScopeMismatch && runtimeMethod
      ? {
          scopeMismatch: !connectorAuthMethodHasRequiredScopes(
            runtimeMethod.method,
            parseOauthScopes(row.oauthScopes),
          ),
        }
      : {}),
    connectionStatus,
    reconnectReason:
      !runtimeMethod || !storageCompatible
        ? null
        : connectionStatus === "reconnect-required"
          ? (parseReconnectReason(row.reconnectReason) ??
            builtinConnectorCredentialReconnectReasonWithMethod({
              method: runtimeMethod.method,
              automaticAuthType: row.automaticAuthType,
              storedNeedsReconnect: row.needsReconnect,
              tokenExpiresAt: row.tokenExpiresAt,
              now,
            }))
          : null,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function customConnection(
  row: ConnectorAccountRow,
  now: Date,
): ConnectorAccountConnection | null {
  if (
    row.customConnectorId === null ||
    row.definitionAuthMode === null ||
    row.definitionStorageVersion === null ||
    isIntegrationManagedCustomConnectorProviderAdapter(row.providerAdapter)
  ) {
    return null;
  }
  const contractCurrent =
    customConnectorAccountAuthMethodIsCompatible(
      row.definitionAuthMode,
      row.authMethod,
    ) &&
    customConnectorAccountStorageIsCompatible({
      authMethod: row.authMethod,
      mcpTransport: row.definitionMcpTransport,
      storageVersion: row.storageVersion,
      definitionStorageVersion: row.definitionStorageVersion,
    });
  const credentialStatus =
    row.authMethod === "none"
      ? "available"
      : connectorCredentialStatusForAccess({
          storedNeedsReconnect: row.needsReconnect,
          tokenExpiresAt:
            row.authMethod === "oauth" ? row.tokenExpiresAt : null,
          now,
          isRefreshable: row.refreshTokenId !== null,
        });
  const hasRequiredCredentialMaterial =
    customConnectorAccountHasRequiredCredentialMaterial({
      definitionAuthMode: row.definitionAuthMode,
      storedAuthMethod: row.authMethod,
      hasAccessToken: row.accessTokenId !== null,
      hasAutomaticOAuthBinding: row.automaticOAuthBindingId !== null,
    });
  const connectionStatus =
    contractCurrent &&
    credentialStatus === "available" &&
    hasRequiredCredentialMaterial
      ? "connected"
      : "reconnect-required";
  return {
    id: row.id,
    target: {
      kind: "custom",
      customConnectorId: row.customConnectorId,
    },
    authMethod: row.authMethod,
    displayName: row.displayName,
    isDefault: row.isDefault,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: parseOauthScopes(row.oauthScopes),
    connectionStatus,
    reconnectReason:
      connectionStatus === "reconnect-required"
        ? (parseReconnectReason(row.reconnectReason) ??
          (row.tokenExpiresAt &&
          row.tokenExpiresAt.getTime() <= now.getTime() &&
          row.refreshTokenId === null
            ? "credential_expired"
            : null))
        : null,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectConnection(
  row: ConnectorAccountRow,
  snapshot: ConnectorRuntimeSelection | null,
  now: Date,
  includeBuiltinScopeMismatch = false,
): ConnectorAccountConnection | null {
  if (row.connectorSlug !== null) {
    return snapshot
      ? builtinConnection(row, snapshot, now, includeBuiltinScopeMismatch)
      : null;
  }
  return customConnection(row, now);
}

type ConnectorAccountSummaryGroup = Awaited<
  ReturnType<typeof loadConnectorAccountSummaryGroups>
>[number];

function projectSummaryGroup(
  row: ConnectorAccountSummaryGroup,
  snapshot: ConnectorRuntimeSnapshot | null,
  now: Date,
): {
  readonly target: ConnectorAccountTarget;
  readonly needsAttention: boolean;
} | null {
  if (row.connectorSlug !== null) {
    const parsedSlug = connectorSlugSchema.safeParse(row.connectorSlug);
    if (!parsedSlug.success || !snapshot?.connectors.has(parsedSlug.data)) {
      return null;
    }
    const runtimeMethod = resolveStoredBuiltinConnectorRuntimeMethod({
      snapshot,
      stored: {
        authMethodId: row.authMethod,
        connectorId: `summary:${parsedSlug.data}:${row.authMethod}`,
        connectorSlug: parsedSlug.data,
      },
    });
    const storageCompatible =
      runtimeMethod !== undefined &&
      builtinConnectorCredentialStorageIsCompatible({
        runtimeMethod,
        automaticAuthType: row.automaticAuthType,
        storageVersion: row.storageVersion,
      });
    const credentialStatus = runtimeMethod
      ? builtinConnectorCredentialStatusWithMethod({
          method: runtimeMethod.method,
          automaticAuthType: row.automaticAuthType,
          storedNeedsReconnect: row.needsReconnect,
          tokenExpiresAt: row.tokenExpired ? now : null,
          now,
        })
      : "reconnect-required";
    return {
      target: { kind: "builtin", connectorSlug: parsedSlug.data },
      needsAttention:
        !storageCompatible || credentialStatus === "reconnect-required",
    };
  }
  if (
    row.customConnectorId === null ||
    row.definitionAuthMode === null ||
    row.definitionStorageVersion === null ||
    isIntegrationManagedCustomConnectorProviderAdapter(row.providerAdapter)
  ) {
    return null;
  }
  const contractCurrent =
    customConnectorAccountAuthMethodIsCompatible(
      row.definitionAuthMode,
      row.authMethod,
    ) &&
    customConnectorAccountStorageIsCompatible({
      authMethod: row.authMethod,
      mcpTransport: row.definitionMcpTransport,
      storageVersion: row.storageVersion,
      definitionStorageVersion: row.definitionStorageVersion,
    });
  const credentialStatus =
    row.authMethod === "none"
      ? "available"
      : connectorCredentialStatusForAccess({
          storedNeedsReconnect: row.needsReconnect,
          tokenExpiresAt:
            row.authMethod === "oauth" && row.tokenExpired ? now : null,
          now,
          isRefreshable: row.hasRefreshToken,
        });
  const hasRequiredCredentialMaterial =
    customConnectorAccountHasRequiredCredentialMaterial({
      definitionAuthMode: row.definitionAuthMode,
      storedAuthMethod: row.authMethod,
      hasAccessToken: row.hasAccessToken,
      hasAutomaticOAuthBinding: row.hasAutomaticOAuthBinding,
    });
  return {
    target: { kind: "custom", customConnectorId: row.customConnectorId },
    needsAttention:
      !contractCurrent ||
      credentialStatus === "reconnect-required" ||
      !hasRequiredCredentialMaterial,
  };
}

export async function listConnectorAccountSummaries(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<readonly ConnectorAccountSummary[]> {
  const now = nowDate();
  const [groups, defaultRows, snapshot] = await Promise.all([
    loadConnectorAccountSummaryGroups(db, args),
    loadConnectorAccountRows(db, { ...args, defaultOnly: true }),
    loadCurrentConnectorRuntimeSnapshot(db),
  ]);
  const defaultConnections = new Map<string, ConnectorAccountConnection>();
  for (const row of defaultRows) {
    const connection = projectConnection(row, snapshot, now);
    if (connection) {
      defaultConnections.set(
        connectorAccountTargetKey(connection.target),
        connection,
      );
    }
  }
  const summaries = new Map<string, ConnectorAccountSummary>();
  for (const group of groups) {
    const projected = projectSummaryGroup(group, snapshot, now);
    if (!projected) {
      continue;
    }
    const targetKey = connectorAccountTargetKey(projected.target);
    const current = summaries.get(targetKey) ?? {
      target: projected.target,
      accountCount: 0,
      attentionCount: 0,
      defaultConnection: defaultConnections.get(targetKey) ?? null,
    };
    summaries.set(targetKey, {
      ...current,
      accountCount: current.accountCount + group.accountCount,
      attentionCount:
        current.attentionCount +
        (projected.needsAttention ? group.accountCount : 0),
    });
  }
  return [...summaries.values()].sort((left, right) => {
    const leftKey = JSON.stringify(left.target);
    const rightKey = JSON.stringify(right.target);
    return leftKey.localeCompare(rightKey);
  });
}

export async function listConnectorAccountsForTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly cursor?: string;
    readonly limit: number;
    readonly search?: string;
    readonly includeScopeMismatch?: true;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly connections: readonly ConnectorAccountConnection[];
      readonly nextCursor: string | null;
      readonly defaultConnection?: ConnectorAccountConnection | null;
    }
  | { readonly kind: "invalid-cursor" }
  | { readonly kind: "missing" }
> {
  const cursor = args.cursor ? decodeCursor(args.cursor) : undefined;
  if (args.cursor && !cursor) {
    return { kind: "invalid-cursor" };
  }
  const snapshot = await loadCurrentConnectorRuntimeSnapshot(db);
  if (
    args.target.kind === "builtin" &&
    (!snapshot || !snapshot.connectors.has(args.target.connectorSlug))
  ) {
    return { kind: "missing" };
  }
  if (
    args.target.kind === "custom" &&
    !(await customTargetIsVisible(db, {
      orgId: args.orgId,
      customConnectorId: args.target.customConnectorId,
    }))
  ) {
    return { kind: "missing" };
  }
  const rows = await loadConnectorAccountRows(db, {
    ...args,
    cursor: cursor ?? undefined,
    limit: args.limit + 1,
  });
  const now = nowDate();
  const projected = rows.flatMap((row) => {
    const connection = projectConnection(
      row,
      snapshot,
      now,
      args.includeScopeMismatch === true,
    );
    return connection ? [connection] : [];
  });
  const includeDefaultConnection =
    args.includeScopeMismatch === true &&
    args.cursor === undefined &&
    args.search === undefined;
  const defaultRow = includeDefaultConnection
    ? (rows.find((row) => {
        return row.isDefault;
      }) ??
      (
        await loadConnectorAccountRows(db, {
          ...args,
          cursor: undefined,
          limit: 1,
          search: undefined,
          defaultOnly: true,
        })
      )[0])
    : undefined;
  const defaultConnection = defaultRow
    ? projectConnection(defaultRow, snapshot, now, true)
    : null;
  if (
    args.target.kind === "custom" &&
    rows.length > 0 &&
    projected.length === 0
  ) {
    return { kind: "missing" };
  }
  const hasMore = rows.length > args.limit;
  return {
    kind: "ok",
    connections: projected.slice(0, args.limit),
    nextCursor: hasMore ? encodeCursor(rows[args.limit - 1]!) : null,
    ...(includeDefaultConnection ? { defaultConnection } : {}),
  };
}

export async function getConnectorAccount(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
  },
): Promise<ConnectorAccountConnection | null> {
  const [row] = await loadConnectorAccountRows(db, args);
  if (!row) {
    return null;
  }
  const snapshot = await loadCurrentConnectorRuntimeSnapshot(db);
  return projectConnection(row, snapshot, nowDate());
}

async function loadConnectorAccountRuntimeSelection(
  db: ReadonlyDb,
  rows: readonly ConnectorAccountRow[],
): Promise<ConnectorRuntimeSelection | null> {
  const connectorSlugs = rows.flatMap((row) => {
    const slug = connectorSlugSchema.safeParse(row.connectorSlug);
    return slug.success ? [slug.data] : [];
  });
  if (connectorSlugs.length === 0) {
    return null;
  }
  const result = await settle(
    loadConnectorRuntimeSelection(db, {
      requestedConnectorSlugs: connectorSlugs,
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (!isConnectorCatalogUnavailableError(result.error)) {
    throw result.error;
  }
  log.warn("Connector catalog unavailable while resolving account lifecycle", {
    error: result.error,
  });
  return null;
}

export async function listConnectorAccountsByIds(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectionIds: readonly string[];
  },
): Promise<readonly ConnectorAccountConnection[]> {
  const connectionIds = [...new Set(args.connectionIds)];
  if (connectionIds.length === 0) {
    return [];
  }
  const rows = await loadConnectorAccountRows(db, {
    ...args,
    connectionIds,
  });
  const snapshot = await loadConnectorAccountRuntimeSelection(db, rows);
  const now = nowDate();
  return rows.flatMap((row) => {
    const connection = projectConnection(row, snapshot, now);
    return connection ? [connection] : [];
  });
}

async function exactOwnedAccountExists(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.connectionId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
      ),
    )
    .for("update")
    .limit(1);
  return row !== undefined;
}

export async function renameConnectorAccount(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
    readonly displayName: string | null;
  },
): Promise<Date | null> {
  return await db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, args);
    if (
      args.target.kind === "custom" &&
      !(await customTargetIsVisible(tx, {
        orgId: args.orgId,
        customConnectorId: args.target.customConnectorId,
      }))
    ) {
      return null;
    }
    if (!(await exactOwnedAccountExists(tx, args))) {
      return null;
    }
    const [updated] = await tx
      .update(connectors)
      .set({ displayName: args.displayName, updatedAt: sql`clock_timestamp()` })
      .where(eq(connectors.id, args.connectionId))
      .returning({ updatedAt: connectors.updatedAt });
    return updated?.updatedAt ?? null;
  });
}

export async function setDefaultConnectorAccount(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
  },
  signal: AbortSignal,
): Promise<Date | null> {
  return await db.transaction(async (tx) => {
    await lockConnectorAccountTarget(tx, args);
    if (
      args.target.kind === "custom" &&
      !(await customTargetIsVisible(tx, {
        orgId: args.orgId,
        customConnectorId: args.target.customConnectorId,
      }))
    ) {
      return null;
    }
    if (!(await exactOwnedAccountExists(tx, args))) {
      return null;
    }
    await tx
      .update(connectors)
      .set({ isDefault: false, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          targetCondition(args.target),
        ),
      );
    const [updated] = await tx
      .update(connectors)
      .set({ isDefault: true, updatedAt: sql`clock_timestamp()` })
      .where(eq(connectors.id, args.connectionId))
      .returning({ updatedAt: connectors.updatedAt });
    await reprojectWorkflowAutomationsForOwner(tx, args, signal);
    return updated?.updatedAt ?? null;
  });
}

async function oldestConnectorAccountSibling(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly excludedConnectionId: string;
  },
): Promise<{ readonly id: string } | null> {
  const [row] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
        ne(connectors.id, args.excludedConnectionId),
      ),
    )
    .orderBy(asc(connectors.createdAt), asc(connectors.id))
    .for("update")
    .limit(1);
  return row ?? null;
}

export async function connectorAccountDeletionImpact(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
  },
): Promise<{
  readonly explicitSelectionCount: number;
  readonly hasSibling: boolean;
} | null> {
  const [account] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.connectionId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
      ),
    )
    .limit(1);
  if (!account) {
    return null;
  }
  const [[selectionCount], [sibling]] = await Promise.all([
    db
      .select({ value: count() })
      .from(chatThreadConnectorSelections)
      .where(eq(chatThreadConnectorSelections.connectorId, args.connectionId)),
    db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          targetCondition(args.target),
          ne(connectors.id, args.connectionId),
        ),
      )
      .limit(1),
  ]);
  return {
    explicitSelectionCount: selectionCount?.value ?? 0,
    hasSibling: sibling !== undefined,
  };
}

type PreparedConnectorAccountDeletion =
  | { readonly kind: "missing" }
  | {
      readonly kind: "ready";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    };

export async function prepareConnectorAccountDeletion(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
  },
  signal: AbortSignal,
): Promise<PreparedConnectorAccountDeletion> {
  await lockConnectorAccountTarget(db, args);
  const [account] = await db
    .select({ id: connectors.id, isDefault: connectors.isDefault })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.connectionId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
      ),
    )
    .for("update")
    .limit(1);
  if (!account) {
    return { kind: "missing" };
  }

  const sibling = await oldestConnectorAccountSibling(db, {
    ...args,
    excludedConnectionId: args.connectionId,
  });
  const resolvedSelectionCount =
    (
      await db
        .delete(chatThreadConnectorSelections)
        .where(eq(chatThreadConnectorSelections.connectorId, args.connectionId))
    ).rowCount ?? 0;

  let promotedDefaultConnectionId: string | null = null;
  if (account.isDefault && sibling) {
    await db
      .update(connectors)
      .set({ isDefault: false, updatedAt: sql`clock_timestamp()` })
      .where(eq(connectors.id, args.connectionId));
    await db
      .update(connectors)
      .set({ isDefault: true, updatedAt: sql`clock_timestamp()` })
      .where(eq(connectors.id, sibling.id));
    promotedDefaultConnectionId = sibling.id;
  }

  if (
    args.target.kind === "builtin" &&
    args.target.connectorSlug === "notion"
  ) {
    await invalidateNotionPendingEventsForConnector(db, args.connectionId);
  }
  await reprojectWorkflowAutomationsForOwner(db, args, signal);

  return {
    kind: "ready",
    resolvedSelectionCount,
    promotedDefaultConnectionId,
  };
}
