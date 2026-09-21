import { describe, expect, it } from "vitest";

import {
  isForeignKeyViolation,
  isLockNotAvailable,
  isStatementTimeout,
  isUniqueViolation,
  safeSqlStateCode,
} from "../pg-errors";

// Public APIs cannot construct arbitrary database-driver failures. Route tests
// own the end-to-end proof that the installed driver really surfaces a SQLSTATE
// this way; this file pins the exact classification and redaction boundary.
function driverError(code: unknown): Error {
  return new Error("insert into run_activity_snapshots ... failed", {
    cause: { code },
  });
}

describe("SQLSTATE classification", () => {
  it.each([
    ["55P03", isLockNotAvailable],
    ["23503", isForeignKeyViolation],
    ["23505", isUniqueViolation],
  ])("matches %s only for its own predicate", (code, predicate) => {
    expect(predicate(driverError(code))).toBeTruthy();
    expect(
      [isLockNotAvailable, isForeignKeyViolation, isUniqueViolation].filter(
        (other) => {
          return other(driverError(code));
        },
      ),
    ).toStrictEqual([predicate]);
  });
});

describe("safeSqlStateCode", () => {
  it.each(["55P03", "23503", "23505", "57014", "40P01", "22P05"])(
    "publishes the %s class code",
    (code) => {
      expect(safeSqlStateCode(driverError(code))).toBe(code);
    },
  );

  it("publishes the class code alone, never the driver message", () => {
    const code = safeSqlStateCode(driverError("23503"));

    expect(code).toBe("23503");
    expect(code).not.toContain("run_activity_snapshots");
  });

  it.each([
    ["no cause", new Error("plain failure")],
    ["a non-object cause", new Error("wrapped", { cause: "23503" })],
    ["a numeric code", driverError(23_503)],
    ["an absent code", new Error("wrapped", { cause: {} })],
    // A transport failure carries no SQLSTATE. Publishing it as one would
    // invent a database fault class that PostgreSQL never returned.
    ["a transport code", driverError("ECONNRESET")],
    ["a lowercase code", driverError("55p03")],
    ["an over-long code", driverError("55P030")],
  ])("drops %s", (_label, error) => {
    expect(safeSqlStateCode(error)).toBeUndefined();
  });
});

describe("isStatementTimeout", () => {
  it("recognizes the server deadline in the Drizzle cause", () => {
    expect(
      isStatementTimeout(
        new Error("query failed", {
          cause: {
            code: "57014",
            message: "canceling statement due to statement timeout",
          },
        }),
      ),
    ).toBeTruthy();
  });

  it.each([
    ["57014", "canceling statement due to user request"],
    ["57014", "unknown cancellation"],
    ["55P03", "canceling statement due to statement timeout"],
    ["57014", undefined],
  ])("does not retry %s / %s", (code, message) => {
    expect(
      isStatementTimeout(
        new Error("query failed", { cause: { code, message } }),
      ),
    ).toBeFalsy();
  });

  it("preserves caller cancellation and unwrapped errors", () => {
    expect(
      isStatementTimeout(new DOMException("cancelled", "AbortError")),
    ).toBeFalsy();
    expect(
      isStatementTimeout({
        code: "57014",
        message: "canceling statement due to statement timeout",
      }),
    ).toBeFalsy();
  });
});
