import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { and, asc, eq, exists, or, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export function customConnectorOAuthStartFromRow(
  oauthState: { readonly id: string } | undefined,
  account: ConnectorAccountMutationIntent,
  expiresAt: Date,
) {
  if (!oauthState) {
    throw new Error("Failed to create connector OAuth state");
  }
  return {
    kind: "ready" as const,
    oauthAttemptId: oauthState.id,
    connectionId: account.intent === "add" ? oauthState.id : null,
    expiresAt,
  };
}

export interface CustomConnectorOAuthConnectionReadIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly customConnectorId: string;
  readonly memberConnectorId: string;
  readonly storageVersion: number;
  readonly definitionAuthMode: "oauth" | "automatic";
}

export function customConnectorOAuthConnectionReadPlan(
  args: CustomConnectorOAuthConnectionReadIdentity,
) {
  return {
    columns: {
      id: connectors.id,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
      oauthScopes: connectors.oauthScopes,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
    },
    condition: and(
      eq(connectors.id, args.memberConnectorId),
      eq(connectors.customConnectorId, args.customConnectorId),
      eq(connectors.orgId, args.orgId),
      eq(connectors.userId, args.userId),
      eq(connectors.authMethod, "oauth"),
      eq(connectors.storageVersion, args.storageVersion),
      exists(
        new QueryBuilder()
          .select({ id: orgCustomConnectors.id })
          .from(orgCustomConnectors)
          .where(
            and(
              eq(orgCustomConnectors.id, args.customConnectorId),
              eq(orgCustomConnectors.orgId, args.orgId),
              eq(orgCustomConnectors.authMode, args.definitionAuthMode),
              eq(orgCustomConnectors.storageVersion, args.storageVersion),
            ),
          ),
      ),
    ),
  };
}

export function customConnectorOAuthConnectionTokenReadPlan(
  args: CustomConnectorOAuthConnectionReadIdentity,
  connectionId: string,
) {
  return {
    columns: {
      secretName: secrets.name,
      encryptedValue: secrets.encryptedValue,
    },
    accountJoin: eq(connectors.id, secrets.connectorId),
    definitionJoin: and(
      eq(orgCustomConnectors.id, connectors.customConnectorId),
      eq(orgCustomConnectors.orgId, connectors.orgId),
      eq(orgCustomConnectors.authMode, args.definitionAuthMode),
      eq(orgCustomConnectors.storageVersion, args.storageVersion),
    ),
    condition: and(
      eq(connectors.id, connectionId),
      eq(connectors.customConnectorId, args.customConnectorId),
      eq(connectors.orgId, args.orgId),
      eq(connectors.userId, args.userId),
      eq(connectors.authMethod, "oauth"),
      eq(connectors.storageVersion, args.storageVersion),
    ),
  };
}

interface ConnectorIdentity {
  readonly connectorId: string;
  readonly orgId: string;
}

/**
 * Include old and new identities when moving a config. The caller executes
 * these locks before config writes; a newly inserted parent is protected by
 * its insert and the ordinary PK/FK checks.
 */
export function customConnectorOAuthStateLockReadPlan(
  connectors: readonly [ConnectorIdentity, ...ConnectorIdentity[]],
) {
  const affected = or(
    ...connectors.map(({ connectorId, orgId }) => {
      return and(
        eq(orgCustomConnectors.id, connectorId),
        eq(orgCustomConnectors.orgId, orgId),
      );
    }),
  );
  return {
    columns: { id: orgCustomConnectors.id },
    condition: affected,
    orderBy: [asc(orgCustomConnectors.id), asc(orgCustomConnectors.orgId)],
  };
}

/** Read after all writes, including valid intermediate mode/config states. */
export function customConnectorOAuthStateValidationReadPlan(
  condition: SQL | undefined,
) {
  return {
    columns: {
      authMode: orgCustomConnectors.authMode,
      configConnectorId: orgCustomConnectorOauthConfigs.connectorId,
    },
    join: and(
      eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
      eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
    ),
    condition,
  };
}

export function assertCustomConnectorOAuthStateRows(
  states: readonly {
    readonly authMode: typeof orgCustomConnectors.$inferSelect.authMode;
    readonly configConnectorId: string | null;
  }[],
): void {
  for (const state of states) {
    // The config primary key guarantees at most one row; its composite FK
    // guarantees organization ownership and cascades when a parent is deleted.
    if ((state.authMode === "oauth") !== (state.configConnectorId !== null)) {
      throw new Error("custom connector OAuth mode and config do not match");
    }
  }
}

/**
 * Refresh publication decides by the refresh token it consumed: any reconnect
 * or concurrent refresh replaces that secret row (KMS ciphertext is never
 * reused), so a stale result or failure cannot overwrite the newer credential.
 */
export function storedRefreshTokenCondition(
  connectorId: string,
  encryptedRefreshToken: string | null,
  refreshTokenSecretName: string,
) {
  const refreshRow = and(
    eq(secrets.connectorId, connectorId),
    eq(secrets.name, refreshTokenSecretName),
  );
  const observed = sql`EXISTS (SELECT 1 FROM ${secrets} WHERE ${refreshRow}`;
  return encryptedRefreshToken === null
    ? sql`NOT ${observed})`
    : sql`${observed} AND ${secrets.encryptedValue} = ${encryptedRefreshToken})`;
}

export function customConnectorRefreshReconnectCondition(
  connectorId: string,
  observedEncryptedRefreshToken: string | null | undefined,
  refreshTokenSecretName: string,
) {
  return and(
    eq(connectors.id, connectorId),
    observedEncryptedRefreshToken === undefined
      ? undefined
      : storedRefreshTokenCondition(
          connectorId,
          observedEncryptedRefreshToken,
          refreshTokenSecretName,
        ),
  );
}
