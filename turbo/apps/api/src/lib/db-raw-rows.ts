import { date, int, string, type output, type ZodType } from "zod";

export const pgInt8ToSafeIntegerSchema = string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(int());

export const pgInt8ToBigIntSchema = string()
  .regex(/^-?\d+$/)
  .transform((value) => {
    return BigInt(value);
  });

export const pgTimestampWithoutTimezoneToDateSchema = string()
  .transform((value) => {
    return new Date(`${value}+0000`);
  })
  .pipe(date());

/** Decode query results without passing a transaction out of its owner. */
export function parseRawRows<TSchema extends ZodType>(
  rowSchema: TSchema,
  result: { readonly rows: readonly unknown[] },
): output<TSchema>[] {
  return result.rows.map((row) => {
    return rowSchema.parse(row);
  });
}
