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
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

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
    /**
     * Rows the chosen statement itself reported. It carries a number only in
     * `pauseAfter` mode, where that statement has already run inside the still
     * open transaction, and is `null` when the barrier pauses before dispatch.
     */
    readonly rowCount: number | null;
  }>;
  /** Backends currently blocked by the paused transaction, so a test never
   * guesses at timing with a sleep. */
  readonly blockedWaiterCount: () => Promise<number>;
  /** Every statement this exact transaction has issued so far, in order,
   * including the ones after the barrier released. A test that needs to prove
   * what actually ran — rather than infer it from unchanged final state — reads
   * this instead of guessing from the outcome. The barrier's own settings probe
   * bypasses the proxy, so it never appears here. */
  readonly statements: () => readonly string[];
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

/**
 * Infrastructure exception: no API can suspend a real transaction between its
 * statements, and a fenced writer's own transaction is the only place its
 * statement ordering and retained barriers can be observed from another
 * session. Every original query still executes unchanged and in order; only the
 * transaction `select` identifies waits, at one chosen point. Nothing is mocked
 * and no result or error is replaced.
 *
 * By default the pause happens before the chosen statement is dispatched. With
 * `pauseAfter` that statement runs first and the transaction pauses holding its
 * result, which is the only way to observe a mutation that is applied and still
 * uncommitted, and the only boundary at which a writer's own post-write
 * cancellation check has not run yet. Either way the backend is idle inside its
 * transaction for the whole window, so no lock or statement timer is running
 * and a test never has to win the writer's own bounded budget. `pauseAfter`
 * does retain the executed statement's row locks, so a concurrent writer to the
 * same row waits; a plain reader is unaffected.
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
  args: {
    readonly select: (queryArgs: unknown[]) => boolean;
    readonly stopAt: (
      queryArgs: unknown[],
      selectingStatement: boolean,
      transaction: SelectedTransaction,
    ) => boolean;
    readonly pauseAfter?: boolean;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarriersFixture(
    {
      transactions: 1,
      select: args.select,
      stopAt: (queryArgs, selectingStatement, transaction) => {
        return args.stopAt(queryArgs, selectingStatement, transaction);
      },
      pauseAfter: () => {
        return args.pauseAfter === true;
      },
      work: async ([barrier]) => {
        if (!barrier) {
          throw new Error("Expected one transaction barrier");
        }
        return await args.work(barrier);
      },
    },
    signal,
  );
}

interface BarrierSlot {
  receiver: unknown;
  statements: string[];
  paused: boolean;
  readonly entered: ReturnType<
    typeof createDeferredPromise<{
      readonly pid: number;
      readonly lockTimeout: string;
      readonly statementTimeout: string;
      readonly rowCount: number | null;
    }>
  >;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
}

const BARRIER_SETTINGS_QUERY =
  "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout";

const barrierSettingsSchema = z.object({
  rows: z
    .array(
      z.object({
        pid: z.number(),
        lock_timeout: z.string(),
        statement_timeout: z.string(),
      }),
    )
    .length(1),
});

/**
 * Reads the paused transaction's backend pid and its live deadlines through the
 * original driver method, reports them together with the row count the stopped
 * statement produced in `pauseAfter` mode, waits for the release, and finally
 * returns the statement's result. Splitting this out keeps the proxy handler
 * small enough to read in one screen.
 */
function pauseBarrierSlot(
  slot: BarrierSlot,
  target: typeof Client.prototype.query,
  receiver: unknown,
  queryArgs: unknown[],
  pauseAfter: boolean,
): Promise<unknown> {
  return (async () => {
    const executed: unknown = pauseAfter
      ? await Reflect.apply(target, receiver, queryArgs)
      : undefined;
    const settings: unknown = await Reflect.apply(target, receiver, [
      BARRIER_SETTINGS_QUERY,
    ]);
    const row = barrierSettingsSchema.parse(settings).rows[0];
    if (!row) {
      throw new Error("Expected the transaction barrier settings row");
    }
    slot.entered.resolve({
      pid: row.pid,
      lockTimeout: row.lock_timeout,
      statementTimeout: row.statement_timeout,
      rowCount: pauseAfter ? pausedRowCount(executed) : null,
    });
    await slot.released.promise;
    return pauseAfter
      ? executed
      : await Reflect.apply(target, receiver, queryArgs);
  })();
}

