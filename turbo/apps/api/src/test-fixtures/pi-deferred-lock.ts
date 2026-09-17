import { sql } from "drizzle-orm";
import { z } from "zod";
import { expect, onTestFinished } from "vitest";
import { db } from "../lib/db";
import type { Tx } from "../lib/db-types";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  createDeferredPromise,
  isAbortError,
  onRejection,
  settleIncludingAbort,
} from "../signals/utils";

export async function holdDeferredRow(
  signal: AbortSignal,
  lock: (tx: Tx) => PromiseLike<unknown>,
  beforeCommit?: (tx: Tx) => PromiseLike<unknown>,
) {
  const entered = createDeferredPromise<number>(signal);
  const release = createDeferredPromise<void>(signal);
  const releaseOnce = () => {
    if (!release.settled()) {
      release.resolve();
    }
  };
  // Observe rejection immediately: afterEach aborts the signal before
  // onTestFinished joins the transaction and releases its database connection.
  const transaction = settleIncludingAbort(
    onRejection(
      db().transaction(async (tx) => {
        signal.throwIfAborted();
        await lock(tx);
        signal.throwIfAborted();
        const [row] = await executeRawRows(
          tx,
          sql`SELECT pg_backend_pid() AS pid`,
          z.object({ pid: z.number() }),
        );
        signal.throwIfAborted();
        if (!row) {
          throw new Error("Missing backend identity");
        }
        entered.resolve(row.pid);
        await release.promise;
        signal.throwIfAborted();
        await beforeCommit?.(tx);
        signal.throwIfAborted();
      }),
      (error) => {
        if (!entered.settled()) {
          entered.reject(error);
        }
      },
    ),
  );
  const releaseLock = async () => {
    releaseOnce();
    const result = await transaction;
    if (!result.ok && !(signal.aborted && isAbortError(result.error))) {
      throw result.error;
    }
  };
  onTestFinished(releaseLock);
  const pid = await entered.promise;
  return {
    waitForBlocked: () => {
      return waitForDeferredBlocker(pid);
    },
    release: releaseLock,
  };
}

export async function waitForDeferredBlocker(pid: number): Promise<number> {
  const waiters = () => {
    return executeRawRows(
      db(),
      sql`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
      z.object({ pid: z.number() }),
    );
  };
  await expect
    .poll(
      async () => {
        return (await waiters()).length;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const [waiter] = await waiters();
  if (!waiter) {
    throw new Error("Missing blocked transaction");
  }
  return waiter.pid;
}
