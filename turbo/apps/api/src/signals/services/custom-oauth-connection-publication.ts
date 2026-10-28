import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import {
  and,
  count,
  eq,
  exists,
  getTableColumns,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import {
  tokenConnectionMetadataClauses,
  tokenPublicationFields,
  type TokenConnectionMetadataPublication,
} from "./builtin-token-connection-metadata";
import { tokenConnectionWalletClauses } from "./connector-publication-wallet";
import { completedGetStartedQuestPublication } from "./get-started-member-reward";

interface CustomOAuthPublication {
  readonly orgId: string;
  readonly connectorId: string;
  readonly storageVersion: number;
  readonly authMode: "oauth" | "automatic";
  readonly providerAdapter:
    | (typeof orgCustomConnectorOauthConfigs.$inferSelect)["providerAdapter"]
    | null;
  readonly account: TokenConnectionMetadataPublication | null;
  readonly tokens: readonly (typeof secrets.$inferInsert)[];
  readonly binding: Omit<
    typeof customConnectorAccountOauthBindings.$inferInsert,
    "connectorAccountId"
  > | null;
  readonly quest: Parameters<typeof completedGetStartedQuestPublication>[0];
}

function customOAuthDefinition(args: CustomOAuthPublication) {
  const query = new QueryBuilder();
  // Retain the original definition lock and its post-wait version/mode checks.
  // The joined provider adapter must also match the prepared account policy.
  const read = query
    .select({ id: orgCustomConnectors.id })
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
        eq(orgCustomConnectors.id, args.connectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
        eq(orgCustomConnectors.storageVersion, args.storageVersion),
        eq(orgCustomConnectors.authMode, args.authMode),
        args.providerAdapter === null
          ? isNull(orgCustomConnectorOauthConfigs.providerAdapter)
          : eq(
              orgCustomConnectorOauthConfigs.providerAdapter,
              args.providerAdapter,
            ),
        sql`(SELECT ${count()} FROM token_wallet_entitlement) >= 0`,
      ),
    )
    .for("update", { of: orgCustomConnectors })
    .limit(1);
  return sql`custom_oauth_definition AS MATERIALIZED (${read})`;
}

const definitionCurrent = exists(sql`(SELECT 1 FROM custom_oauth_definition)`);
const accountPresent = exists(sql`(SELECT 1 FROM token_connection)`);
const accountId = sql`(SELECT id FROM token_connection)`;

function customOAuthCredentialRemovals() {
  const dialect = new PgDialect();
  const deletions = [
    { table: secrets, where: eq(secrets.connectorId, accountId) },
    { table: variables, where: eq(variables.connectorId, accountId) },
    {
      table: builtinConnectorAccountOauthBindings,
      where: eq(
        builtinConnectorAccountOauthBindings.connectorAccountId,
        accountId,
      ),
    },
  ];
  return deletions.map((deletion, index) => {
    const after =
      index === 0
        ? undefined
        : sql`(SELECT ${count()} FROM ${sql.identifier("custom_oauth_removed_" + (index - 1))}) >= 0`;
    const statement = dialect.buildDeleteQuery({
      table: deletion.table,
      where: and(deletion.where, after),
    });
    return sql`${sql.identifier("custom_oauth_removed_" + index)} AS (${statement} RETURNING 1)`;
  });
}

/** Schema encoders and omitted INSERT defaults survive the dependent source. */
function customOAuthTokenInsert(tokens: CustomOAuthPublication["tokens"]) {
  const values = sql.join(
    tokens.map((token) => {
      const fields = tokenPublicationFields(getTableColumns(secrets), {
        ...token,
        connectorId: accountId,
      });
      return sql`SELECT ${sql.join(
        fields.map(({ value }) => {
          return value;
        }),
        sql`, `,
      )}`;
    }),
    sql` UNION ALL `,
  );
  const [first] = tokens;
  if (!first) {
    throw new Error("Custom OAuth publication requires an access token");
  }
  const fields = tokenPublicationFields(getTableColumns(secrets), {
    ...first,
    connectorId: accountId,
  });
  return sql`custom_oauth_tokens AS (INSERT INTO ${secrets} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )})
    SELECT token_values.* FROM (${values}) AS token_values
    WHERE ${accountPresent} AND (SELECT ${count()} FROM custom_oauth_removed_2) >= 0 RETURNING id)`;
}

function customOAuthBindingClauses(args: CustomOAuthPublication): SQL[] {
  const dialect = new PgDialect();
  const removed = dialect.buildDeleteQuery({
    table: customConnectorAccountOauthBindings,
    where: and(
      eq(customConnectorAccountOauthBindings.connectorAccountId, accountId),
      sql`(SELECT ${count()} FROM custom_oauth_tokens) >= 0`,
    ),
  });
  const clauses = [
    sql`custom_oauth_removed_binding AS (${removed} RETURNING 1)`,
  ];
  if (args.binding !== null) {
    const fields = tokenPublicationFields(
      getTableColumns(customConnectorAccountOauthBindings),
      { ...args.binding, connectorAccountId: accountId },
    );
    clauses.push(sql`custom_oauth_binding AS (INSERT INTO ${customConnectorAccountOauthBindings} (${sql.join(
      fields.map(({ column }) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )})
      SELECT ${sql.join(
        fields.map(({ value }) => {
          return value;
        }),
        sql`, `,
      )} FROM token_connection
      WHERE (SELECT ${count()} FROM custom_oauth_removed_binding) >= 0 RETURNING connector_account_id)`);
  }
  return clauses;
}

/** One statement owns account, credentials, binding and unchanged quest award. */
export function customOAuthConnectionPublicationSql(
  args: CustomOAuthPublication,
): SQL {
  const clauses = [
    ...tokenConnectionWalletClauses(args.orgId),
    customOAuthDefinition(args),
  ];
  if (args.account === null) {
    // Missing/ambiguous/sibling-disabled resolution still initializes the wallet.
    return sql`WITH ${sql.join(clauses, sql`,\n`)} SELECT NULL::uuid AS connection_id,
      1 / CASE WHEN ${definitionCurrent} THEN 1 ELSE 0 END AS complete`;
  }
  clauses.push(
    ...tokenConnectionMetadataClauses(args.account, definitionCurrent),
    ...customOAuthCredentialRemovals(),
    customOAuthTokenInsert(args.tokens),
    ...customOAuthBindingClauses(args),
  );
  const reward = completedGetStartedQuestPublication(
    args.quest,
    nowDate(),
    sql`SELECT id FROM token_connection
    WHERE (SELECT ${count()} FROM custom_oauth_removed_binding) >= 0`,
  );
  clauses.push(
    sql`claim AS (${reward.claim})`,
    sql`custom_oauth_quest AS (${reward.grant} RETURNING id)`,
  );
  const bindingComplete =
    args.binding === null
      ? sql`true`
      : sql`(SELECT ${count()} FROM custom_oauth_binding) = 1`;
  return sql`WITH ${sql.join(clauses, sql`,\n`)} SELECT ${accountId} AS connection_id,
    1 / CASE WHEN ${definitionCurrent} AND ${accountPresent} AND (
      (SELECT ${count()} FROM custom_oauth_tokens) = ${args.tokens.length} AND ${bindingComplete}
    ) THEN 1 ELSE 0 END AS complete`;
}
