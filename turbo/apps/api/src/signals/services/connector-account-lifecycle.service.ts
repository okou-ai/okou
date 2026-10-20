import { Buffer } from "node:buffer";
import { command, computed, type Computed } from "ccstate";

import {
  connectorAccountTargetKey,
  type ConnectorAccountConnection,
  type ConnectorAccountSummary,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorReconnectReasonSchema,
  type ConnectorReconnectReason,
} from "@okouai/api-contracts/contracts/connector-schemas";
import {
  INTEGRATION_MANAGED_CUSTOM_CONNECTOR_PROVIDER_ADAPTERS,
  isIntegrationManagedCustomConnectorProviderAdapter,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorAuthMethodHasRequiredScopes } from "@okouai/connectors/connector-auth-method";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import {
  connectorAccountSetup,
  connectorAccountFieldMarkerKeys,
  connectorAccountSetupMarkerKey,
} from "./connector-account-setup";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "../../lib/db-types";
import {
  pgBooleanDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { safeJsonParse, settle } from "../utils";
import { isUniqueViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { googleFormsAccountProjectionStatement } from "./google-forms-automation-account.service";
import { reprojectWorkflowAutomationsForOwner } from "./workflow-automation-account-projection.service";
import {
  notionPendingEventsReconnectScope,
  notionPendingEventsSkipWrite,
} from "./notion-automation-account.service";
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
  materializeConnectorRuntimeAuthLookup,
  type ConnectorRuntimeAuthLookup,
} from "./connector-catalog-runtime.service";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
  connectorCatalogSlugSourceFromRows,
} from "./connector-catalog-slug-source.service";
import {
  connectorCatalogCompatibilityColumns,
  materializeConnectorCatalogCompatibilityRow,
} from "./connector-catalog-columns";

const accessTokenSecret = alias(secrets, "connector_account_access_token");
const refreshTokenSecret = alias(secrets, "connector_account_refresh_token");
const oauthScopesSchema = z.array(z.string());
// The cursor carries created_at at full microsecond precision. Accounts
// created concurrently commonly share a millisecond, so a JavaScript Date
// boundary would skip rows between the truncated and the real timestamp.
const cursorSchema = z
  .object({
    createdAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z?$/u),
    id: z.uuid(),
  })
  .strict();

interface ConnectorAccountCursor {
  readonly createdAt: string;
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
    createdAtCursor:
      sql`to_char(${connectors.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`.mapWith(
        pgTextDecoder,
      ),
    updatedAt: connectors.updatedAt,
    definitionAuthMode: orgCustomConnectors.authMode,
    definitionMcpTransport: orgCustomConnectors.mcpTransport,
    definitionStorageVersion: orgCustomConnectors.storageVersion,
    definitionFields: orgCustomConnectors.fields,
    providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    accessTokenId: accessTokenSecret.id,
    refreshTokenId: refreshTokenSecret.id,
    automaticOAuthBindingId:
      customConnectorAccountOauthBindings.connectorAccountId,
  };
}

