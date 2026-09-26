import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";

const PENDING_LIST_TARGET_BYTES = 512 * 1024;

/**
 * Runs outside projection transactions, without thread locks. Keep
 * fastupdate and the index's 4 MiB limit: a smaller foreground limit makes
 * INSERTs clean more often. The independent worker drains earlier instead.
 */
export async function maintainChatSearchGin(
  db: Db,
  indexName: string,
  budgetMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const deadline = performance.now() + budgetMs;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lock_timeout', '1s', true)`);
    signal.throwIfAborted();
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${`${Math.max(1, Math.floor(budgetMs))}ms`}, true)`,
    );
    signal.throwIfAborted();
    const [lock] = await executeRawRows(
      tx,
      // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
      sql`SELECT pg_try_advisory_xact_lock(hashtext('chat-search-gin'), hashtext(${indexName})) AS acquired`,
      z.object({ acquired: z.boolean() }),
    );
    signal.throwIfAborted();
    if (!lock) {
      throw new Error("Chat search GIN lock query returned no row");
    }
    if (!lock.acquired) {
      return;
    }
    const [pending] = await executeRawRows(
      tx,
      sql`SELECT pending_pages * current_setting('block_size')::bigint >= ${PENDING_LIST_TARGET_BYTES} AS "needsCleanup"
        FROM public.pgstatginindex(${indexName}::regclass)`,
      z.object({ needsCleanup: z.boolean() }),
    );
    signal.throwIfAborted();
    if (!pending) {
      throw new Error("Chat search GIN pending-list query returned no row");
    }
    if (pending.needsCleanup) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        return;
      }
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${`${Math.max(1, Math.floor(remainingMs))}ms`}, true)`,
      );
      signal.throwIfAborted();
      await tx.execute(
        sql`SELECT pg_catalog.gin_clean_pending_list(${indexName}::regclass)`,
      );
      signal.throwIfAborted();
    }
  });
  signal.throwIfAborted();
}
