import { getTableColumns, is, sql, SQL, type Column } from "drizzle-orm";
import { PgDialect, PgColumn, type PgTable } from "drizzle-orm/pg-core";
import { date, tuple, type output, type ZodType } from "zod";

import { contextProjectionSchema } from "./context-rowset";

export type UsagePackRetainedFinancialPlan<T> = Generator<
  | { readonly kind: "read" | "write"; readonly sql: SQL }
  | { readonly kind: "timestamp" },
  T,
  readonly unknown[]
>;
/** These plans produce only SQL/data. Their command alone executes each step. */
export function* usagePackSqlRows<S extends ZodType>(
  query: SQL,
  schema: S,
): Generator<
  { readonly kind: "read"; readonly sql: SQL },
  output<S>[],
  readonly unknown[]
> {
  return schema.array().parse(yield { kind: "read", sql: query });
}
export function* usagePackSqlWrite(
  query: SQL,
): Generator<
  { readonly kind: "write"; readonly sql: SQL },
  void,
  readonly unknown[]
> {
  yield { kind: "write", sql: query };
}
export function* usagePackSqlClock(): Generator<
  { readonly kind: "timestamp" },
  Date,
  readonly unknown[]
> {
  return tuple([date()]).parse(yield { kind: "timestamp" })[0];
}
export function usagePackSqlSelection(
  columns: Readonly<Record<string, Column>>,
) {
  return Object.fromEntries(
    Object.entries(columns).map(([name, column]) => {
      return [name, sql`${column}`.as(name)];
    }),
  );
}
export function usagePackSqlRow<C extends Readonly<Record<string, Column>>>(
  columns: C,
) {
  return contextProjectionSchema(columns);
}
function bound(table: PgTable, values: Readonly<Record<string, unknown>>) {
  const columns: Readonly<Record<string, Column>> = getTableColumns(table);
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => {
        return value !== undefined;
      })
      .map(([name, value]) => {
        return [
          name,
          is(value, SQL) || is(value, PgColumn)
            ? sql`${value}`
            : sql.param(value, columns[name]),
        ];
      }),
  );
}
function returning(columns: Readonly<Record<string, Column>> | undefined) {
  return columns
    ? Object.entries(columns).map(([name, column]) => {
        return {
          path: [name],
          field: sql`${column}`.as(name),
        };
      })
    : undefined;
}
interface Conflict {
  readonly target?: Column | readonly Column[];
  readonly where?: SQL;
  readonly targetWhere?: SQL;
  readonly setWhere?: SQL;
  readonly set?: Readonly<Record<string, unknown>>;
}
function conflictSql(table: PgTable, conflict: Conflict | undefined) {
  if (!conflict) {
    return undefined;
  }
  const target = conflict.target;
  const columns = target ? (Array.isArray(target) ? target : [target]) : [];
  const identity = columns.length
    ? sql`(${sql.join(
        columns.map((column) => {
          return sql.identifier(column.name);
        }),
        sql`, `,
      )})`
    : sql.empty();
  if (!conflict.set) {
    return sql`${identity}${conflict.where ? sql` where ${conflict.where}` : sql.empty()} do nothing`;
  }
  const set = new PgDialect().buildUpdateSet(table, bound(table, conflict.set));
  return sql`${identity}${conflict.targetWhere ? sql` where ${conflict.targetWhere}` : sql.empty()} do update set ${set}${conflict.setWhere ? sql` where ${conflict.setWhere}` : sql.empty()}`;
}
export function usagePackSqlInsert<T extends PgTable>(
  table: T,
  values:
    | Readonly<Record<string, unknown>>
    | readonly Readonly<Record<string, unknown>>[],
  options?: {
    readonly conflict?: Conflict;
    readonly returning?: Readonly<Record<string, Column>>;
  },
) {
  const rows = Array.isArray(values) ? values : [values];
  return new PgDialect().buildInsertQuery({
    table,
    values: rows.map((row) => {
      return bound(table, row);
    }),
    onConflict: conflictSql(table, options?.conflict),
    returning: returning(options?.returning),
  });
}
export function usagePackSqlUpdate<T extends PgTable>(
  table: T,
  values: Readonly<Record<string, unknown>>,
  where: SQL | undefined,
  columns?: Readonly<Record<string, Column>>,
) {
  return new PgDialect().buildUpdateQuery({
    table,
    set: bound(table, values),
    where,
    joins: [],
    returning: returning(columns),
  });
}
