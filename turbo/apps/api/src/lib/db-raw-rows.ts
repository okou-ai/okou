import type { SQLWrapper } from "drizzle-orm";
import { z, type output, type ZodType } from "zod";

type ApiDb = ReturnType<(typeof import("./db"))["db"]>;

type RawSqlExecutor = Pick<ApiDb, "execute">;

export const pgInt8ToSafeIntegerSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(z.int());

export const pgInt8ToBigIntSchema = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => {
    return BigInt(value);
  });

export const pgTimestampWithoutTimezoneToDateSchema = z
  .string()
  .transform((value) => {
    return new Date(`${value}+0000`);
  })
  .pipe(z.date());

/** Decode query results without passing a transaction out of its owner. */
export function parseRawRows<TSchema extends ZodType>(
  rowSchema: TSchema,
  result: { readonly rows: readonly unknown[] },
): output<TSchema>[] {
  return result.rows.map((row) => {
    return rowSchema.parse(row);
  });
}

export async function executeRawRows<TSchema extends ZodType>(
  executor: RawSqlExecutor,
  query: SQLWrapper,
  rowSchema: TSchema,
): Promise<output<TSchema>[]> {
  return parseRawRows(rowSchema, await executor.execute(query));
}
