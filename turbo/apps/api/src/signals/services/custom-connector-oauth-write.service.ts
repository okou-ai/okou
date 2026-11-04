import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { variables } from "@okouai/db/schema/variable";
import {
  connectorConnectionMetadataWritePlan,
  connectorConnectionMetadataWriteResult,
  type ConnectorConnectionWriteArgs,
} from "./connector-connection-write.service";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { boolean, object, uuid } from "zod";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import {
  and,
  eq,
  exists,
  getTableColumns,
  notExists,
  SQL,
  sql,
  type Column,
} from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";

export const customConnectorOAuthStartResultSchema = object({
  contractValid: boolean(),
  accountPresent: boolean(),
  oauthStateId: uuid().nullable(),
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

function automaticNoAuthAccountFields(
  values: Readonly<Record<string, unknown>>,
) {
  const columns: Readonly<Record<string, Column>> = getTableColumns(connectors);
  return Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const column = columns[key];
    if (!column) {
      throw new Error("Automatic no-auth write contains an unknown column");
    }
    return [
      {
        key,
        column,
        value: value instanceof SQL ? value : sql.param(value, column),
      },
    ];
  });
}

/** Conditional partial INSERT retains database defaults and column encoders. */
function insertAutomaticNoAuthAccount(
  values: typeof connectors.$inferInsert,
  condition: SQL,
  conflict: SQL,
): SQL {
  const fields = automaticNoAuthAccountFields(values);
  return sql`INSERT INTO ${connectors} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )}) SELECT ${sql.join(
    fields.map(({ value }) => {
      return value;
    }),
    sql`, `,
  )} WHERE ${condition} ${conflict} RETURNING id`;
}

/** The existing definition lock gates both account arbitration and cleanup. */
export function automaticNoAuthPublicationSql(
  args: ConnectorConnectionWriteArgs,
): SQL {
  if (args.target.kind !== "custom" || args.authMethod !== "none") {
    throw new Error("Automatic no-auth publication requires a custom target");
  }
  const query = new QueryBuilder();
  const definition = query
    .select({
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
    })
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.id, args.target.customConnectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
      ),
    )
    .for("update")
    .limit(1)
    .getSQL();
  const admitted = sql`EXISTS (SELECT 1 FROM no_auth_definition
    WHERE auth_mode = 'automatic' AND storage_version = ${args.storageVersion})`;
  const write = connectorConnectionMetadataWritePlan(args);
  const clauses: SQL[] = [];
  if (write.kind === "update") {
    const snapshot = query
      .select({
        id: connectors.id,
        version: sql`${connectors}.xmin::text`.as("row_version"),
      })
      .from(connectors)
      .where(write.where)
      .limit(1)
      .getSQL();
    const update = new PgDialect().buildUpdateQuery({
      table: connectors,
      set: Object.fromEntries(
        automaticNoAuthAccountFields(write.values).map(({ key, value }) => {
          return [key, value];
        }),
      ),
      joins: [],
      where: and(
        write.where,
        admitted,
        sql`${connectors.id} IN (SELECT id FROM no_auth_account_snapshot)`,
        sql`${connectors}.xmin::text = (SELECT row_version FROM no_auth_account_snapshot)`,
      ),
      returning: [{ path: ["id"], field: connectors.id }],
    });
    clauses.push(
      sql`no_auth_account_snapshot AS MATERIALIZED (${snapshot})`,
      sql`no_auth_connection AS (${update})`,
    );
  } else {
    const sibling = connectorConnectionMetadataWriteResult(write, undefined);
    if (
      !write.conflict ||
      sibling.kind !== "write" ||
      sibling.write.kind !== "insert" ||
      sibling.write.phase !== "sibling"
    ) {
      throw new Error("Automatic no-auth add requires default-first siblings");
    }
    const conflict = sql`ON CONFLICT (${sql.join(
      write.conflict.target.map((column) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )}) WHERE ${write.conflict.where} DO NOTHING`;
    clauses.push(
      sql`no_auth_default AS (${insertAutomaticNoAuthAccount(write.values, admitted, conflict)})`,
      sql`no_auth_sibling AS (${insertAutomaticNoAuthAccount(
        sibling.write.values,
        sql`${admitted} AND NOT EXISTS (SELECT 1 FROM no_auth_default)`,
        sql.empty(),
      )})`,
      sql`no_auth_connection AS (
        SELECT id FROM no_auth_default UNION ALL SELECT id FROM no_auth_sibling
      )`,
    );
  }
  const deletions = [
    { table: secrets, parent: secrets.connectorId },
    { table: variables, parent: variables.connectorId },
    {
      table: builtinConnectorAccountOauthBindings,
      parent: builtinConnectorAccountOauthBindings.connectorAccountId,
    },
    {
      table: customConnectorAccountOauthBindings,
      parent: customConnectorAccountOauthBindings.connectorAccountId,
    },
  ];
  let previous: string | undefined;
  for (const [index, deletion] of deletions.entries()) {
    const name = "no_auth_removed_" + index;
    const after = previous
      ? sql`AND (SELECT count(*) FROM ${sql.identifier(previous)}) >= 0`
      : sql.empty();
    clauses.push(sql`${sql.identifier(name)} AS (
      DELETE FROM ${deletion.table}
      WHERE ${deletion.parent} IN (SELECT id FROM no_auth_connection) ${after}
      RETURNING 1
    )`);
    previous = name;
  }
  return sql`WITH no_auth_definition AS (${definition}),
    ${sql.join(clauses, sql`,\n`)}
    SELECT ${admitted} AS contract_current,
      (SELECT id FROM no_auth_connection) AS connection_id`;
}
