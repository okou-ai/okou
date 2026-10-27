import { connectors } from "@okouai/db/schema/connector";
import {
  and,
  count,
  eq,
  getTableColumns,
  notExists,
  SQL,
  sql,
  type Column,
} from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  connectorConnectionMetadataWritePlan,
  connectorConnectionMetadataWriteResult,
  connectorConnectionSelection,
  type ConnectorConnectionWriteArgs,
} from "./connector-connection-write.service";
import { contextJsonProjection } from "./context-rowset";

export interface TokenConnectionMetadataPublication {
  readonly metadata: ConnectorConnectionWriteArgs;
  readonly accountRevision: string | null;
}

/** Keep partial INSERT defaults and each schema column's parameter encoder. */
export function tokenPublicationFields(
  columns: Readonly<Record<string, Column>>,
  values: Readonly<Record<string, unknown>>,
) {
  return Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const column = columns[key];
    if (!column) {
      throw new Error("Token publication contains an unknown column");
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

function tokenMetadataInsert(
  write: Extract<
    ReturnType<typeof connectorConnectionMetadataWritePlan>,
    { kind: "insert" }
  >,
  eligible: SQL,
) {
  const fields = tokenPublicationFields(
    getTableColumns(connectors),
    write.values,
  );
  let conflict = sql.empty();
  if (write.conflict) {
    const target = sql`(${sql.join(
      write.conflict.target.map((column) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )}) WHERE ${write.conflict.where}`;
    // A same-identity default may have committed while this INSERT waited.
    // RETURNING supplies that actual account to every dependent credential write.
    const identity = write.insert?.matchExternalId;
    conflict =
      identity === null || identity === undefined
        ? sql`ON CONFLICT ${target} DO NOTHING`
        : sql`ON CONFLICT ${target} DO UPDATE SET ${new PgDialect().buildUpdateSet(
            connectors,
            Object.fromEntries(
              tokenPublicationFields(
                getTableColumns(connectors),
                write.context.replacementValues,
              ).map(({ key, value }) => {
                return [key, value];
              }),
            ),
          )}, updated_at = clock_timestamp()
        WHERE ${eq(connectors.externalId, identity)}`;
  }
  return sql`INSERT INTO ${connectors} (${sql.join(
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
    )} WHERE ${eligible}
    ${conflict} RETURNING ${connectors.id}, ${contextJsonProjection(connectorConnectionSelection())} AS payload`;
}

/** Finite default/identity/sibling arbitration, with no executor or retry. */
export function tokenConnectionMetadataClauses(
  args: TokenConnectionMetadataPublication,
): SQL[] {
  const dialect = new PgDialect();
  const clauses: SQL[] = [];
  const names: string[] = [];
  let write = connectorConnectionMetadataWritePlan(args.metadata);
  const original = write;
  for (;;) {
    const name = "token_metadata_" + names.length;
    const earlier =
      names.length === 0
        ? sql`(SELECT ${count()} FROM token_wallet_entitlement) >= 0`
        : notExists(
            sql`(${sql.join(
              names.map((entry) => {
                return sql`SELECT id FROM ${sql.identifier(entry)}`;
              }),
              sql` UNION ALL `,
            )})`,
          );
    // A changed observed account is a conflict, never permission to overwrite
    // it or to manufacture a sibling. An already absent matched account can
    // still take the original insertion path.
    const fallback =
      original.kind === "update" && write.phase !== "existing"
        ? notExists(sql`(SELECT 1 FROM ${connectors} WHERE ${original.where})`)
        : sql`true`;
    const eligible = sql`${earlier} AND ${fallback}`;
    const statement =
      write.kind === "insert"
        ? tokenMetadataInsert(write, eligible)
        : dialect.buildUpdateQuery({
            table: connectors,
            set: Object.fromEntries(
              tokenPublicationFields(
                getTableColumns(connectors),
                write.values,
              ).map(({ key, value }) => {
                return [key, value];
              }),
            ),
            joins: [],
            where: and(
              write.where,
              eligible,
              write.phase === "existing" && args.accountRevision !== null
                ? eq(sql`${connectors}.xmin::text`, args.accountRevision)
                : undefined,
            ),
            returning: [
              { path: ["id"], field: connectors.id },
              {
                path: ["payload"],
                field: contextJsonProjection(connectorConnectionSelection()).as(
                  "payload",
                ),
              },
            ],
          });
    clauses.push(sql`${sql.identifier(name)} AS (${statement})`);
    names.push(name);
    if (write.phase === "sibling") {
      break;
    }
    const next = connectorConnectionMetadataWriteResult(write, undefined);
    if (next.kind === "resolved") {
      break;
    }
    write = next.write;
  }
  clauses.push(
    sql`token_connection AS (${sql.join(
      names.map((name) => {
        return sql`SELECT id, payload FROM ${sql.identifier(name)}`;
      }),
      sql` UNION ALL `,
    )})`,
  );
  return clauses;
}