type ConnectorAccountRow = Awaited<
  ReturnType<ReturnType<typeof connectorAccountDetailRows>["read"]>
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
    JSON.stringify({ createdAt: row.createdAtCursor, id: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): ConnectorAccountCursor | null {
  const parsed = cursorSchema.safeParse(
    safeJsonParse(Buffer.from(raw, "base64url").toString("utf8")),
  );
  return parsed.success
    ? { createdAt: parsed.data.createdAt, id: parsed.data.id }
    : null;
}

interface ConnectorAccountBatchScope {
  readonly orgId: string;
  readonly userId: string;
  readonly connectionIds: readonly string[];
}

function fieldMarkerContractSelection() {
  return {
    id: connectors.id,
    authMethod: connectors.authMethod,
    automaticAuthType: connectors.automaticAuthType,
    storageVersion: connectors.storageVersion,
    definitionStorageVersion: orgCustomConnectors.storageVersion,
  };
}

function connectorAccountFieldMarkers(
  scope$: Computed<
    | ConnectorAccountBatchScope
    | null
    | Promise<ConnectorAccountBatchScope | null>
  >,
) {
  return computed(async (get) => {
    const args = await get(scope$);
    if (!args || args.connectionIds.length === 0) {
      return new Map<string, ReadonlySet<string>>();
    }
    const db = get(db$);
    const ids = [...new Set(args.connectionIds)];
    const [secretRows, variableRows] = await Promise.all([
      db
        .select({ ...fieldMarkerContractSelection(), name: secrets.name })
        .from(secrets)
        .innerJoin(connectors, eq(connectors.id, secrets.connectorId))
        .leftJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, connectors.customConnectorId),
            eq(orgCustomConnectors.orgId, connectors.orgId),
          ),
        )
        .where(
          and(
            eq(secrets.orgId, args.orgId),
            eq(secrets.userId, args.userId),
            eq(secrets.type, "connector"),
            inArray(secrets.connectorId, ids),
          ),
        ),
      db
        .select({ ...fieldMarkerContractSelection(), name: variables.name })
        .from(variables)
        .innerJoin(connectors, eq(connectors.id, variables.connectorId))
        .leftJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, connectors.customConnectorId),
            eq(orgCustomConnectors.orgId, connectors.orgId),
          ),
        )
        .where(
          and(
            eq(variables.orgId, args.orgId),
            eq(variables.userId, args.userId),
            eq(variables.type, "connector"),
            inArray(variables.connectorId, ids),
          ),
        ),
    ]);
    return connectorAccountFieldMarkerKeys([
      ...secretRows.map((row) => {
        return { ...row, kind: "secret" as const };
      }),
      ...variableRows.map((row) => {
        return { ...row, kind: "variable" as const };
      }),
    ]);
  });
}

function connectorAccountBatchRows(
  scope$: Computed<
    | ConnectorAccountBatchScope
    | null
    | Promise<ConnectorAccountBatchScope | null>
  >,
) {
  return computed(async (get) => {
    const args = await get(scope$);
    if (!args) {
      return [];
    }
    const connectionIds = [...new Set(args.connectionIds)];
    if (connectionIds.length === 0) {
      return [];
    }
    const db = get(db$);
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
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
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
          inArray(connectors.id, connectionIds),
        ),
      )
      .orderBy(desc(connectors.createdAt), desc(connectors.id))
      .limit(2_147_483_647);
  });
}

function connectorAccountSummaryGroups(
  owner$: Computed<{ readonly orgId: string; readonly userId: string }>,
) {
  return computed(async (get) => {
    const args = get(owner$);
    const db = get(db$);
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
        definitionFields: orgCustomConnectors.fields,
        providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
        tokenExpired,
        hasAccessToken,
        hasRefreshToken,
        hasAutomaticOAuthBinding,
        accountCount: count(),
        accountIds: sql`array_agg(${connectors.id})`.mapWith(
          zodDriverValueDecoder(z.array(z.uuid())),
        ),
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
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
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
        ),
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
        orgCustomConnectors.fields,
        orgCustomConnectorOauthConfigs.providerAdapter,
        tokenExpired,
        hasAccessToken,
        hasRefreshToken,
        hasAutomaticOAuthBinding,
      );
  });
}

