import { createHash } from "node:crypto";

import { browserAuthorizationRequests } from "@okouai/db/schema/browser-session";
import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

/** The same digest the service stores; the opaque token itself is never kept. */
function requestTokenHash(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

/**
 * Infrastructure exception: nothing in production deletes a browser
 * authorization request. No endpoint revokes one, the table carries no foreign
 * key that could cascade it away and no cleanup job sweeps it, so the window
 * where a request disappears between the apply preflight and the fenced write
 * cannot be produced through an API. It removes only the row the calling test
 * created and touches no thread, event or closure.
 */
export async function deleteBrowserAuthorizationRequestFixture(
  requestToken: string,
): Promise<void> {
  const deleted = await db()
    .delete(browserAuthorizationRequests)
    .where(
      eq(
        browserAuthorizationRequests.requestTokenHash,
        requestTokenHash(requestToken),
      ),
    )
    .returning({ id: browserAuthorizationRequests.id });
  if (deleted.length !== 1) {
    throw new Error("Expected one browser authorization request to be removed");
  }
}

/**
 * Infrastructure exception: `expires_at` is written once at creation from a
 * fixed TTL and no production writer moves it, so a request that lapses while
 * an accepted apply is already inside its fenced transaction cannot be staged
 * through an API. It changes only that one column.
 */
export async function expireBrowserAuthorizationRequestFixture(args: {
  readonly requestToken: string;
  readonly expiresAt: Date;
}): Promise<void> {
  const updated = await db()
    .update(browserAuthorizationRequests)
    .set({ expiresAt: args.expiresAt })
    .where(
      eq(
        browserAuthorizationRequests.requestTokenHash,
        requestTokenHash(args.requestToken),
      ),
    )
    .returning({ id: browserAuthorizationRequests.id });
  if (updated.length !== 1) {
    throw new Error("Expected one browser authorization request to expire");
  }
}

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.number() });

/**
 * Backends the holder blocks whose current statement is the apply's own request
 * pin. Counting the pin specifically, rather than any waiter, is what makes a
 * non-zero result proof that this exact apply reached the request lock instead
 * of merely proof that something waits somewhere.
 */
async function blockedRequestPinCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        AND lower(activity.query) LIKE '%browser_authorization_requests%'
        AND lower(activity.query) LIKE '%for no key update%'
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

/**
 * Holds one request row from a second real session, so an apply that reaches
 * its own `FOR NO KEY UPDATE` pin waits in PostgreSQL for a lock this fixture
 * owns. That wait is the window the service's expiry recheck has to survive,
 * and it cannot be produced through any API: nothing in production locks a
 * browser authorization request outside the apply itself.
 *
 * The holder is idle inside its transaction while it waits for `release`, so it
 * runs no statement timer of its own; the waiting apply keeps its unchanged
 * `1s` budget, which is why a caller releases as soon as
 * {@link blockedRequestPinCount} reports the pin rather than after any delay.
 */
export async function holdBrowserAuthorizationRequestRowLockFixture(args: {
  readonly requestToken: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedRequestPinCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [request] = await tx
      .select({ id: browserAuthorizationRequests.id })
      .from(browserAuthorizationRequests)
      .where(
        eq(
          browserAuthorizationRequests.requestTokenHash,
          requestTokenHash(args.requestToken),
        ),
      )
      .for("update")
      .limit(1);
    if (!request) {
      throw new Error("Expected the browser authorization request row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the authorization request lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedRequestPinCount: async () => {
      return await blockedRequestPinCount(holderPid);
    },
  };
}

/** The fenced transaction's first statement: the shared admission helper's
 * unlocked, content-free identity resolution. It is the only thread-bound read
 * that left-joins Agents, so it identifies the apply transaction itself. */
function isContentIdentityRead(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads" left join "agents"') &&
    text.includes('where "chat_threads"."id" =') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

/** The request revalidation that pins the row, before any content mutation. */
function isRequestPin(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "browser_authorization_requests"') &&
    text.includes("for no key update")
  );
}

/** The completion stamp, which is the last statement of the fenced write. */
function isCompletionUpdate(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("update") &&
    text.includes('"browser_authorization_requests" set "completed_at"')
  );
}

/**
 * Where the paused apply transaction stops. Both stops pause **after** their
 * statement has executed inside the still open transaction, which is the only
 * way to observe a lock the apply actually holds and a mutation that is applied
 * and not yet committed.
 *
 * `request-pin` stops with the request row revalidated and pinned and no
 * content written yet. `completion` stops with the thread update, the durable
 * sidebar sequence and event, and the completion stamp all executed and
 * uncommitted, which is the last point before the writer's own pre-`COMMIT`
 * cancellation check and therefore the last point at which a rollback is still
 * guaranteed.
 */
type BrowserAuthorizationApplyStop = "request-pin" | "completion";

/** Pauses the fenced browser-authorization apply opened for one thread. See
 * {@link withDatabaseTransactionBarrierFixture} for the mechanism and the
 * infrastructure exception it documents.
 */
export async function withBrowserAuthorizationApplyBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly stopAt: BrowserAuthorizationApplyStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs) => {
        return args.stopAt === "request-pin"
          ? isRequestPin(queryArgs)
          : isCompletionUpdate(queryArgs);
      },
      pauseAfter: true,
      work: args.work,
    },
    signal,
  );
}
