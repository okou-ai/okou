import { command, computed } from "ccstate";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { db } from "../../lib/db";

export type Db = ReturnType<typeof db>;

// Mutation builders shared by node-postgres and lifecycle-owned PGlite. Query
// results with RETURNING remain typed; bare write driver results stay opaque.
export type SqlMutationDb = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update"
>;

type DbWriteMethod =
  | "insert"
  | "update"
  | "delete"
  | "execute"
  | "transaction"
  | "refreshMaterializedView"
  | "batch";

export type ReadonlyDb = Omit<Db, DbWriteMethod>;

export const db$ = computed((): ReadonlyDb => {
  return db();
});

export const writeDb$ = command(() => {
  return db();
});

/**
 * Connection for handwritten raw-SQL reads. `ReadonlyDb` omits `execute`, so
 * these read-only statements take the full connection type until the
 * handwritten SQL moves to the typed builder. Nodes read it here instead of
 * receiving a handle through state or inputs.
 */
export const rawSqlReadDb$ = computed((): Db => {
  return db();
});