function builtinConnection(
  row: ConnectorAccountRow,
  snapshot: ConnectorRuntimeAuthLookup | null,
  now: Date,
  includeScopeMismatch = false,
): ConnectorAccountConnection | null {
  const parsedSlug = connectorSlugSchema.safeParse(row.connectorSlug);
  if (!parsedSlug.success) {
    throw new Error("Stored connector account has an invalid builtin identity");
  }
  if (!snapshot) {
    throw new Error("Builtin connector account metadata is unavailable");
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
  snapshot: ConnectorRuntimeAuthLookup | null,
  now: Date,
  includeBuiltinScopeMismatch = false,
  markers: ReadonlySet<string> = new Set(),
): ConnectorAccountConnection | null {
  const setup = connectorAccountSetup(row, snapshot, markers);
  if (row.connectorSlug !== null) {
    const connection = builtinConnection(
      row,
      snapshot,
      now,
      includeBuiltinScopeMismatch,
    );
    return connection ? { ...connection, ...setup } : null;
  }
  const connection = customConnection(row, now);
  return connection ? { ...connection, ...setup } : null;
}

type ConnectorAccountSummaryGroup = Awaited<
  ReturnType<ReturnType<typeof connectorAccountSummaryGroups>["read"]>
>[number];

function projectSummaryGroup(
  row: ConnectorAccountSummaryGroup,
  snapshot: ConnectorRuntimeAuthLookup | null,
  now: Date,
): {
  readonly target: ConnectorAccountTarget;
  readonly needsAttention: boolean;
} | null {
  if (row.connectorSlug !== null) {
    const parsedSlug = connectorSlugSchema.safeParse(row.connectorSlug);
    if (!parsedSlug.success) {
      throw new Error(
        "Stored connector account has an invalid builtin identity",
      );
    }
    if (!snapshot) {
      throw new Error("Builtin connector account metadata is unavailable");
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

function accountAuthLookupFromCatalogRows(
  rows: readonly {
    readonly current: { readonly schemaVersion: number; readonly hash: string };
    readonly entry:
      Parameters<typeof materializeConnectorCatalogCompatibilityRow>[0] | null;
  }[],
  connectorSlugs: readonly ConnectorSlug[],
): ConnectorRuntimeAuthLookup {
  // Missing runtime metadata must not erase the saved account's identity.
  const source = connectorCatalogSlugSourceFromRows(
    rows.map((row) => {
      return {
        ...row,
        entry:
          row.entry === null
            ? null
            : materializeConnectorCatalogCompatibilityRow(row.entry),
      };
    }),
    connectorSlugs,
  );
  return materializeConnectorRuntimeAuthLookup(source);
}

function connectorAccountAuthLookup(
  rows$: Computed<
    | readonly { readonly connectorSlug: string | null }[]
    | Promise<readonly { readonly connectorSlug: string | null }[]>
  >,
): Computed<Promise<ConnectorRuntimeAuthLookup | null>> {
  return computed(async (get) => {
    const rows = await get(rows$);
    const db = get(db$);
    const connectorSlugs = rows.flatMap((row) => {
      const slug = connectorSlugSchema.safeParse(row.connectorSlug);
      return slug.success ? [slug.data] : [];
    });
    if (connectorSlugs.length === 0) {
      return null;
    }
    const catalogRows = await db
      .select({
        current: {
          schemaVersion: connectorCatalog.schemaVersion,
          hash: connectorCatalog.hash,
        },
        entry: connectorCatalogCompatibilityColumns,
      })
      .from(connectorCatalog)
      .leftJoin(
        connectorCatalogEntries,
        connectorCatalogSlugJoin(connectorSlugs),
      )
      .where(connectorCatalogCurrentWhere());
    return accountAuthLookupFromCatalogRows(catalogRows, connectorSlugs);
  });
}

function setupAttentionCount(
  group: ConnectorAccountSummaryGroup,
  snapshot: ConnectorRuntimeAuthLookup | null,
  markers: ReadonlyMap<string, ReadonlySet<string>>,
) {
  return group.accountIds.filter((id) => {
    const account = { ...group, id };
    return (
      connectorAccountSetup(
        account,
        snapshot,
        markers.get(connectorAccountSetupMarkerKey(account)) ?? new Set(),
      ).setupStatus !== "complete"
    );
  }).length;
}

export function connectorAccountSummaries(
  owner$: Computed<{ readonly orgId: string; readonly userId: string }>,
): Computed<Promise<readonly ConnectorAccountSummary[]>> {
  const groups$ = connectorAccountSummaryGroups(owner$);
  const authLookup$ = connectorAccountAuthLookup(groups$);
  const markerScope$ = computed(async (get) => {
    return {
      ...get(owner$),
      connectionIds: (await get(groups$)).flatMap((group) => {
        return group.accountIds;
      }),
    };
  });
  const markers$ = connectorAccountFieldMarkers(markerScope$);

  return computed(async (get) => {
    const args = get(owner$);
    const db = get(db$);
    const now = nowDate();
    const [groups, defaultRows] = await Promise.all([
      get(groups$),
      db
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
            eq(
              orgCustomConnectorOauthConfigs.connectorId,
              orgCustomConnectors.id,
            ),
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
            eq(connectors.isDefault, true),
          ),
        )
        .orderBy(desc(connectors.createdAt), desc(connectors.id))
        .limit(2_147_483_647),
    ]);
    // Every default account belongs to a group, so the groups name every
    // builtin connector this projection reads.
    const snapshot = await get(authLookup$);
    const markers = await get(markers$);
    const defaultConnections = new Map<string, ConnectorAccountConnection>();
    for (const row of defaultRows) {
      const connection = projectConnection(
        row,
        snapshot,
        now,
        false,
        markers.get(connectorAccountSetupMarkerKey(row)),
      );
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
          (projected.needsAttention
            ? group.accountCount
            : setupAttentionCount(group, snapshot, markers)),
      });
    }
    return [...summaries.values()].sort((left, right) => {
      const leftKey = JSON.stringify(left.target);
      const rightKey = JSON.stringify(right.target);
      return leftKey.localeCompare(rightKey);
    });
  });
}

