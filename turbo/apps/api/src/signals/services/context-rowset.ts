import {
  type Column,
  type GetColumnData,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { object, unknown as zUnknown, type ZodType } from "zod";

/** Preserve native numeric precision in JSON; decode only in the consuming node. */
export function contextJsonProjection(
  columns: Readonly<Record<string, Column>>,
) {
  const fields = Object.entries(columns).flatMap(([name, column]) => {
    const type = column.getSQLType();
    const value =
      type === "bigint" || type.startsWith("numeric")
        ? sql`${column}::text`
        : sql`${column}`;
    return [sql`${name}::text`, value];
  });
  return sql`jsonb_build_object(${sql.join(fields, sql`, `)})`;
}

/** Scalar aggregation retains empty rowsets and never multiplies sibling groups. */
export function contextJsonRows(query: SQLWrapper) {
  return sql`(select coalesce(jsonb_agg(context_rows.payload), '[]'::jsonb)
    from (${query}) context_rows)`;
}

function columnSchema<T extends Column>(column: T): ZodType<GetColumnData<T>>;
function columnSchema(column: Column): ZodType<unknown> {
  return zUnknown().transform((value) => {
    // Drizzle also bypasses column decoders for SQL NULL.
    return value === null ? null : column.mapFromDriverValue(value);
  });
}

/** The original columns still own enums, timestamps, JSON contracts and errors. */
export function contextProjectionSchema<
  T extends Readonly<Record<string, Column>>,
>(columns: T): ZodType<{ [K in keyof T]: GetColumnData<T[K]> }>;
export function contextProjectionSchema(
  columns: Readonly<Record<string, Column>>,
): ZodType<Record<string, unknown>> {
  return object(
    Object.fromEntries(
      Object.entries(columns).map(([name, column]) => {
        return [name, columnSchema(column)];
      }),
    ),
  );
}
