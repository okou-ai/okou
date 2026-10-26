import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import * as z from "zod";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { and, eq, exists, notExists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export function customConnectorOAuthBindingDeletionPlan(connectionId: string) {
  return {
    from: customConnectorAccountOauthBindings,
    where: eq(
      customConnectorAccountOauthBindings.connectorAccountId,
      connectionId,
    ),
  };
}

export const customConnectorOAuthStartResultSchema = z.object({
  contractValid: z.boolean(),
  accountPresent: z.boolean(),
  oauthStateId: z.string().uuid().nullable(),
});

interface CustomOAuthStart {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly storageVersion: number;
  readonly authMode: "oauth" | "automatic";
  readonly allowSiblings: boolean;
  readonly account: ConnectorAccountMutationIntent;
  readonly state: string;
  readonly agentId: string | undefined;
  readonly redirectUri: string;
  readonly authorizationUrl: string;
  readonly oauthRequestedScopes: string | null;
  readonly codeVerifier: string | null;
  readonly oauthContext: string;
  readonly expiresAt: Date;
}

/** Publish an attempt, never an account or credentials. The callback re-admits it. */
export function customConnectorOAuthStartSql(args: CustomOAuthStart) {
  const qb = new QueryBuilder();
  // Retain the existing definition lock through publication. PostgreSQL rechecks
  // these version/mode predicates if a concurrent definition writer wins first.
  const definitionQuery = qb
    .select({
      id: orgCustomConnectors.id,
      storageVersion: orgCustomConnectors.storageVersion,
    })
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.id, args.connectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(orgCustomConnectors.authMode, args.authMode),
        eq(orgCustomConnectors.storageVersion, args.storageVersion),
      ),
    )
    .for("update")
    .limit(1);
  const definition = qb.$with("oauth_start_definition").as(definitionQuery);
  const contractValid = exists(qb.select().from(definition));
  const accountQuery = qb
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.customConnectorId, args.connectorId),
        args.account.intent === "reconnect"
          ? eq(connectors.id, args.account.connectionId)
          : undefined,
        contractValid,
      ),
    )
    .limit(1);
  const account = qb.$with("oauth_start_account").as(accountQuery);
  const accounts = qb.select().from(account);
  const accountPresent = exists(accounts);
  const admitted =
    args.account.intent === "reconnect"
      ? accountPresent
      : args.allowSiblings
        ? sql`true`
        : notExists(accounts);
  // A start uses this statement's account snapshot. Account deletion/creation
  // during a definition-lock wait is arbitrated again by credential publication.
  // Keep database defaults for the attempt UUID and created_at timestamp.
  return sql`
    WITH oauth_start_definition AS MATERIALIZED (${definitionQuery}),
      oauth_start_account AS MATERIALIZED (${accountQuery}),
      oauth_start_inserted AS (
        INSERT INTO ${connectorOauthStates} (
          state, custom_connector_id, storage_version, auth_method, user_id,
          org_id, agent_id, authorize_agent, redirect_uri, authorization_url,
          oauth_requested_scopes, code_verifier, oauth_context, account_mutation,
          expires_at
        )
        SELECT ${args.state}, ${definition.id}, ${definition.storageVersion}, 'oauth',
          ${args.userId}, ${args.orgId}, ${args.agentId ?? null}::uuid,
          ${args.agentId !== undefined}, ${args.redirectUri}, ${args.authorizationUrl},
          ${args.oauthRequestedScopes ?? null}, ${args.codeVerifier ?? null},
          ${args.oauthContext}, ${JSON.stringify(args.account)}::jsonb,
          ${args.expiresAt.toISOString()}::timestamp
        FROM ${definition} WHERE ${admitted}
        RETURNING id
      )
    SELECT ${contractValid} AS "contractValid", ${accountPresent} AS "accountPresent",
      (SELECT id FROM oauth_start_inserted) AS "oauthStateId"
  `;
}

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