interface ConnectorAccountListScope {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
  readonly cursor?: string;
  readonly limit: number;
  readonly search?: string;
  readonly includeScopeMismatch?: true;
}

type ConnectorAccountListResult =
  | {
      readonly kind: "ok";
      readonly connections: readonly ConnectorAccountConnection[];
      readonly nextCursor: string | null;
      readonly defaultConnection: ConnectorAccountConnection | null;
    }
  | { readonly kind: "invalid-cursor" }
  | { readonly kind: "missing" };

function connectorAccountTargetRows(
  scope$: Computed<{
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly cursor?: ConnectorAccountCursor;
    readonly limit: number;
    readonly search?: string;
    readonly defaultOnly?: true;
  }>,
) {
  return computed(async (get) => {
    const args = get(scope$);
    const db = get(db$);
    const searchPattern = args.search
      ? `%${args.search
          .replaceAll("\\", String.raw`\\`)
          .replaceAll("%", String.raw`\%`)
          .replaceAll("_", String.raw`\_`)}%`
      : undefined;
    const cursorCondition = args.cursor
      ? or(
          lt(connectors.createdAt, sql`${args.cursor.createdAt}::timestamp`),
          and(
            eq(connectors.createdAt, sql`${args.cursor.createdAt}::timestamp`),
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
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
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
          targetCondition(args.target),
          args.defaultOnly ? eq(connectors.isDefault, true) : undefined,
          cursorCondition,
          searchCondition,
        ),
      )
      .orderBy(desc(connectors.createdAt), desc(connectors.id))
      .limit(args.limit);
  });
}