/**
 * The same infrastructure exception for more than one transaction at a time,
 * and the single implementation the one-transaction form above delegates to.
 *
 * A candidate is bound to the pooled connection that issued its selecting
 * statement, which is the transaction's identity: a statement is attributed to
 * a barrier only when it runs on that exact connection, never by matching a
 * thread id that several readers and writers share. A caller that starts one
 * request, awaits its barrier and only then starts the next therefore binds
 * each barrier to an exact HTTP request.
 *
 * Slots are claimed in index order, `stopAt` and `pauseAfter` receive the slot
 * index so two writers of the same row can pause at two different statements in
 * two different modes, and every barrier pauses at most once. A candidate that
 * reaches `COMMIT` or `ROLLBACK` without satisfying its `stopAt` frees its slot
 * for the next candidate.
 */
export async function withDatabaseTransactionBarriersFixture<T>(
  args: {
    readonly transactions: number;
    readonly select: (queryArgs: unknown[]) => boolean;
    readonly stopAt: (
      queryArgs: unknown[],
      selectingStatement: boolean,
      transaction: SelectedTransaction,
      index: number,
    ) => boolean;
    readonly pauseAfter?: (index: number) => boolean;
    readonly work: (barriers: readonly TransactionBarrier[]) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  await closeDbPool();
  signal.throwIfAborted();
  const slots: BarrierSlot[] = Array.from(
    { length: args.transactions },
    (): BarrierSlot => {
      return {
        receiver: undefined,
        statements: [],
        paused: false,
        entered: createDeferredPromise<{
          readonly pid: number;
          readonly lockTimeout: string;
          readonly statementTimeout: string;
          readonly rowCount: number | null;
        }>(signal),
        released: createDeferredPromise<void>(signal),
      };
    },
  );
  const releaseSlot = (slot: BarrierSlot) => {
    if (!slot.released.settled()) {
      slot.released.resolve();
    }
  };
  const original = Client.prototype.query;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const selectingStatement = args.select(queryArgs);
      let index = slots.findIndex((slot) => {
        return slot.receiver !== undefined && slot.receiver === receiver;
      });
      if (index === -1 && selectingStatement) {
        index = slots.findIndex((slot) => {
          return slot.receiver === undefined;
        });
        const claimed = index === -1 ? undefined : slots[index];
        if (claimed) {
          claimed.receiver = receiver;
          claimed.statements = [];
        }
      }
      const slot = index === -1 ? undefined : slots[index];
      if (!slot) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      const text = barrierQueryText(queryArgs);
      if (slot.paused) {
        // Past its stop, this transaction keeps recording so a test can assert
        // what really executed after the release and how it terminated.
        slot.statements.push(text);
        return Reflect.apply(target, receiver, queryArgs);
      }
      if (
        !args.stopAt(
          queryArgs,
          selectingStatement,
          { statements: slot.statements },
          index,
        )
      ) {
        slot.statements.push(text);
        if (text === "commit" || text === "rollback") {
          // This candidate finished without ever reaching the requested stop,
          // so it was not the transaction this slot meant.
          slot.receiver = undefined;
          slot.statements = [];
        }
        return Reflect.apply(target, receiver, queryArgs);
      }
      slot.paused = true;
      slot.statements.push(text);
      return pauseBarrierSlot(
        slot,
        target,
        receiver,
        queryArgs,
        args.pauseAfter?.(index) === true,
      );
    },
  });
  const result = await settleIncludingAbort(
    args.work(
      slots.map((slot): TransactionBarrier => {
        return {
          entered: slot.entered.promise,
          blockedWaiterCount: async () => {
            return await blockedWaiterCount((await slot.entered.promise).pid);
          },
          statements: () => {
            return [...slot.statements];
          },
          release: () => {
            releaseSlot(slot);
          },
        };
      }),
    ),
  );
  for (const slot of slots) {
    releaseSlot(slot);
  }
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
