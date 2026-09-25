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

/**
 * Infrastructure exception: no public API exposes an open exclusive B1 lock
 * without also projecting a closure. The after-wait clock control needs exactly
 * that content-free state so releasing the holder still admits the GET.
 */
export async function holdOpenErasureSubjectLockFixture(args: {
  readonly subject: ErasureSubject;
  readonly signal: AbortSignal;
  /**
   * Infrastructure-only readiness control. No production API can pause or fail
   * this content-free holder after its real B1 lock and backend lookup.
   */
  readonly beforeReady?: (holderPid: number) => void | Promise<void>;
}): Promise<{
  readonly release: () => Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  args.signal.throwIfAborted();
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
        args.signal.throwIfAborted();
        await lockErasureSubjects(tx, [args.subject]);
        args.signal.throwIfAborted();
        const pids = await executeRawRows(
          tx,
          sql`SELECT pg_backend_pid() AS "pid"`,
          databasePidRowSchema,
        );
        args.signal.throwIfAborted();
        const holderPid = pids[0]?.pid;
        if (!holderPid) {
          throw new Error("Expected the B1 holder backend pid");
        }
        await args.beforeReady?.(holderPid);
        args.signal.throwIfAborted();
        if (!started.settled()) {
          started.resolve({ ok: true, holderPid });
        }
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
  const failSetup = async (error: unknown): Promise<never> => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
    const transactionResult = await finished;
    if (!transactionResult.ok && !Object.is(transactionResult.error, error)) {
      throw new AggregateError(
        [error, transactionResult.error],
        "B1 holder readiness and transaction failed",
      );
    }
    throw error;
  };
  const setupResult = await setup;
  if (!setupResult.ok) {
    return await failSetup(setupResult.error);
  }
  if (!setupResult.value.ok) {
    return await failSetup(setupResult.value.error);
  }
  if (args.signal.aborted) {
    return await failSetup(args.signal.reason);
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