function connectorAccountCustomTargetIsVisible(
  scope$: Computed<ConnectorAccountListScope>,
) {
  return computed(async (get) => {
    const args = get(scope$);
    if (args.target.kind !== "custom") {
      return true;
    }
    const db = get(db$);
    const [definition] = await db
      .select({
        providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.target.customConnectorId),
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
  });
}

export function connectorAccountsForTarget(
  scope$: Computed<ConnectorAccountListScope>,
): Computed<Promise<ConnectorAccountListResult>> {
  const cursor$ = computed((get) => {
    const args = get(scope$);
    return args.cursor ? decodeCursor(args.cursor) : undefined;
  });
  const authRows$ = computed((get) => {
    const { target } = get(scope$);
    return target.kind === "builtin"
      ? [{ connectorSlug: target.connectorSlug }]
      : [];
  });
  const authLookup$ = connectorAccountAuthLookup(authRows$);
  const customTargetVisible$ = connectorAccountCustomTargetIsVisible(scope$);
  const pageScope$ = computed((get) => {
    const args = get(scope$);
    return {
      ...args,
      cursor: get(cursor$) ?? undefined,
      limit: args.limit + 1,
    };
  });
  const rows$ = connectorAccountTargetRows(pageScope$);
  const defaultScope$ = computed((get) => {
    return {
      ...get(scope$),
      cursor: undefined,
      limit: 1,
      search: undefined,
      defaultOnly: true as const,
    };
  });
  const defaultRows$ = connectorAccountTargetRows(defaultScope$);
  const markerScope$ = computed(async (get) => {
    const args = get(scope$);
    const rows = await get(rows$);
    const defaults = !rows.some((row) => {
      return row.isDefault;
    })
      ? await get(defaultRows$)
      : [];
    return {
      ...args,
      connectionIds: [...rows, ...defaults].map((row) => {
        return row.id;
      }),
    };
  });
  const markers$ = connectorAccountFieldMarkers(markerScope$);

  return computed(async (get): Promise<ConnectorAccountListResult> => {
    const args = get(scope$);
    const cursor = get(cursor$);
    if (args.cursor && !cursor) {
      return { kind: "invalid-cursor" };
    }
    const snapshot = await get(authLookup$);
    if (
      args.target.kind === "builtin" &&
      (!snapshot || !snapshot.connectors.has(args.target.connectorSlug))
    ) {
      return { kind: "missing" };
    }
    if (args.target.kind === "custom" && !(await get(customTargetVisible$))) {
      return { kind: "missing" };
    }
    const rows = await get(rows$);
    const markers = await get(markers$);
    const now = nowDate();
    const projected = rows.flatMap((row) => {
      const connection = projectConnection(
        row,
        snapshot,
        now,
        args.includeScopeMismatch === true,
        markers.get(connectorAccountSetupMarkerKey(row)),
      );
      return connection ? [connection] : [];
    });
    const defaultRow =
      rows.find((row) => {
        return row.isDefault;
      }) ?? (await get(defaultRows$))[0];
    const defaultConnection = defaultRow
      ? projectConnection(
          defaultRow,
          snapshot,
          now,
          args.includeScopeMismatch === true,
          markers.get(connectorAccountSetupMarkerKey(defaultRow)),
        )
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
      defaultConnection,
    };
  });
}

interface ConnectorAccountScope {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
  readonly connectionId: string;
}

function connectorAccountDetailRows(
  scope$: Computed<
    ConnectorAccountScope | null | Promise<ConnectorAccountScope | null>
  >,
) {
  return computed(async (get) => {
    const args = await get(scope$);
    if (!args) {
      return [];
    }
    const db = get(db$);
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
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
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
          targetCondition(args.target),
          eq(connectors.id, args.connectionId),
        ),
      )
      .orderBy(desc(connectors.createdAt), desc(connectors.id))
      .limit(2_147_483_647);
  });
}

export function connectorAccount(
  scope$: Computed<
    ConnectorAccountScope | null | Promise<ConnectorAccountScope | null>
  >,
): Computed<Promise<ConnectorAccountConnection | null>> {
  const rows$ = connectorAccountDetailRows(scope$);
  const authRows$ = computed(async (get) => {
    const [row] = await get(rows$);
    return row ? [row] : [];
  });
  const authLookup$ = connectorAccountAuthLookup(authRows$);
  const markerScope$ = computed(async (get) => {
    const args = await get(scope$);
    return args ? { ...args, connectionIds: [args.connectionId] } : null;
  });
  const markers$ = connectorAccountFieldMarkers(markerScope$);
  return computed(async (get) => {
    const [row] = await get(rows$);
    if (!row) {
      return null;
    }
    const snapshot = await get(authLookup$);
    return projectConnection(
      row,
      snapshot,
      nowDate(),
      false,
      (await get(markers$)).get(connectorAccountSetupMarkerKey(row)),
    );
  });
}

export function connectorAccountsByIds(
  scope$: Computed<
    | ConnectorAccountBatchScope
    | null
    | Promise<ConnectorAccountBatchScope | null>
  >,
): Computed<Promise<readonly ConnectorAccountConnection[]>> {
  const rows$ = connectorAccountBatchRows(scope$);
  const authLookup$ = connectorAccountAuthLookup(rows$);
  const markers$ = connectorAccountFieldMarkers(scope$);
  return computed(async (get) => {
    const args = await get(scope$);
    if (!args || args.connectionIds.length === 0) {
      return [];
    }
    const rows = await get(rows$);
    const snapshot = await get(authLookup$);
    const now = nowDate();
    const markers = await get(markers$);
    return rows.flatMap((row) => {
      const connection = projectConnection(
        row,
        snapshot,
        now,
        false,
        markers.get(connectorAccountSetupMarkerKey(row)),
      );
      return connection ? [connection] : [];
    });
  });
}

