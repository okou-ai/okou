import { createHash, randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { browserAuthorizationRequests } from "@okouai/db/schema/browser-session";
import { count, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  createDeferredPromise,
  isAbortError,
  onRejection,
  settleIncludingAbort,
} from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type SelectedTransaction,
  type TransactionBarrier,
} from "./account-erasure-subject";

/** The same digest the service stores; the opaque token itself is never kept. */
function requestTokenHash(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

/**
 * Read-only fixture exception: creation deliberately has no production list
 * endpoint, so the exact row/hash/TTL and pre-commit visibility contract cannot
 * be observed through HTTP. This reads only the row addressed by the caller's
 * test-owned opaque token.
 */
export async function readBrowserAuthorizationRequestFixture(
  requestToken: string,
): Promise<{
  readonly id: string;
  readonly requestTokenHash: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly chatThreadId: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
} | null> {
  const [request] = await db()
    .select()
    .from(browserAuthorizationRequests)
    .where(
      eq(
        browserAuthorizationRequests.requestTokenHash,
        requestTokenHash(requestToken),
      ),
    )
    .limit(1);
  if (!request) {
    return null;
  }
  return {
    ...request,
    expiresAt: request.expiresAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

/** Counts only request rows produced from one test-owned run. */
export async function countBrowserAuthorizationRequestsFixture(
  runId: string,
): Promise<number> {
  const [result] = await db()
    .select({ value: count() })
    .from(browserAuthorizationRequests)
    .where(eq(browserAuthorizationRequests.runId, runId));
  return result?.value ?? 0;
}

async function expectOneRunIdentityUpdate(
  runId: string,
  values: Partial<typeof agentRuns.$inferInsert>,
): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set(values)
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one browser authorization run identity to move");
  }
}

/**
 * Infrastructure exceptions: no production API rewrites a run's captured
 * user/org/thread/trigger identity. These narrow mutations exercise the exact
 * non-key columns the retained FOR SHARE pin must freeze.
 */
export async function setBrowserAuthorizationRunUserFixture(
  runId: string,
  userId: string,
): Promise<void> {
  await expectOneRunIdentityUpdate(runId, { userId });
}

export async function setBrowserAuthorizationRunOrganizationFixture(
  runId: string,
  orgId: string,
): Promise<void> {
  await expectOneRunIdentityUpdate(runId, { orgId });
}

export async function setBrowserAuthorizationRunThreadFixture(
  runId: string,
  chatThreadId: string | null,
): Promise<void> {
  await expectOneRunIdentityUpdate(runId, { chatThreadId });
}

export async function setBrowserAuthorizationRunTriggerFixture(
  runId: string,
  triggerSource: string,
): Promise<void> {
  await expectOneRunIdentityUpdate(runId, { triggerSource });
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

/**
 * Holds the exact run row so creation waits on its retained FOR SHARE pin. The
 * observation methods bind both waits to real PostgreSQL blocker edges: first
 * holder -> creation, then creation -> a non-key thread identity mutation. The
 * second edge proves creation acquired its local thread SHARE before it waited
 * for the run instead of relying on the shared helper's weaker KEY SHARE.
 */
export async function holdBrowserAuthorizationCreationRunFixture(
  args: { readonly runId: string },
  signal: AbortSignal,
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedCreationRunPinCount: () => Promise<number>;
  readonly blockedThreadMutationCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .for("update");
    if (!run) {
      throw new Error("Expected the authorization creation run row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the creation run lock holder pid");
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
    blockedCreationRunPinCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_stat_activity AS creation
          WHERE ${holderPid} = ANY(pg_blocking_pids(creation.pid))
            AND lower(creation.query) LIKE '%from "agent_runs"%for share%'
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
    blockedThreadMutationCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_stat_activity AS creation
          JOIN pg_stat_activity AS mutation
            ON creation.pid = ANY(pg_blocking_pids(mutation.pid))
          WHERE ${holderPid} = ANY(pg_blocking_pids(creation.pid))
            AND lower(creation.query) LIKE '%from "agent_runs"%for share%'
            AND (
              lower(mutation.query) LIKE 'update "chat_threads" set "user_id"%'
              OR lower(mutation.query) LIKE 'update "chat_threads" set "agent_id"%'
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/** A stable digest safe to carry in a PostgreSQL trigger name. */
function authorizationRunDigest(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

/**
 * Makes only the test-owned run's request INSERT wait on a real PostgreSQL
 * advisory lock. A temporary BEFORE INSERT trigger compares NEW.run_id through
 * a digest embedded in its randomized name; unrelated workers execute the
 * predicate but never acquire this holder's lock. This is the narrow
 * infrastructure exception needed to fail the real INSERT after every
 * admission and identity pin without locking the shared request table.
 */
export async function holdBrowserAuthorizationRequestInsertFixture(
  args: { readonly runId: string },
  signal: AbortSignal,
): Promise<{
  readonly release: () => Promise<void>;
  readonly blockedRequestInsertCount: () => Promise<number>;
}> {
  const digest = authorizationRunDigest(args.runId);
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const triggerName = `barlock_${digest}_${nonce}`;
  const functionName = `test_browser_authorization_insert_lock_${nonce}`;
  const lockKey = `browser-authorization-request-insert:${digest}`;

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF substring(
             encode(
               sha256(convert_to(NEW.run_id::text, 'UTF8')),
               'hex'
             ) from 1 for 32
           ) = split_part(TG_NAME, '_', 2) THEN
          PERFORM pg_advisory_xact_lock(
            hashtextextended(
              'browser-authorization-request-insert:' ||
                split_part(TG_NAME, '_', 2),
              0
            )
          );
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(triggerName)}
      BEFORE INSERT ON browser_authorization_requests
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });

  let restored = false;
  const restore = async () => {
    if (restored) {
      return;
    }
    restored = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(triggerName)} ON browser_authorization_requests`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };

  onTestFinished(restore);
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const holding = onRejection(
    db().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      const pidRows = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS "pid"`,
        databasePidRowSchema,
      );
      const holderPid = pidRows[0]?.pid;
      if (!holderPid) {
        throw new Error("Expected the request INSERT lock holder pid");
      }
      started.resolve(holderPid);
      await released.promise;
    }),
    (error) => {
      if (!started.settled()) {
        started.reject(error);
      }
    },
  );
  const restoredHolding = onRejection(holding, restore);
  const finished = settleIncludingAbort(
    (async () => {
      await restoredHolding;
      await restore();
    })(),
  );
  const release = async () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
    const result = await finished;
    if (!result.ok && !(signal.aborted && isAbortError(result.error))) {
      throw result.error;
    }
  };
  onTestFinished(release);

  const holderPid = await started.promise;
  return {
    release,
    blockedRequestInsertCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
            AND lower(activity.query) LIKE 'insert into "browser_authorization_requests"%'
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/** The create command's unlocked locator query. */
function isCreationRunLocator(queryArgs: unknown[], runId: string): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "agent_runs"') &&
    text.includes('"chat_thread_id"') &&
    text.includes('"trigger_source"') &&
    !text.includes("for share") &&
    !text.includes("for key share") &&
    barrierQueryBinds(queryArgs, runId)
  );
}

