import {
  lockErasureSubjects,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import {
  computerUseCommands,
  computerUseCommandAuditEvents,
} from "@okouai/db/schema/computer-use-host";
import { count, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  acknowledgeDetachedForTest,
  createDeferredPromise,
  isAbortError,
  onRejection,
  settleIncludingAbort,
} from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

const databasePidRowSchema = z.object({ pid: z.number() });
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

interface ComputerUseCommandGetBarrier extends TransactionBarrier {
  /** Exact statements issued by the selected transaction, including control. */
  readonly statements: () => readonly string[];
}

type CommandGetStop = "maintenance" | "audit" | "projection" | "commit";

function firstCommandGetSubjectLock(
  queryArgs: unknown[],
  orgId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  const lockKey = `account-erasure:${JSON.stringify(["organization", orgId])}`;
  return (
    text.startsWith("select") &&
    text.includes("erasure_isolation_probe") &&
    text.includes("pg_advisory_xact_lock_shared") &&
    barrierQueryBinds(queryArgs, lockKey)
  );
}

function isCommandMaintenance(
  queryArgs: unknown[],
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_commands"') &&
    text.includes('"computer_use_commands"."org_id" =') &&
    text.includes('"computer_use_commands"."user_id" =') &&
    text.includes('"computer_use_commands"."status" =') &&
    text.includes("for update skip locked") &&
    barrierQueryBinds(queryArgs, args.orgId) &&
    barrierQueryBinds(queryArgs, args.userId)
  );
}

function isCommandAuditInsert(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith('insert into "computer_use_command_audit_events"') &&
    text.includes('"command_id"')
  );
}

function isCommandProjection(
  queryArgs: unknown[],
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly commandId: string;
    readonly hostId?: string;
  },
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "computer_use_commands"') &&
    text.includes('left join "computer_use_hosts"') &&
    text.includes('"computer_use_commands"."org_id" =') &&
    text.includes('"computer_use_commands"."user_id" =') &&
    text.includes('"computer_use_commands"."id" =') &&
    text.includes(" limit ") &&
    barrierQueryBinds(queryArgs, args.orgId) &&
    barrierQueryBinds(queryArgs, args.userId) &&
    barrierQueryBinds(queryArgs, args.commandId) &&
    (!args.hostId || barrierQueryBinds(queryArgs, args.hostId))
  );
}

/**
 * Infrastructure exception: no public API can pause one real command GET
 * transaction between admission, timeout maintenance, projection and COMMIT.
 * This fixture preserves every PostgreSQL statement and result while delaying
 * only the selected phase for lock-edge, rollback and SQL-control evidence.
 */
export async function withComputerUseCommandGetBarrierFixture<T>(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly commandId: string;
    readonly hostId?: string;
    readonly stopAt: CommandGetStop;
    readonly work: (barrier: ComputerUseCommandGetBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  let selectedReceiver: unknown;
  let selectedStatements: readonly string[] = [];
  const statementsByReceiver = new Map<unknown, string[]>();

  return await withDatabaseTransactionBarrierFixture(
    {
      observe: (queryArgs, receiver) => {
        const text = barrierQueryText(queryArgs);
        if (text.startsWith("begin")) {
          statementsByReceiver.set(receiver, [text]);
        } else {
          statementsByReceiver.get(receiver)?.push(text);
        }
        if (
          selectedReceiver === undefined &&
          firstCommandGetSubjectLock(queryArgs, args.orgId)
        ) {
          selectedReceiver = receiver;
        }
      },
      select: (queryArgs) => {
        return firstCommandGetSubjectLock(queryArgs, args.orgId);
      },
      stopAt: (queryArgs) => {
        const text = barrierQueryText(queryArgs);
        const stops =
          (args.stopAt === "maintenance" &&
            isCommandMaintenance(queryArgs, args)) ||
          (args.stopAt === "audit" && isCommandAuditInsert(queryArgs)) ||
          (args.stopAt === "projection" &&
            isCommandProjection(queryArgs, args)) ||
          (args.stopAt === "commit" && text === "commit");
        if (stops) {
          selectedStatements = [
            ...(statementsByReceiver.get(selectedReceiver) ?? [text]),
          ];
        }
        return stops;
      },
      pauseAfter:
        args.stopAt === "maintenance" ||
        args.stopAt === "audit" ||
        args.stopAt === "projection",
      work: async (barrier) => {
        return await args.work({
          ...barrier,
          statements: () => {
            return selectedStatements;
          },
        });
      },
    },
    signal,
  );
}

/**
 * Pauses the existing completion path after its real command FOR UPDATE. The
 * command row and host row remain locked by that production transaction while
 * a GET exercises its unchanged SKIP LOCKED maintenance behavior.
 */
export async function withComputerUseCompletionLockBarrierFixture<T>(
  args: {
    readonly commandId: string;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        const text = barrierQueryText(queryArgs);
        return (
          text.startsWith("select") &&
          text.includes('from "computer_use_commands"') &&
          text.includes("for update") &&
          !text.includes("skip locked") &&
          barrierQueryBinds(queryArgs, args.commandId)
        );
      },
      stopAt: (_queryArgs, selectingStatement) => {
        return selectingStatement;
      },
      pauseAfter: true,
      work: args.work,
    },
    signal,
  );
}