const readConnectorAccountSetupMarkers$ = command(
  async ({ get }, args: ConnectorAccountBatchScope) => {
    const db = get(db$);
    const connectionIds = [...new Set(args.connectionIds)];
    const [secretRows, variableRows] = await Promise.all([
      db
        .select({ ...fieldMarkerContractSelection(), name: secrets.name })
        .from(secrets)
        .innerJoin(connectors, eq(connectors.id, secrets.connectorId))
        .leftJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, connectors.customConnectorId),
            eq(orgCustomConnectors.orgId, connectors.orgId),
          ),
        )
        .where(
          and(
            eq(secrets.orgId, args.orgId),
            eq(secrets.userId, args.userId),
            eq(secrets.type, "connector"),
            inArray(secrets.connectorId, connectionIds),
          ),
        ),
      db
        .select({ ...fieldMarkerContractSelection(), name: variables.name })
        .from(variables)
        .innerJoin(connectors, eq(connectors.id, variables.connectorId))
        .leftJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, connectors.customConnectorId),
            eq(orgCustomConnectors.orgId, connectors.orgId),
          ),
        )
        .where(
          and(
            eq(variables.orgId, args.orgId),
            eq(variables.userId, args.userId),
            eq(variables.type, "connector"),
            inArray(variables.connectorId, connectionIds),
          ),
        ),
    ]);
    return connectorAccountFieldMarkerKeys([
      ...secretRows.map((row) => {
        return { ...row, kind: "secret" as const };
      }),
      ...variableRows.map((row) => {
        return { ...row, kind: "variable" as const };
      }),
    ]);
  },
);

export const readConnectorAccountsByIds$ = command(
  async (
    { get, set },
    args: ConnectorAccountBatchScope,
    signal: AbortSignal,
  ): Promise<readonly ConnectorAccountConnection[]> => {
    // Keep the legacy batch's row/catalog projection and clock before its
    // caller-owned cancellation boundary; no step here mutates account state.
    const connections = await (async () => {
      const connectionIds = [...new Set(args.connectionIds)];
      if (connectionIds.length === 0) {
        return [];
      }
      const db = get(db$);
      const rows = await db
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
            eq(
              orgCustomConnectorOauthConfigs.connectorId,
              orgCustomConnectors.id,
            ),
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
            inArray(connectors.id, connectionIds),
          ),
        )
        .orderBy(desc(connectors.createdAt), desc(connectors.id))
        .limit(2_147_483_647);
      const snapshot =
        await (async (): Promise<ConnectorRuntimeAuthLookup | null> => {
          const connectorSlugs = rows.flatMap((row) => {
            const slug = connectorSlugSchema.safeParse(row.connectorSlug);
            return slug.success ? [slug.data] : [];
          });
          if (connectorSlugs.length === 0) {
            return null;
          }
          const catalogRows = await db
            .select({
              current: {
                schemaVersion: connectorCatalog.schemaVersion,
                hash: connectorCatalog.hash,
              },
              entry: connectorCatalogCompatibilityColumns,
            })
            .from(connectorCatalog)
            .leftJoin(
              connectorCatalogEntries,
              connectorCatalogSlugJoin(connectorSlugs),
            )
            .where(connectorCatalogCurrentWhere());
          return accountAuthLookupFromCatalogRows(catalogRows, connectorSlugs);
        })();
      const markers = await set(readConnectorAccountSetupMarkers$, args);
      const now = nowDate();
      return rows.flatMap((row) => {
        const connection = projectConnection(
          row,
          snapshot,
          now,
          false,
          markers.get(connectorAccountSetupMarkerKey(row)),
        );
        return connection ? [connection] : [];
      });
    })();
    signal.throwIfAborted();
    return connections;
  },
);

