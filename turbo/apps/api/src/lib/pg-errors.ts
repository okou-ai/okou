const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_LOCK_NOT_AVAILABLE = "55P03";
const PG_UNIQUE_VIOLATION = "23505";
/** SQLSTATE is a fixed five-character class code; longer driver text is not. */
const SQL_STATE_PATTERN = /^[0-9A-Z]{5}$/u;

function pgErrorCode(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const { cause } = error;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }

  return cause.code;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION;
}

export function isLockNotAvailable(error: unknown): boolean {
  return pgErrorCode(error) === PG_LOCK_NOT_AVAILABLE;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_UNIQUE_VIOLATION;
}

/**
 * The SQLSTATE class code alone, for diagnostics that must never carry driver
 * messages, statements or bound parameters. Anything that is not exactly a
 * five-character code is dropped rather than published.
 */
export function safeSqlStateCode(error: unknown): string | undefined {
  const code = pgErrorCode(error);
  return typeof code === "string" && SQL_STATE_PATTERN.test(code)
    ? code
    : undefined;
}
