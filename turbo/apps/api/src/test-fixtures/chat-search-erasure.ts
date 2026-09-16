import { randomUUID } from "node:crypto";

import {
  projectErasureDecision,
  type ErasureDecision,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { count, eq, inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import { z } from "zod";

import { closeDbPool, db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import type { Tx } from "../lib/db-types";
import { nowDate } from "../lib/time";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

const pidRowSchema = z.object({ pid: z.number() });
const waiterCountRowSchema = z.object({ waiterCount: z.number() });

async function backendPid(tx: Tx): Promise<number> {
  const rows = await executeRawRows(
    tx,
    sql`SELECT pg_backend_pid() AS "pid"`,
    pidRowSchema,
  );
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("Expected a chat search erasure fixture backend pid");
  }
  return pid;
}

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
export async function closeChatSearchErasureSubjectFixture(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const job = await projectErasureDecision(db(), erasureDecision(subject));
  return { jobId: job.id };
}

/** Removes only the dormant jobs a test created, so later suites see no
 * closure. This is fixture teardown, not an erasure or recovery operation.
 */
export async function removeChatSearchErasureSubjectsFixture(
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0) {
    return;
  }
  await db()
    .delete(accountErasureJobs)
    .where(inArray(accountErasureJobs.id, [...jobIds]));
}

/**
 * Holds one uncommitted closure so a test can observe whether an ordinary
 * writer's shared admission really conflicts with it. Product APIs cannot pause
 * between B1's exclusive subject lock and its commit.
 */
export async function holdChatSearchErasureClosureFixture(args: {
  readonly subject: ErasureSubject;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => Promise<void>;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const jobIds: string[] = [];
  const done = db().transaction(async (tx) => {
    const job = await projectErasureDecision(tx, erasureDecision(args.subject));
    jobIds.push(job.id);
    started.resolve(await backendPid(tx));
    await released.promise;
  });
  const holderPid = await started.promise;
  const release = async () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
    await done;
    await removeChatSearchErasureSubjectsFixture(jobIds);
  };
  return {
    release,
    done,
    blockedWaiterCount: async () => {
      return await blockedWaiterCount(holderPid);
    },
  };
}

/**
 * Holds one Agent identity row so a test can place an owner transfer exactly
 * inside the projector's lock wait. Product APIs neither pause while holding
 * this row nor reassign `agents.owner`, so the transfer models the writer a
 * future ownership move would use.
 */
export async function holdChatSearchAgentRowLockFixture(args: {
  readonly agentId: string;
  readonly transferOwnerTo?: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => Promise<void>;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, args.agentId))
      .for("update");
    if (!locked) {
      throw new Error("Expected the chat search fixture Agent row");
    }
    started.resolve(await backendPid(tx));
    await released.promise;
    if (args.transferOwnerTo !== undefined) {
      await tx
        .update(agents)
        .set({ owner: args.transferOwnerTo })
        .where(eq(agents.id, args.agentId));
    }
  });
  const holderPid = await started.promise;
  return {
    release: async () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
      await done;
    },
    done,
    blockedWaiterCount: async () => {
      return await blockedWaiterCount(holderPid);
    },
  };
}

/** Moves one thread to another user and Agent, the change a future ownership
 * transfer would persist. No production writer updates these columns today.
 */
export async function transferChatSearchThreadFixture(args: {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({ userId: args.userId, agentId: args.agentId })
    .where(eq(chatThreads.id, args.chatThreadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat search thread to transfer");
  }
}

function barrierQueryText(queryArgs: unknown[]): string {
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

function isProjectionWatermarkWrite(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  const values = z.array(z.unknown()).safeParse(queryArgs[1]);
  return (
    text.startsWith("insert") &&
    text.includes('"chat_event_search_message_watermarks"') &&
    values.success &&
    values.data.includes(chatThreadId)
  );
}

/**
 * Infrastructure exception: no API can delay delivery of a real COMMIT, and the
 * projector's per-thread transaction is the only place its retained barriers can
 * be observed from another session. Every original query still executes
 * unchanged; only the selected transaction's COMMIT waits, and only for the
 * thread this test owns. Nothing is mocked and no result or error is replaced.
 *
 * Pausing at COMMIT, rather than at a statement, keeps the projector's own lock
 * and statement deadlines out of the observation window.
 */
export async function withChatSearchProjectionCommitBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly work: (barrier: {
      readonly entered: Promise<{
        readonly pid: number;
        readonly lockTimeout: string;
        readonly statementTimeout: string;
      }>;
      readonly release: () => void;
    }) => Promise<T>;
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
      if (!paused && isProjectionWatermarkWrite(queryArgs, args.chatThreadId)) {
        selected = receiver;
      }
      if (
        barrierQueryText(queryArgs) !== "commit" ||
        receiver !== selected ||
        paused
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
          throw new Error("Expected the chat search barrier settings row");
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
    args.work({ entered: entered.promise, release }),
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

/** Observes whether a specific backend is currently blocked by the paused
 * projector transaction, so tests never guess at timing with a sleep.
 */
export async function chatSearchBarrierBlockedWaiterCountFixture(
  holderPid: number,
): Promise<number> {
  return await blockedWaiterCount(holderPid);
}