export const renameConnectorAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
      readonly displayName: string | null;
    },
  ): Promise<Date | null> => {
    const db = set(writeDb$);
    const eligibleDefinition =
      args.target.kind === "custom"
        ? exists(
            db
              .select({ id: orgCustomConnectors.id })
              .from(orgCustomConnectors)
              .leftJoin(
                orgCustomConnectorOauthConfigs,
                and(
                  eq(
                    orgCustomConnectorOauthConfigs.connectorId,
                    orgCustomConnectors.id,
                  ),
                  eq(
                    orgCustomConnectorOauthConfigs.orgId,
                    orgCustomConnectors.orgId,
                  ),
                ),
              )
              .where(
                and(
                  eq(orgCustomConnectors.id, args.target.customConnectorId),
                  eq(orgCustomConnectors.orgId, args.orgId),
                  or(
                    isNull(orgCustomConnectorOauthConfigs.providerAdapter),
                    notInArray(orgCustomConnectorOauthConfigs.providerAdapter, [
                      ...INTEGRATION_MANAGED_CUSTOM_CONNECTOR_PROVIDER_ADAPTERS,
                    ]),
                  ),
                ),
              ),
          )
        : undefined;
    const [updated] = await db
      .update(connectors)
      .set({
        displayName: args.displayName,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(connectors.id, args.connectionId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          targetCondition(args.target),
          eligibleDefinition,
        ),
      )
      .returning({ updatedAt: connectors.updatedAt });
    return updated?.updatedAt ?? null;
  },
);

function connectorAccountOwnerCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
}): SQL {
  return and(
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    targetCondition(args.target),
  ) as SQL;
}

/** Rolls back a default change whose target no longer exists. */
class DefaultConnectorAccountMissing extends Error {}

function clearOtherDefaultsSql(
  owner: ReturnType<typeof connectorAccountOwnerCondition>,
  connectionId: string,
) {
  return and(
    owner,
    eq(connectors.isDefault, true),
    ne(connectors.id, connectionId),
  );
}

/** Known default-account races roll back; other database failures propagate. */
export function isConnectorAccountDefaultConflict(error: unknown): boolean {
  return (
    isUniqueViolation(error, "idx_connectors_org_user_slug_default") ||
    isUniqueViolation(
      error,
      "idx_connectors_org_user_custom_connector_default",
    ) ||
    safeSqlStateCode(error) === "40P01"
  );
}

async function settleDefaultChange(
  change: Promise<Date>,
): Promise<Date | "conflict" | null> {
  const settled = await settle(change);
  if (settled.ok) {
    return settled.value;
  }
  if (settled.error instanceof DefaultConnectorAccountMissing) {
    return null;
  }
  if (isConnectorAccountDefaultConflict(settled.error)) {
    return "conflict";
  }
  throw settled.error;
}

/** Keep the default transition and Forms projection atomic on missing/racing targets. */
export const setDefaultGoogleFormsAccount$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<Date | "conflict" | null> => {
    const db = set(writeDb$);
    return await settleDefaultChange(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0111; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        const owner = connectorAccountOwnerCondition({
          orgId: args.orgId,
          userId: args.userId,
          target: { kind: "builtin", connectorSlug: "google-forms" },
        });
        await tx
          .update(connectors)
          .set({ isDefault: false, updatedAt: sql`clock_timestamp()` })
          .where(clearOtherDefaultsSql(owner, args.connectionId));
        const [updated] = await tx
          .update(connectors)
          .set({ isDefault: true, updatedAt: sql`clock_timestamp()` })
          .where(and(owner, eq(connectors.id, args.connectionId)))
          .returning({ updatedAt: connectors.updatedAt });
        if (!updated) {
          throw new DefaultConnectorAccountMissing();
        }
        const updatedAt = updated.updatedAt;
        await tx.execute(googleFormsAccountProjectionStatement(args));
        signal.throwIfAborted();
        return updatedAt;
      }),
    );
  },
);

