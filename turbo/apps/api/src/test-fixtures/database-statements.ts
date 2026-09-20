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

type ClientQuery = typeof Client.prototype.query;

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
  const counted = function countedQuery(
    this: Client,
    ...args: Parameters<ClientQuery>
  ): ReturnType<ClientQuery> {
    statements.push(statementText(args[0]));
    return Reflect.apply(original, this, args) as ReturnType<ClientQuery>;
  } as ClientQuery;
  Client.prototype.query = counted;
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
