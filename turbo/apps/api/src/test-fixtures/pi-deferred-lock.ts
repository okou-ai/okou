import { sql } from "drizzle-orm";
import { z } from "zod";
import { expect, onTestFinished } from "vitest";
import { db } from "../lib/db";
import type { Tx } from "../lib/db-types";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise, settle } from "../signals/utils";

export async function holdDeferredRow(
  signal: AbortSignal,
  lock: (tx: Tx) => PromiseLike<unknown>,
  beforeCommit?: (tx: Tx) => PromiseLike<unknown>,
) {
  const entered = createDeferredPromise<number>(signal);
  const release = createDeferredPromise<void>(signal);
  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release.resolve();
    }
  };
  const transaction = db().transaction(async (tx) => {
    await lock(tx);
    const [row] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      z.object({ pid: z.number() }),
    );
    if (!row) {
      throw new Error("Missing backend identity");
    }
    entered.resolve(row.pid);
    await release.promise;
    await beforeCommit?.(tx);
  });
  onTestFinished(async () => {
    releaseOnce();
    await settle(transaction);
  });
  const pid = await entered.promise;
  return {
    waitForBlocked: () => {
      return waitForDeferredBlocker(pid);
    },
    release: async () => {
      releaseOnce();
      await transaction;
    },
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
