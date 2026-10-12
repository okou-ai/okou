import { command, computed } from "ccstate";
import { db } from "../../lib/db";

export type Db = ReturnType<typeof db>;

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
