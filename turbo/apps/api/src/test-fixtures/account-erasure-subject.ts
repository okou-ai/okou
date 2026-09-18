import { randomUUID } from "node:crypto";

import {
  projectErasureDecision,
  type ErasureDecision,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { count, eq, inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import { z } from "zod";

import { closeDbPool, db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { nowDate } from "../lib/time";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
  detach,
  Mechanism,
  settleIncludingAbort,
} from "../signals/utils";

const waiterCountRowSchema = z.object({ waiterCount: z.number() });

async function blockedWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

function erasureDecision(subject: ErasureSubject): ErasureDecision {
  return {
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId,
    generation: 1,
    authorityId: randomUUID(),
    decisionRef: randomUUID(),
    decisionSequence: 1n,
    confirmationRef: randomUUID(),
    previousDecisionRef: null,
    dispositionVersion: 1,
    requestedAt: nowDate(),
    deadlineAt: new Date("2099-01-01T00:00:00Z"),
  };
}

/**
 * Infrastructure exception: B1 registers no production closure ingress, so a
 * closed subject cannot be constructed through any API. This projects one
 * dormant decision for a subject this test owns. It activates no worker,
 * collector or authority, and removes nothing.
 */
export async function closeErasureSubjectFixture(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const job = await projectErasureDecision(db(), erasureDecision(subject));
  return { jobId: job.id };
}

/** Removes only the dormant jobs a test created, so later suites see no
 * closure. This is fixture teardown, not an erasure or recovery operation.
 */
export async function removeErasureSubjectsFixture(
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0) {
    return;
  }
  await db()
    .delete(accountErasureJobs)
    .where(inArray(accountErasureJobs.id, [...jobIds]));
}

/** Reassigns one Agent's owner, the change a future ownership transfer would
 * persist. No production writer updates this column today, and the unique
 * `(id, org_id, owner)` key makes it the key update a content writer's KEY
 * SHARE is meant to conflict with.
 */
export async function transferAgentOwnerFixture(args: {
  readonly agentId: string;
  readonly owner: string;
}): Promise<void> {
  const updated = await db()
    .update(agents)
    .set({ owner: args.owner })
    .where(eq(agents.id, args.agentId))
    .returning({ id: agents.id });
  if (updated.length !== 1) {
    throw new Error("Expected one Agent owner to transfer");
  }
}

/** Reassigns one Agent's organization, the other half of the same unique
 * `(id, org_id, owner)` key. No production writer updates this column today,
 * and it is the canonical parent a read-cursor publication targets, so moving
 * it is the change a writer's retained KEY SHARE must turn into a reselection
 * instead of a stale-organization notification.
 */
export async function transferAgentOrganizationFixture(args: {
  readonly agentId: string;
  readonly orgId: string;
}): Promise<void> {
  const updated = await db()
    .update(agents)
    .set({ orgId: args.orgId })
    .where(eq(agents.id, args.agentId))
    .returning({ id: agents.id });
  if (updated.length !== 1) {
    throw new Error("Expected one Agent organization to transfer");
  }
}

export function barrierQueryText(queryArgs: unknown[]): string {
  const parsed = z
    .union([z.string(), z.object({ text: z.string() })])
    .safeParse(queryArgs[0]);
  if (!parsed.success) {
    return "";
  }
  return (
    typeof parsed.data === "string" ? parsed.data : parsed.data.text
  ).toLowerCase();
}

export function barrierQueryBinds(
  queryArgs: unknown[],
  value: string,
): boolean {
  const values = z.array(z.unknown()).safeParse(queryArgs[1]);
  return values.success && values.data.includes(value);
}

/**
 * The statements the currently selected transaction has already issued, in
 * order. A thread id alone cannot identify a transaction when several of them
 * read the same thread, so `stopAt` uses this to recognize the phase it wants —
 * for example a transaction that has already taken a `FOR KEY SHARE` lock is
 * the writer, not the read-only gate that precedes it.
 */
export interface SelectedTransaction {
  readonly statements: readonly string[];
}

export interface TransactionBarrier {
  readonly entered: Promise<{
    readonly lockTimeout: string;
    readonly statementTimeout: string;
    readonly transactionTimeout: string;
    /**
     * Rows the chosen statement itself reported. It carries a number only in
     * `pauseAfter` mode, where that statement has already run (and its
     * transaction remains open when it has one), and is `null` when the barrier
     * pauses before dispatch.
     */
    readonly rowCount: number | null;
  }>;
  /** Backends currently blocked by the paused backend, so a test never guesses
   * at timing with a sleep. */
  readonly blockedWaiterCount: () => Promise<number>;
  /** Whether the selected statement was ever reached. */
  readonly enteredYet: () => boolean;
  readonly release: () => void;
}

/** The row count `pg` reports for an executed statement. */
function pausedRowCount(executed: unknown): number {
  const parsed = z.object({ rowCount: z.number() }).safeParse(executed);
  if (!parsed.success) {
    throw new Error(
      "Expected the paused statement result to carry a row count",
    );
  }
  return parsed.data.rowCount;
}

interface TransactionBarrierEntry {
  readonly pid: number;
  readonly lockTimeout: string;
  readonly statementTimeout: string;
  readonly transactionTimeout: string;
  readonly rowCount: number | null;
}

interface TransactionBarrierEntryDeferred {
  readonly resolve: (entry: TransactionBarrierEntry) => void;
  readonly reject: (reason?: unknown) => void;
  readonly settled: () => boolean;
}

function settleOwnedBarrierEntry<T>(promise: Promise<T>) {
  acknowledgeDetachedForTest(promise);
  return settleIncludingAbort(promise);
}

function selectedBarrierQuery(
  args: {
    readonly select: (queryArgs: unknown[]) => boolean;
    readonly observe?: (queryArgs: unknown[], receiver: unknown) => void;
  },
  queryArgs: unknown[],
  receiver: unknown,
): boolean {
  args.observe?.(queryArgs, receiver);
  return args.select(queryArgs);
}

const transactionBarrierSettingsSchema = z.object({
  rows: z
    .array(
      z.object({
        pid: z.number(),
        lock_timeout: z.string(),
        statement_timeout: z.string(),
        transaction_timeout: z.string(),
      }),
    )
    .length(1),
});

async function readTransactionBarrierSettings(
  execute: (queryArgs: unknown[]) => unknown,
): Promise<{
  readonly pid: number;
  readonly lockTimeout: string;
  readonly statementTimeout: string;
  readonly transactionTimeout: string;
}> {
  const settings = await execute([
    "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout, current_setting('transaction_timeout') AS transaction_timeout",
  ]);
  const row = transactionBarrierSettingsSchema.parse(settings).rows[0];
  if (!row) {
    throw new Error("Expected the transaction barrier settings row");
  }
  return {
    pid: row.pid,
    lockTimeout: row.lock_timeout,
    statementTimeout: row.statement_timeout,
    transactionTimeout: row.transaction_timeout,
  };
}

async function deliverPausedCallbackQuery(args: {
  readonly completion: (...callbackArgs: unknown[]) => unknown;
  readonly receiver: unknown;
  readonly callbackArgs: unknown[];
  readonly execute: (queryArgs: unknown[]) => unknown;
  readonly entered: TransactionBarrierEntryDeferred;
  readonly released: Promise<void>;
  readonly release: () => void;
}): Promise<void> {
  const paused = await settleIncludingAbort(
    (async () => {
      const queryError = args.callbackArgs[0];
      if (queryError) {
        throw queryError;
      }
      const settings = await readTransactionBarrierSettings(args.execute);
      args.entered.resolve({
        ...settings,
        rowCount: pausedRowCount(args.callbackArgs[1]),
      });
      await args.released;
    })(),
  );
  if (!paused.ok) {
    if (!args.entered.settled()) {
      args.entered.reject(paused.error);
    }
    args.release();
    Reflect.apply(args.completion, args.receiver, [paused.error]);
    return;
  }
  Reflect.apply(args.completion, args.receiver, args.callbackArgs);
}

interface DatabaseTransactionBarrierFixtureArgs<T> {
  readonly select: (queryArgs: unknown[]) => boolean;
  readonly stopAt: (
    queryArgs: unknown[],
    selectingStatement: boolean,
    transaction: SelectedTransaction,
  ) => boolean;
  readonly pauseAfter?: boolean;
  /** Observes unchanged driver calls for focused SQL/control accounting. */
  readonly observe?: (queryArgs: unknown[], receiver: unknown) => void;
  readonly work: (barrier: TransactionBarrier) => Promise<T>;
}

/**
 * Infrastructure exception: no API can suspend a real transaction between its
 * statements, and a fenced writer's own transaction is the only place its
 * statement ordering and retained barriers can be observed from another
 * session. Every original query still executes unchanged and in order; only the
 * caller's `select` predicate identifies one backend and statement. Nothing is
 * mocked and no result or error is replaced.
 *
 * By default the pause happens before the chosen statement is dispatched. With
 * `pauseAfter` that statement runs first and the barrier pauses holding its
 * result, which is the only way to observe a mutation that is applied and still
 * uncommitted, and the only boundary at which a writer's own post-write
 * cancellation check has not run yet. For node-postgres's callback-based
 * `Pool.query` path, it delays only delivery of the already executed result
 * while the checked-out client remains idle; this exposes an unlocked locator
 * window without pretending the locator retained a transaction lock. Either
 * way no lock or statement timer is actively running during the pause, so a
 * test never has to win the writer's own bounded budget. When the selected
 * statement belongs to a transaction, `pauseAfter` retains its row locks, so a
 * concurrent writer to the same row waits; a plain reader is unaffected.
 *
 * `select` recognizes a candidate transaction from a statement it issues;
 * `stopAt` then chooses where that candidate pauses, and receives whether the
 * current statement is the selecting one so a caller can stop there, plus the
 * statements that candidate has already issued so it can require a phase.
 *
 * A candidate that reaches `COMMIT` or `ROLLBACK` without ever satisfying
 * `stopAt` was not the transaction the caller meant: the latch is released and
 * the next candidate is considered. Several transactions legitimately read the
 * same row — an admission gate commits before the writer it precedes — so
 * latching the first one permanently either pauses the wrong transaction or
 * waits forever for a stop it will never reach.
 */
export async function withDatabaseTransactionBarrierFixture<T>(
  args: DatabaseTransactionBarrierFixtureArgs<T>,
  signal: AbortSignal,
): Promise<T> {
  await closeDbPool();
  signal.throwIfAborted();
  const entered = createDeferredPromise<{
    readonly pid: number;
    readonly lockTimeout: string;
    readonly statementTimeout: string;
    readonly transactionTimeout: string;
    readonly rowCount: number | null;
  }>(signal);
  // Own the entry promise even for negative observations where the selected
  // statement correctly never starts before `work` returns.
  const enteredSettlement = settleOwnedBarrierEntry(entered.promise);
  const blocked = async () => {
    return await blockedWaiterCount((await entered.promise).pid);
  };
  const released = createDeferredPromise<void>(signal);
  const release = () => {
    if (!released.settled()) {
      released.resolve();
    }
  };
  const original = Client.prototype.query;
  let selected: unknown;
  let statements: string[] = [];
  let paused = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const selectingStatement = selectedBarrierQuery(
        args,
        queryArgs,
        receiver,
      );
      if (!paused && selectingStatement && selected === undefined) {
        selected = receiver;
        statements = [];
      }
      if (paused || receiver !== selected) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      const text = barrierQueryText(queryArgs);
      if (!args.stopAt(queryArgs, selectingStatement, { statements })) {
        statements.push(text);
        if (text === "commit" || text === "rollback") {
          // This candidate finished without ever reaching the requested stop,
          // so it was not the target transaction.
          selected = undefined;
          statements = [];
        }
        return Reflect.apply(target, receiver, queryArgs);
      }
      paused = true;
      const lastQueryArgIndex = queryArgs.length - 1;
      const callbackIndex =
        args.pauseAfter && typeof queryArgs[lastQueryArgIndex] === "function"
          ? lastQueryArgIndex
          : -1;
      const execute = (selectedQueryArgs: unknown[]) => {
        return Reflect.apply(target, receiver, selectedQueryArgs);
      };
      if (callbackIndex >= 0) {
        const selectedCompletion = queryArgs[callbackIndex];
        if (typeof selectedCompletion !== "function") {
          throw new Error("Expected the selected query callback");
        }
        const completion = selectedCompletion as (
          ...callbackArgs: unknown[]
        ) => unknown;
        const interceptedArgs = [...queryArgs];
        interceptedArgs[callbackIndex] = (...callbackArgs: unknown[]) => {
          detach(
            deliverPausedCallbackQuery({
              completion,
              receiver,
              callbackArgs,
              execute,
              entered,
              released: released.promise,
              release,
            }),
            Mechanism.Deferred,
            "database transaction barrier callback delivery",
          );
        };
        return execute(interceptedArgs);
      }
      return (async () => {
        const executed: unknown = args.pauseAfter
          ? await execute(queryArgs)
          : undefined;
        const settings = await readTransactionBarrierSettings(execute);
        entered.resolve({
          ...settings,
          rowCount: args.pauseAfter ? pausedRowCount(executed) : null,
        });
        await released.promise;
        return args.pauseAfter ? executed : await execute(queryArgs);
      })();
    },
  });
  const result = await settleIncludingAbort(
    args.work({
      entered: entered.promise,
      blockedWaiterCount: blocked,
      enteredYet: entered.settled,
      release,
    }),
  );
  if (!entered.settled()) {
    entered.reject(new Error("Selected transaction statement was not reached"));
  }
  release();
  await enteredSettlement;
  const closed = await settleIncludingAbort(closeDbPool());
  Client.prototype.query = original;
  if (!result.ok) {
    throw result.error;
  }
  if (!closed.ok) {
    throw closed.error;
  }
  return result.value;
}

/**
 * Pauses a real first-closure transaction at COMMIT after its job INSERT and
 * exclusive subject advisory lock. B1 has no production closure ingress, so a
 * route test cannot otherwise prove that an ordinary writer waits, then starts
 * a new READ COMMITTED closure lookup after the decision becomes visible.
 */
export async function withErasureSubjectClosureCommitBarrierFixture<T>(
  work: (barrier: TransactionBarrier) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        const text = barrierQueryText(queryArgs);
        return (
          text.startsWith("insert into") &&
          text.includes('"account_erasure_jobs"')
        );
      },
      stopAt: (queryArgs) => {
        return barrierQueryText(queryArgs) === "commit";
      },
      work,
    },
    signal,
  );
}