/** Clear/select defaults together so missing targets and index conflicts roll back. */
export const setDefaultConnectorAccount$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly userId: string;
      readonly target: ConnectorAccountTarget;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<Date | "conflict" | null> => {
    const target: ConnectorAccountTarget =
      input.target.kind === "builtin"
        ? { kind: "builtin", connectorSlug: input.target.connectorSlug }
        : { kind: "custom", customConnectorId: input.target.customConnectorId };
    const args = {
      orgId: input.orgId,
      userId: input.userId,
      connectionId: input.connectionId,
      target,
    };
    const db = set(writeDb$);
    return await settleDefaultChange(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0112; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        if (args.target.kind === "custom") {
          const [definition] = await tx
            .select({
              providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
            })
            .from(orgCustomConnectors)
            .leftJoin(
              orgCustomConnectorOauthConfigs,
              and(
                eq(
                  orgCustomConnectorOauthConfigs.connectorId,
                  orgCustomConnectors.id,
                ),
                eq(
                  orgCustomConnectorOauthConfigs.orgId,
                  orgCustomConnectors.orgId,
                ),
              ),
            )
            .where(
              and(
                eq(orgCustomConnectors.id, args.target.customConnectorId),
                eq(orgCustomConnectors.orgId, args.orgId),
              ),
            )
            .limit(1);
          if (
            !definition ||
            isIntegrationManagedCustomConnectorProviderAdapter(
              definition.providerAdapter,
            )
          ) {
            throw new DefaultConnectorAccountMissing();
          }
        }
        const owner = connectorAccountOwnerCondition(args);
        await tx
          .update(connectors)
          .set({ isDefault: false, updatedAt: sql`clock_timestamp()` })
          .where(clearOtherDefaultsSql(owner, args.connectionId));
        const [updated] = await tx
          .update(connectors)
          .set({ isDefault: true, updatedAt: sql`clock_timestamp()` })
          .where(and(owner, eq(connectors.id, args.connectionId)))
          .returning({ updatedAt: connectors.updatedAt });
        if (!updated) {
          throw new DefaultConnectorAccountMissing();
        }
        const updatedAt = updated.updatedAt;
        await reprojectWorkflowAutomationsForOwner(tx, args, signal);
        return updatedAt;
      }),
    );
  },
);

export function connectorAccountDeletionImpact(
  scope$: Computed<ConnectorAccountScope>,
) {
  return computed(
    async (
      get,
    ): Promise<{
      readonly explicitSelectionCount: number;
      readonly hasSibling: boolean;
    } | null> => {
      const args = get(scope$);
      const db = get(db$);
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
          .where(
            eq(chatThreadConnectorSelections.connectorId, args.connectionId),
          ),
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
    },
  );
}

type PreparedConnectorAccountDeletion =
  | { readonly kind: "missing" }
  | {
      readonly kind: "ready";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    };

/** Plain reads and writes; a concurrent change resolves as last writer wins. */
export async function prepareConnectorAccountDeletionWithTargetLocked(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly connectionId: string;
  },
  signal: AbortSignal,
): Promise<PreparedConnectorAccountDeletion> {
  const owner = connectorAccountOwnerCondition(args);
  const [account] = await db
    .select({ isDefault: connectors.isDefault })
    .from(connectors)
    .where(and(owner, eq(connectors.id, args.connectionId)))
    .limit(1);
  if (!account) {
    return { kind: "missing" };
  }
  let promotedDefaultConnectionId: string | null = null;
  if (account.isDefault) {
    const [sibling] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(owner, ne(connectors.id, args.connectionId)))
      .orderBy(asc(connectors.createdAt), asc(connectors.id))
      .limit(1);
    if (sibling) {
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
  }

  const resolvedSelectionCount =
    (
      await db
        .delete(chatThreadConnectorSelections)
        .where(eq(chatThreadConnectorSelections.connectorId, args.connectionId))
    ).rowCount ?? 0;

  if (
    args.target.kind === "builtin" &&
    args.target.connectorSlug === "notion"
  ) {
    const pendingEventDb = db;
    const invalidatedConnectorId = args.connectionId;
    await (async () => {
      const scope = notionPendingEventsReconnectScope(invalidatedConnectorId);
      await (async () => {
        const write = notionPendingEventsSkipWrite(
          scope.condition,
          scope.reason,
        );
        await pendingEventDb
          .update(write.table)
          .set(write.values)
          .where(write.where);
      })();
    })();
  }
  await reprojectWorkflowAutomationsForOwner(db, args, signal);

  return {
    kind: "ready",
    resolvedSelectionCount,
    promotedDefaultConnectionId,
  };
}
