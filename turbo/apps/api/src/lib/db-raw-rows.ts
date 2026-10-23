import * as z from "zod";
import type { output, ZodType } from "zod";

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
