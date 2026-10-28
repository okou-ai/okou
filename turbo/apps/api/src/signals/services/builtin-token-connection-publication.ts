import { tokenConnectionWalletClauses } from "./connector-publication-wallet";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import {
  and,
  count,
  eq,
  exists,
  getTableColumns,
  sql,
  type SQL,
} from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import {
  connectorAccountReconciliationIdentity,
  connectorAccountReconciliationWrites,
} from "./connector-account-state.service";
import { builtinTokenCredentialWrites } from "./connector-credential-storage-write.service";
import { completedGetStartedQuestPublication } from "./get-started-member-reward";
import {
  tokenConnectionMetadataClauses,
  tokenPublicationFields,
  type TokenConnectionMetadataPublication,
} from "./builtin-token-connection-metadata";
import {
  tokenConnectionProjectionClauses,
  type TokenProjectionPublication,
} from "./builtin-token-connection-projection";

interface TokenConnectionPublication extends TokenConnectionMetadataPublication {
  readonly orgId: string;
  readonly credentials: Parameters<typeof builtinTokenCredentialWrites>[1];
  readonly reconciliation: ReturnType<
    typeof connectorAccountReconciliationIdentity
  > | null;
  readonly projection: TokenProjectionPublication;
  readonly quest:
    Parameters<typeof completedGetStartedQuestPublication>[0] | null;
}

const admitted = exists(sql`(SELECT 1 FROM token_connection)`);
const accountId = sql`(SELECT id FROM token_connection)`;

function tokenReconciliationClauses(args: TokenConnectionPublication): SQL[] {
  if (args.reconciliation === null) {
    return [];
  }
  const clauses: SQL[] = [];
  const dialect = new PgDialect();
  for (const [index, write] of [
    ...connectorAccountReconciliationWrites(args.reconciliation),
  ].entries()) {
    // These two targets also receive the final account projection. Their writes
    // are composed there, so PostgreSQL never modifies the same row twice.
    if (write.kind === "gmail" || write.kind === "notion") {
      continue;
    }
    const statement =
      write.kind === "delete"
        ? dialect.buildDeleteQuery({
            table: write.table,
            where: and(write.where, admitted),
          })
        : dialect.buildUpdateQuery({
            table: write.table,
            set: Object.fromEntries(
              tokenPublicationFields(
                getTableColumns(write.table),
                write.values,
              ).map(({ key, value }) => {
                return [key, value];
              }),
            ),
            joins: [],
            where: and(write.where, admitted),
          });
    clauses.push(
      sql`${sql.identifier("token_reconcile_" + index)} AS (${statement} RETURNING 1)`,
    );
  }
  return clauses;
}

function tokenCredentialRemovalClauses(): SQL[] {
  const dialect = new PgDialect();
  const secretRemoval = dialect.buildDeleteQuery({
    table: secrets,
    where: eq(secrets.connectorId, accountId),
    returning: [{ path: ["id"], field: secrets.id }],
  });
  const variableRemoval = dialect.buildDeleteQuery({
    table: variables,
    where: and(
      eq(variables.connectorId, accountId),
      sql`(SELECT ${count()} FROM token_removed_secrets) >= 0`,
    ),
    returning: [{ path: ["id"], field: variables.id }],
  });
  const bindingRemoval = dialect.buildDeleteQuery({
    table: builtinConnectorAccountOauthBindings,
    where: and(
      eq(builtinConnectorAccountOauthBindings.connectorAccountId, accountId),
      sql`(SELECT ${count()} FROM token_removed_variables) >= 0`,
    ),
    returning: [
      {
        path: ["id"],
        field: builtinConnectorAccountOauthBindings.connectorAccountId,
      },
    ],
  });
  return [
    sql`token_removed_secrets AS (${secretRemoval})`,
    sql`token_removed_variables AS (${variableRemoval})`,
    sql`token_removed_binding AS (${bindingRemoval})`,
  ];
}

function tokenCredentialPublication(args: TokenConnectionPublication) {
  const clauses = tokenCredentialRemovalClauses();
  const checks: SQL[] = [];
  let previous = "token_removed_binding";
  const dialect = new PgDialect();
  const writes = [
    ...builtinTokenCredentialWrites(
      "00000000-0000-4000-8000-000000000000",
      args.credentials,
    ),
  ];
  const latest = new Map<string, (typeof writes)[number]>();
  // Grant outputs may share a declared storage target. Preserve the original
  // sequential last value while modifying each credential key only once.
  for (const write of writes) {
    latest.set(write.kind + ":" + write.values.name, write);
  }
  // The actual returned account replaces this DB-free descriptor's placeholder.
  for (const [index, write] of [...latest.values()].entries()) {
    const fields = tokenPublicationFields(getTableColumns(write.table), {
      ...write.values,
      connectorId: accountId,
    });
    const update = dialect.buildUpdateSet(
      write.table,
      Object.fromEntries(
        tokenPublicationFields(
          getTableColumns(write.table),
          write.conflict.set,
        ).map(({ key, value }) => {
          return [key, value];
        }),
      ),
    );
    const name = "token_credential_" + index;
    clauses.push(sql`${sql.identifier(name)} AS (INSERT INTO ${write.table} (${sql.join(
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
      )} WHERE ${admitted}
        AND (SELECT ${count()} FROM ${sql.identifier(previous)}) >= 0
      ON CONFLICT (${sql.join(
        write.conflict.target.map((column) => {
          return sql.identifier(column.name);
        }),
        sql`, `,
      )})
        WHERE ${write.conflict.targetWhere} DO UPDATE SET ${update}
      RETURNING id)`);
    checks.push(sql`(SELECT ${count()} FROM ${sql.identifier(name)}) = 1`);
    previous = name;
  }
  return { clauses, checks };
}

/** Pure clauses let device completion share the same rollback authority. */
export function builtinTokenConnectionPublicationClauses(
  args: TokenConnectionPublication,
  prerequisite?: SQL,
) {
  const credentials = tokenCredentialPublication(args);
  const projections = tokenConnectionProjectionClauses(args.projection);
  const clauses = [
    ...tokenConnectionWalletClauses(args.orgId),
    ...tokenConnectionMetadataClauses(args, prerequisite),
    ...tokenReconciliationClauses(args),
    ...credentials.clauses,
    ...projections.clauses,
  ];
  if (args.quest !== null) {
    const reward = completedGetStartedQuestPublication(
      args.quest,
      nowDate(),
      sql`SELECT id FROM token_connection`,
    );
    clauses.push(
      sql`claim AS (${reward.claim})`,
      sql`token_quest_grant AS (${reward.grant} RETURNING id)`,
    );
  }
  const checks = [...credentials.checks, ...projections.checks];
  const complete =
    checks.length === 0
      ? sql`true`
      : sql.join(
          checks.map((check) => {
            return sql`(${check})`;
          }),
          sql` AND `,
        );
  return { clauses, complete };
}

/** One rollback authority for account, credentials, cleanup, grant and projection. */
export function builtinTokenConnectionPublicationSql(
  args: TokenConnectionPublication,
): SQL {
  const { clauses, complete } = builtinTokenConnectionPublicationClauses(args);
  return sql`WITH ${sql.join(clauses, sql`,\n`)}
    SELECT (SELECT payload FROM token_connection) AS connector,
      1 / CASE WHEN NOT (${admitted}) OR (${complete}) THEN 1 ELSE 0 END AS complete`;
}
