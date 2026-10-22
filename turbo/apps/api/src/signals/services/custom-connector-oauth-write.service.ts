import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";

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
