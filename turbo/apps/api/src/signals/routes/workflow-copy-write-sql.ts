import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { tokenPublicationFields } from "../services/builtin-token-connection-metadata";

/** Keep partial INSERT defaults and every column's native parameter encoder. */
export function copyInsertSql(
  table: PgTable,
  values: Readonly<Record<string, unknown>>,
  eligible: SQL,
  returning: PgColumn,
): SQL {
  const fields = tokenPublicationFields(getTableColumns(table), values);
  return sql`INSERT INTO ${table} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )}) SELECT ${sql.join(
    fields.map(({ value }) => {
      return value;
    }),
    sql`, `,
  )} WHERE ${eligible} RETURNING ${returning}`;
}

export function copyUpdateSql(
  table: PgTable,
  values: Readonly<Record<string, unknown>>,
  condition: SQL | undefined,
  returning: PgColumn,
): SQL {
  return new PgDialect().buildUpdateQuery({
    table,
    set: Object.fromEntries(
      tokenPublicationFields(getTableColumns(table), values).map(
        ({ key, value }) => {
          return [key, value];
        },
      ),
    ),
    joins: [],
    where: condition,
    returning: [{ path: ["id"], field: returning }],
  });
}
