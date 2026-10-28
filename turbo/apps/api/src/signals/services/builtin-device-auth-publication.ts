import { builtinConnectorOauthDeviceAuthorizationSessions as sessions } from "@okouai/db/schema/connector-oauth-device-authorization-session";
import {
  and,
  count,
  exists,
  getTableColumns,
  sql,
  type SQL,
} from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { builtinTokenConnectionPublicationClauses } from "./builtin-token-connection-publication";
import { tokenPublicationFields } from "./builtin-token-connection-metadata";
import { tokenConnectionWalletClauses } from "./connector-publication-wallet";

function deviceSessionUpdate(
  values: Readonly<Record<string, unknown>>,
  condition: SQL | undefined,
) {
  return new PgDialect().buildUpdateQuery({
    table: sessions,
    set: Object.fromEntries(
      tokenPublicationFields(getTableColumns(sessions), values).map(
        ({ key, value }) => {
          return [key, value];
        },
      ),
    ),
    joins: [],
    where: condition,
    returning: [{ path: ["id"], field: sessions.id }],
  });
}

/** The final claim CAS and all credentials succeed or roll back together. */
export function deviceAuthTokenPublicationSql(
  publication: Parameters<typeof builtinTokenConnectionPublicationClauses>[0],
  condition: SQL | undefined,
  completedAt: Date,
): SQL {
  const claim = new QueryBuilder()
    .select({ id: sessions.id })
    .from(sessions)
    .where(condition);
  const claimed = exists(sql`(SELECT 1 FROM device_claim)`);
  const { clauses, complete } = builtinTokenConnectionPublicationClauses(
    publication,
    claimed,
  );
  const completion = deviceSessionUpdate(
    {
      status: "complete",
      completedConnectorId: sql`(SELECT id FROM token_connection)`,
      updatedAt: completedAt,
      completedAt,
    },
    // UPDATE rechecks the actual claim after a concurrent writer's row wait.
    // A lost claim makes the sentinel roll back the entire publication.
    and(condition, claimed, exists(sql`(SELECT 1 FROM token_connection)`)),
  );
  return sql`WITH device_claim AS MATERIALIZED (${claim}),
    ${sql.join(clauses, sql`,\n`)},
    device_completed AS (${completion})
    SELECT (SELECT payload FROM token_connection) AS connector,
      ${claimed} AS claimed,
      1 / CASE WHEN NOT (${claimed}) OR (
        (SELECT ${count()} FROM token_connection) = 1
        AND (${complete})
        AND (SELECT ${count()} FROM device_completed) = 1
      ) THEN 1 ELSE 0 END AS complete`;
}

/** Rejection remains terminal only for the same complete polling claim. */
export function deviceAuthRejectedPublicationSql(
  orgId: string,
  values: Readonly<Record<string, unknown>>,
  condition: SQL | undefined,
): SQL {
  const clauses = tokenConnectionWalletClauses(orgId);
  const rejection = deviceSessionUpdate(
    values,
    and(condition, sql`(SELECT ${count()} FROM token_wallet_entitlement) >= 0`),
  );
  return sql`WITH ${sql.join(clauses, sql`,\n`)},
    device_rejected AS (${rejection})
    SELECT EXISTS (SELECT 1 FROM device_rejected) AS rejected`;
}
