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

/** Moves one Agent into another organization, the other half of the ownership
 * change its composite `(id, org_id, owner)` key exists to detect. No
 * production writer updates this column today either.
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

export interface TransactionBarrier {
  readonly entered: Promise<{
    readonly lockTimeout: string;
    readonly statementTimeout: string;
  }>;
  /** Backends currently blocked by the paused transaction, so a test never
   * guesses at timing with a sleep. */
  readonly blockedWaiterCount: () => Promise<number>;
  readonly release: () => void;
}

/**
 * Infrastructure exception: no API can suspend a real transaction between its
 * statements, and a fenced writer's own transaction is the only place its
 * statement ordering and retained barriers can be observed from another
 * session. Every original query still executes unchanged and in order; only the
 * transaction `select` identifies waits, at one chosen point. Nothing is mocked
 * and no result or error is replaced.
 *
 * The pause always happens before the chosen statement is dispatched, so no
 * server-side lock or statement timer runs during the observation window and a
 * test never has to win the writer's own bounded budget.
 *
 * `select` recognizes the target transaction from a statement only it issues;
 * `stopAt` then chooses where that transaction pauses, and receives whether the
 * current statement is the selecting one so a caller can stop there.
 */
export async function withDatabaseTransactionBarrierFixture<T>(
  args: {
    readonly select: (queryArgs: unknown[]) => boolean;
    readonly stopAt: (
      queryArgs: unknown[],
      selectingStatement: boolean,
    ) => boolean;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  await closeDbPool();
  signal.throwIfAborted();
  const entered = createDeferredPromise<{
    readonly pid: number;
    readonly lockTimeout: string;
    readonly statementTimeout: string;
  }>(signal);
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
  let paused = false;
  Client.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const selectingStatement = args.select(queryArgs);
      if (!paused && selectingStatement) {
        selected = receiver;
      }
      if (
        paused ||
        receiver !== selected ||
        !args.stopAt(queryArgs, selectingStatement)
      ) {
        return Reflect.apply(target, receiver, queryArgs);
      }
      paused = true;
      return (async () => {
        const settings: unknown = await Reflect.apply(target, receiver, [
          "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout",
        ]);
        const row = z
          .object({
            rows: z
              .array(
                z.object({
                  pid: z.number(),
                  lock_timeout: z.string(),
                  statement_timeout: z.string(),
                }),
              )
              .length(1),
          })
          .parse(settings).rows[0];
        if (!row) {
          throw new Error("Expected the transaction barrier settings row");
        }
        entered.resolve({
          pid: row.pid,
          lockTimeout: row.lock_timeout,
          statementTimeout: row.statement_timeout,
        });
        await released.promise;
        return await Reflect.apply(target, receiver, queryArgs);
      })();
    },
  });
  const result = await settleIncludingAbort(
    args.work({
      entered: entered.promise,
      blockedWaiterCount: blocked,
      release,
    }),
  );
  release();
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
