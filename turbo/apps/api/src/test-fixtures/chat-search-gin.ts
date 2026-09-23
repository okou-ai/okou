import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { closeDbPool, db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";
import { barrierQueryBinds, barrierQueryText } from "./account-erasure-subject";

/** GIN storage/maintenance cannot be controlled through the message API. Each
 * fixture owns a separate table, index and advisory-lock key; concurrent suites
 * keep their own pending lists and never change the shared projection index.
 */
export async function createChatSearchGinFixture() {
  const suffix = randomUUID().replaceAll("-", "");
  const table = sql.identifier(`chat_search_gin_table_${suffix}`);
  const indexName = `chat_search_gin_test_${suffix}`;
  await db().execute(
    sql`CREATE TABLE ${table} (body tsvector) WITH (autovacuum_enabled = false)`,
  );
  onTestFinished(async () => {
    await db().execute(sql`DROP TABLE ${table}`);
  });
  await db().execute(
    sql`CREATE INDEX ${sql.identifier(indexName)} ON ${table} USING gin (body)`,
  );
  return {
    indexName,
    async insert(rows: number) {
      await db().execute(sql`INSERT INTO ${table} (body)
        SELECT to_tsvector('simple', (SELECT string_agg('term' || term::text, ' ')
          FROM generate_series(1, 100) term)) FROM generate_series(1, ${rows})`);
    },
    async pendingPages() {
      const [row] = await executeRawRows(
        db(),
        sql`SELECT pending_pages FROM public.pgstatginindex(${indexName}::regclass)`,
        z.object({ pending_pages: z.int().nonnegative() }),
      );
      if (!row) {
        throw new Error("Missing fixture GIN statistics");
      }
      return row.pending_pages;
    },
    async hold(kind: "maintenance" | "index", signal: AbortSignal) {
      const ready = createDeferredPromise<void>(signal);
      const released = createDeferredPromise<void>(signal);
      const done = settleIncludingAbort(
        db().transaction(async (tx) => {
          if (kind === "maintenance") {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext('chat-search-gin'), hashtext(${indexName}))`,
            );
          } else {
            // REINDEX retains its exclusive index lock until this owned
            // transaction ends, without locking any shared product table.
            await tx.execute(sql`REINDEX INDEX ${sql.identifier(indexName)}`);
          }
          ready.resolve();
          await released.promise;
        }),
      );
      const release = async () => {
        if (!released.settled()) {
          released.resolve();
        }
        const result = await done;
        if (!result.ok && result.error !== signal.reason) {
          throw result.error;
        }
      };
      onTestFinished(release);
      await ready.promise;
      return release;
    },
  };
}

/** A real server failure after message writes, before or at the watermark.
 * The API cannot deliberately stall a backend. A test-owned watermark row lock
 * makes the real upsert wait; only this transaction gets a short statement
 * deadline. PostgreSQL and Drizzle produce the failure and rollback without
 * fabricated errors.
 */
export async function withChatSearchStatementFailureFixture<T>(
  chatThreadId: string,
  failure: "timeout" | "cancel",
  work: () => Promise<T>,
): Promise<T> {
  await closeDbPool();
  const original = Client.prototype.query;
  let injected = false;
  let serverStatementTimeout = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const text = barrierQueryText(queryArgs);
      if (
        injected ||
        !text.startsWith(
          'insert into "chat_event_search_message_watermarks"',
        ) ||
        !barrierQueryBinds(queryArgs, chatThreadId)
      ) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      injected = true;
      return (async () => {
        if (failure === "timeout") {
          // This transaction already has the production 1s lock timeout and
          // 5s statement timeout. Shorten only its statement deadline, just
          // before the real watermark write waits on the test-owned row.
          await Reflect.apply(target, receiver, [
            "SET LOCAL statement_timeout = '300ms'",
          ]);
        } else {
          await Reflect.apply(target, receiver, [
            "SELECT pg_cancel_backend(pg_backend_pid())",
          ]);
        }
        const outcome = await settleIncludingAbort(
          Reflect.apply(target, receiver, queryArgs) as Promise<unknown>,
        );
        if (!outcome.ok) {
          if (failure === "timeout") {
            serverStatementTimeout = z
              .object({
                code: z.literal("57014"),
                message: z.literal(
                  "canceling statement due to statement timeout",
                ),
              })
              .safeParse(outcome.error).success;
          }
          throw outcome.error;
        }
        return outcome.value;
      })();
    },
  });
  const result = await settleIncludingAbort(work());
  const closed = await settleIncludingAbort(closeDbPool());
  Client.prototype.query = original;
  if (!result.ok) {
    throw result.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  if (!injected) {
    throw new Error("Owned projection did not reach the failure fixture");
  }
  if (failure === "timeout" && !serverStatementTimeout) {
    throw new Error("Owned watermark write did not hit statement_timeout");
  }
  return result.value;
}