/** The creation-only local thread upgrade, distinct from the shared helper's
 * earlier FOR KEY SHARE. Pausing before it exposes the exact stale-identity
 * window that its locked re-read closes. */
function isCreationThreadShare(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads"') &&
    text.includes("for share") &&
    !text.includes("for key share") &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

/** The exact original run's retained FOR SHARE pin. */
function isCreationRunPin(queryArgs: unknown[], runId: string): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "agent_runs"') &&
    text.includes("for share") &&
    !text.includes("for key share") &&
    barrierQueryBinds(queryArgs, runId)
  );
}

function isAuthorizationRequestInsert(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("insert into") &&
    text.includes('"browser_authorization_requests"')
  );
}

function tookCreationRunPin(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return (
      statement.includes('from "agent_runs"') &&
      statement.includes("for share") &&
      !statement.includes("for key share")
    );
  });
}

/**
 * Reliable creation boundaries. `locator`, `run-pin` and `insert` pause after
 * the real statement returned; `thread-share` pauses before dispatch so a
 * non-key thread identity mutation can commit under the shared helper's weaker
 * pin; `commit` is after the helper's final in-transaction abort check but
 * before the driver dispatches COMMIT.
 */
type BrowserAuthorizationCreateStop =
  | "locator"
  | "thread-share"
  | "run-pin"
  | "insert"
  | "commit";

export async function withBrowserAuthorizationCreateBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly runId: string;
    readonly stopAt: BrowserAuthorizationCreateStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return args.stopAt === "locator"
          ? isCreationRunLocator(queryArgs, args.runId)
          : isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs, selectingStatement, transaction) => {
        if (args.stopAt === "locator") {
          return selectingStatement;
        }
        if (args.stopAt === "thread-share") {
          return isCreationThreadShare(queryArgs, args.chatThreadId);
        }
        if (args.stopAt === "run-pin") {
          return isCreationRunPin(queryArgs, args.runId);
        }
        if (args.stopAt === "insert") {
          return isAuthorizationRequestInsert(queryArgs);
        }
        return (
          barrierQueryText(queryArgs) === "commit" &&
          tookCreationRunPin(transaction) &&
          transaction.statements.some((statement) => {
            return (
              statement.startsWith("insert into") &&
              statement.includes('"browser_authorization_requests"')
            );
          })
        );
      },
      pauseAfter:
        args.stopAt === "locator" ||
        args.stopAt === "run-pin" ||
        args.stopAt === "insert",
      work: args.work,
    },
    signal,
  );
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
