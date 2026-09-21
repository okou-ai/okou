/**
 * Count the statements one production path actually sends to PostgreSQL.
 *
 * An authority check that repeats per collected item is invisible in an HTTP
 * response: the brief still arrives, it just re-asks the same question once per
 * message. The quantity that changes is the number of statements the attempt
 * spends, so a regression test for that defect has to be able to observe it.
 *
 * Counting is installed on `pg`'s client prototype, which every pooled query
 * and every transaction statement passes through exactly once, so a statement
 * is never double-counted by the pool wrapper above it.
 */

import { Client } from "pg";

export interface DatabaseStatementCounter {
  /** How many statements so far mentioned this exact table. */
  readonly reads: (table: string) => number;
  /** Forget everything counted so far, without uninstalling. */
  readonly reset: () => void;
  readonly restore: () => void;
}

/**
 * The only shape this counter needs from `pg`'s overloaded `query`.
 *
 * `Client.prototype.query` is declared with several overloads, one of which
 * returns `void` for the callback form. Borrowing its type here would make the
 * wrapper claim that return while it actually forwards whatever the real method
 * produced, so the interception is typed by what it does — read the first
 * argument and hand the call through untouched.
 */
type CountedClientQuery = (this: Client, ...args: unknown[]) => unknown;

function statementText(config: unknown): string {
  if (typeof config === "string") {
    return config;
  }
  if (
    typeof config === "object" &&
    config !== null &&
    "text" in config &&
    typeof config.text === "string"
  ) {
    return config.text;
  }
  return "";
}

/**
 * Start counting, and stop again through `restore`.
 *
 * Install it from the suite's module body, before anything has opened a pooled
 * connection. The pool instruments each client by binding the prototype method
 * it finds at connect time, so a wrapper installed after the first query would
 * never be reached and would count nothing at all.
 *
 * The prototype is restored rather than left wrapped, so a suite that forgets
 * to stop counting fails its own teardown instead of leaking the wrapper into
 * the next file's measurements.
 */
export function countDatabaseStatements(): DatabaseStatementCounter {
  let statements: string[] = [];
  const original = Client.prototype.query;
  const forward = original as unknown as CountedClientQuery;
  const counted: CountedClientQuery = function countedQuery(
    this: Client,
    ...args: unknown[]
  ): unknown {
    statements.push(statementText(args[0]));
    return forward.apply(this, args);
  };
  Client.prototype.query = counted as unknown as typeof Client.prototype.query;
  return {
    reads: (table: string): number => {
      const mention = `"${table}"`;
      return statements.filter((statement) => {
        return statement.includes(mention);
      }).length;
    },
    reset: (): void => {
      statements = [];
    },
    restore: (): void => {
      Client.prototype.query = original;
    },
  };
}
