import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import {
  PgDialect,
  PgColumn,
  type PgInsertValue,
  type PgTable,
  type PgUpdateSetSource,
} from "drizzle-orm/pg-core";

function pendingLaunchInsertFields<T extends PgTable>(
  table: T,
  values: PgInsertValue<T>,
) {
  const supplied = new Map(Object.entries(values));
  return Object.entries(getTableColumns(table)).flatMap(([key, column]) => {
    if (column.generated && column.generated.type !== "byDefault") {
      return [];
    }
    let value = supplied.get(key);
    if (value === undefined) {
      // Match Drizzle's runtime defaults. Omit other absent columns so the
      // database applies its own DEFAULT (including nullable columns).
      if (column.defaultFn) {
        value = column.defaultFn();
      } else if (!column.default && column.onUpdateFn) {
        value = column.onUpdateFn();
      } else {
        return [];
      }
    }
    return [
      { column, value: is(value, SQL) ? value : sql.param(value, column) },
    ];
  });
}

/** Conditional partial INSERT retains schema encoders and database defaults. */
export function pendingLaunchInsertSql<T extends PgTable>(
  table: T,
  values: PgInsertValue<T>,
  returning: readonly (keyof T["$inferInsert"] & string)[],
  eligibility: SQL,
  onConflict?: SQL,
): SQL {
  const columns = getTableColumns(table);
  const fields = pendingLaunchInsertFields(table, values);
  if (fields.length === 0 || returning.length === 0) {
    throw new Error("Pending launch insert requires fields and returning keys");
  }
  const returned = returning.map((key) => {
    const column = columns[key];
    if (!column) {
      throw new Error(`Unknown pending launch returning column: ${key}`);
    }
    return sql.identifier(column.name);
  });
  const names = fields.map(({ column }) => {
    return sql.identifier(column.name);
  });
  const selected = fields.map(({ value }) => {
    return value;
  });
  return sql`INSERT INTO ${table} (${sql.join(names, sql`, `)})
    SELECT ${sql.join(selected, sql`, `)} WHERE ${eligibility}
    ${onConflict ? sql`ON CONFLICT ${onConflict}` : sql.empty()}
    RETURNING ${sql.join(returned, sql`, `)}`;
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
    returning:
      returning.length === 0
        ? undefined
        : returning.map((key) => {
            const column = columns[key];
            if (!column) {
              throw new Error(
                `Unknown pending launch returning column: ${key}`,
              );
            }
            return { path: [key], field: column };
          }),
  });
}