/**
 * Infrastructure exception: no public API exposes an open exclusive B1 lock
 * without also projecting a closure. The after-wait clock control needs exactly
 * that content-free state so releasing the holder still admits the GET.
 */
export async function holdOpenErasureSubjectLockFixture(args: {
  readonly subject: ErasureSubject;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<
    | { readonly ok: true; readonly holderPid: number }
    | { readonly ok: false; readonly error: unknown }
  >(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const setup = settleIncludingAbort(started.promise);
  acknowledgeDetachedForTest(started.promise);
  const holding = onRejection(
    db().transaction(
      async (tx) => {
        await lockErasureSubjects(tx, [args.subject]);
        const pids = await executeRawRows(
          tx,
          sql`SELECT pg_backend_pid() AS "pid"`,
          databasePidRowSchema,
        );
        const holderPid = pids[0]?.pid;
        if (!holderPid) {
          throw new Error("Expected the B1 holder backend pid");
        }
        started.resolve({ ok: true, holderPid });
        await released.promise;
      },
      { isolationLevel: "read committed" },
    ),
    (error) => {
      if (!started.settled()) {
        started.resolve({ ok: false, error });
      }
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  );
  const finished = settleIncludingAbort(holding);
  const release = async () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
    const result = await finished;
    if (!result.ok && !(args.signal.aborted && isAbortError(result.error))) {
      throw result.error;
    }
  };
  const setupResult = await setup;
  if (!setupResult.ok) {
    await finished;
    throw setupResult.error;
  }
  if (!setupResult.value.ok) {
    await finished;
    throw setupResult.value.error;
  }
  const holderPid = setupResult.value.holderPid;
  onTestFinished(release);
  return {
    release,
    blockedWaiterCount: async () => {
      return await blockedWaiterCount(holderPid);
    },
  };
}

/**
 * Infrastructure exception: production creation materializes the API's 60s
 * default, while timeout maintenance retains a 120s fallback for legacy NULL
 * rows. This inserts that retained shape and observes it through real routes.
 */
export async function createRunningComputerUseCommandFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
  readonly createdAt: Date;
  readonly claimedAt: Date;
}): Promise<{ readonly commandId: string }> {
  const [created] = await db()
    .insert(computerUseCommands)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      hostId: args.hostId,
      kind: "app.open",
      status: "running",
      payload: { app: "Safari" },
      timeoutMs: null,
      createdAt: args.createdAt,
      claimedAt: args.claimedAt,
      updatedAt: args.claimedAt,
    })
    .returning({ id: computerUseCommands.id });
  if (!created) {
    throw new Error("Expected the running Computer Use command fixture");
  }
  onTestFinished(async () => {
    await db()
      .delete(computerUseCommandAuditEvents)
      .where(eq(computerUseCommandAuditEvents.commandId, created.id));
    await db()
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.id, created.id));
  });
  return { commandId: created.id };
}

/**
 * Infrastructure exception: current creation always binds an online host, so
 * the schema's retained nullable host/name response cannot be constructed by a
 * production caller. The response itself is still observed through the real
 * authenticated GET and this exact test-owned row is removed at teardown.
 */
export async function createNullableComputerUseCommandFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly createdAt: Date;
}): Promise<{ readonly commandId: string }> {
  const [created] = await db()
    .insert(computerUseCommands)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      hostId: null,
      kind: "apps.list",
      status: "queued",
      payload: { app: "Finder", text: "fixture 中文🙂" },
      timeoutMs: null,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .returning({ id: computerUseCommands.id });
  if (!created) {
    throw new Error("Expected the nullable Computer Use command fixture");
  }
  onTestFinished(async () => {
    await db()
      .delete(computerUseCommandAuditEvents)
      .where(eq(computerUseCommandAuditEvents.commandId, created.id));
    await db()
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.id, created.id));
  });
  return { commandId: created.id };
}
