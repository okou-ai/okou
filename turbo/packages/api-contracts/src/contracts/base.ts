import * as z from "zod";

export { initContract } from "./trpc-contract";

const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

function rejectBlankQueryNumber(value: unknown): unknown {
  if (typeof value === "string" && value.trim().length === 0) {
    return Number.NaN;
  }

  return value;
}

export function isValidDateTimestamp(value: number): boolean {
  return (
    Number.isSafeInteger(value) && Math.abs(value) <= MAX_DATE_TIMESTAMP_MS
  );
}

export const timestampQueryNumberSchema = z.preprocess(
  rejectBlankQueryNumber,
  z.coerce
    .number()
    .refine(Number.isSafeInteger, {
      message: "Value must be a safe integer",
    })
    .refine(isValidDateTimestamp, {
      message: "Timestamp is out of range",
    }),
);

/**
 * Shared headers schema for endpoints requiring authentication.
 * The authorization header is optional - endpoints handle missing auth
 * by returning 401 responses.
 *
 */
export const authHeadersSchema = z.object({
  authorization: z.string().optional(),
});
