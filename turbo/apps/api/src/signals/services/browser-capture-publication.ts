import { eq, isNull, lt, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** A capture may refresh its observed value or supersede an older capture.
 * Sample capturedAt after reading previousValue and before native capture, so
 * response delivery cannot promote an older observation over a newer one.
 * Equal-clock competing captures retain the accepted winner. A later capture
 * that observed that winner can still refresh it, even if the clock regresses.
 * No write reserves publication while native/encryption/upload IO is pending.
 */
export function browserCapturePublication(input: {
  readonly value: AnyPgColumn<{ data: string }>;
  readonly updatedAt: AnyPgColumn<{ data: Date }>;
  readonly previousValue: string | null;
  readonly capturedAt: Date;
}) {
  return {
    canReplace: or(
      isNull(input.value),
      input.previousValue === null
        ? sql`false`
        : eq(input.value, input.previousValue),
      lt(input.updatedAt, input.capturedAt),
    ),
    updatedAt: sql`greatest(${input.updatedAt}, ${sql.param(input.capturedAt, input.updatedAt)}::timestamp)`,
  };
}
