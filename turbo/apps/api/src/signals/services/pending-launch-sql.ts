import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import {
  PgDialect,
  PgColumn,
  type PgInsertValue,
  type PgTable,
  type PgUpdateSetSource,
} from "drizzle-orm/pg-core";

/** Non-executing schema-aware insert plan. No session or database is constructed. */
export function pendingLaunchInsertSql<T extends PgTable>(
  table: T,
  values: readonly PgInsertValue<T>[],
  returning: readonly (keyof T["$inferInsert"] & string)[] = [],
): SQL {
  const columns = getTableColumns(table);
  return new PgDialect().buildInsertQuery({
    table,
    values: values.map((row) => {
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          return [key, is(value, SQL) ? value : sql.param(value, columns[key])];
        }),
      );
    }),
    returning: returning.map((key) => {
      const column = columns[key];
      if (!column) {
        throw new Error(`Unknown pending launch returning column: ${key}`);
      }
      return { path: [key], field: column };
    }),
  });
}

/** Match Drizzle's set encoding and omission of undefined update values. */
export function pendingLaunchUpdateSql<T extends PgTable>(
  table: T,
  values: PgUpdateSetSource<T>,
  where: SQL | undefined,
  returning: readonly (keyof T["$inferInsert"] & string)[] = [],
): SQL {
  const columns = getTableColumns(table);
  return new PgDialect().buildUpdateQuery({
    table,
    set: Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => {
          return value !== undefined;
        })
        .map(([key, value]) => {
          return [
            key,
            is(value, SQL) || is(value, PgColumn)
              ? value
              : sql.param(value, columns[key]),
          ];
        }),
    ),
    where,
    joins: [],
    returning: returning.map((key) => {
      const column = columns[key];
      if (!column) {
        throw new Error(`Unknown pending launch returning column: ${key}`);
      }
      return { path: [key], field: column };
    }),
  });
}
