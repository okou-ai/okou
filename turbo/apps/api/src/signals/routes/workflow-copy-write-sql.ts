import { getTableColumns, sql, SQL } from "drizzle-orm";
import {
  alias,
  PgDialect,
  type PgTable,
  type PgColumn,
} from "drizzle-orm/pg-core";
import { tokenPublicationFields } from "../services/builtin-token-connection-metadata";

export const copyInsertInputAlias = "copy_insert_input";

/** A typed composite rowset keeps bind count independent of the copy size. */
export function copyInsertManySql(
  table: PgTable,
  rows: readonly Readonly<Record<string, unknown>>[],
  eligible: SQL,
  returning: PgColumn,
  overrides: Readonly<Record<string, SQL>> = {},
): SQL {
  const first = rows[0];
  if (!first) {
    throw new Error("Workflow copy bulk input is empty");
  }
  const columns = getTableColumns(table);
  const fields = tokenPublicationFields(columns, first);
  const keys = fields.map(({ key }) => {
    return key;
  });
  const payload = rows.map((row) => {
    const rowKeys = Object.keys(row).filter((key) => {
      return row[key] !== undefined;
    });
    if (
      rowKeys.length !== keys.length ||
      keys.some((key) => {
        return !rowKeys.includes(key);
      })
    ) {
      throw new Error("Workflow copy bulk input columns changed");
    }
    return Object.fromEntries(
      fields.map(({ key, column }) => {
        const value = row[key];
        if (value instanceof SQL) {
          throw new Error("Workflow copy bulk input requires ordinary values");
        }
        // JSON columns already own JSON.stringify. Nest their original JSON once;
        // other columns retain the exact native encoder before table-type input.
        const encoded =
          value === null || column.dataType === "json"
            ? value
            : column.mapToDriverValue(value);
        return [column.name, encoded];
      }),
    );
  });
  const input = getTableColumns(alias(table, copyInsertInputAlias));
  return sql`INSERT INTO ${table} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )}) SELECT ${sql.join(
    fields.map(({ key }) => {
      const override = overrides[key];
      if (override) {
        return override;
      }
      const column = input[key];
      if (!column) {
        throw new Error("Workflow copy bulk column is missing");
      }
      return column;
    }),
    sql`, `,
  )}
    FROM jsonb_populate_recordset(NULL::${table}, ${JSON.stringify(payload)}::jsonb) AS ${sql.identifier(copyInsertInputAlias)}
    WHERE ${eligible} RETURNING ${returning}`;
}

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
