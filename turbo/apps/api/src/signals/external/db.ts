import { command, computed } from "ccstate";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z, type ZodType } from "zod";

import { acquireDbClient, db } from "../../lib/db";
import { executeRawRows } from "../../lib/db-raw-rows";

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

const readSettingsSchema = z.object({
  statement_timeout: z.string(),
  read_only: z.enum(["on", "off"]),
});

/**
 * Build before command execution. One business SELECT owns a statement snapshot;
 * settings use the exclusively leased client, never a transaction or a new pool.
 * An unsuccessful client is discarded rather than leaking its session settings.
 */
export function createReadOnlyQueryCommand<TSchema extends ZodType>(
  rowSchema: TSchema,
  timeoutMs: number,
) {
  return command(async (_context, query: SQL, signal: AbortSignal) => {
    signal.throwIfAborted();
    const client = await acquireDbClient();
    if (signal.aborted) {
      client.release(true);
      signal.throwIfAborted();
    }
    let reusable = false;
    const rows = await (async () => {
      signal.throwIfAborted();
      const connection = drizzle(client);
      const [settings] = await executeRawRows(
        connection,
        sql`SELECT current_setting('statement_timeout') AS statement_timeout,
          current_setting('default_transaction_read_only') AS read_only`,
        readSettingsSchema,
      );
      signal.throwIfAborted();
      if (settings === undefined) {
        throw new Error("Database read settings are unavailable.");
      }
      await connection.execute(sql`SELECT
        set_config('statement_timeout', ${`${timeoutMs.toString()}ms`}, false),
        set_config('default_transaction_read_only', 'on', false)`);
      signal.throwIfAborted();
      const selected = await executeRawRows(connection, query, rowSchema);
      signal.throwIfAborted();
      await connection.execute(sql`SELECT
        set_config('statement_timeout', ${settings.statement_timeout}, false),
        set_config('default_transaction_read_only', ${settings.read_only}, false)`);
      signal.throwIfAborted();
      reusable = true;
      return selected;
    })().finally(() => {
      client.release(!reusable);
    });
    signal.throwIfAborted();
    return rows;
  });
}
