import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";
import { waitForDeferredBlocker } from "./pi-deferred-lock";

/** Parent FK contention cannot be held open through the public API. */
export async function holdRunActivityParentFixture(
  runId: string,
  signal: AbortSignal,
) {
  const ready = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = settleIncludingAbort(
    db().transaction(async (tx) => {
      await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .for("update");
      const [row] = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS pid`,
        z.object({ pid: z.number() }),
      );
      if (!row) {
        throw new Error("Missing lock holder PID");
      }
      ready.resolve(row.pid);
      await released.promise;
    }),
  );
  const release = async () => {
    if (!released.settled()) {
      released.resolve(undefined);
    }
    const result = await done;
    if (!result.ok && result.error !== signal.reason) {
      throw result.error;
    }
  };
  onTestFinished(release);
  const pid = await ready.promise;
  return {
    release,
    waitForBlocked: () => {
      return waitForDeferredBlocker(pid);
    },
  };
}

/** Maintenance deletion cannot be targeted through a production user API. */
export async function deleteRunActivitySnapshotFixture(runId: string) {
  await db()
    .delete(runActivitySnapshots)
    .where(eq(runActivitySnapshots.runId, runId));
}

/** PostgreSQL cancellation is an infrastructure fault, distinct from 55P03. */
export async function cancelRunActivityWaiterFixture(pid: number) {
  await db().execute(sql`SELECT pg_cancel_backend(${pid})`);
}

/**
 * Inspect retention/lease bookkeeping unavailable in public responses. Tests
 * still create activity and verify summaries through the authenticated API.
 */
export async function readRunActivityBookkeepingFixture(runId: string) {
  const [row] = await db()
    .select({
      messageCursor: runActivitySnapshots.messageCursor,
      expiresAt: runActivitySnapshots.expiresAt,
      nextAttemptAt: runActivitySnapshots.nextAttemptAt,
      claimId: runActivitySnapshots.claimId,
      claimRevision: runActivitySnapshots.claimRevision,
      claimExpiresAt: runActivitySnapshots.claimExpiresAt,
      summary: runActivitySnapshots.summary,
      summaryRevision: runActivitySnapshots.summaryRevision,
    })
    .from(runActivitySnapshots)
    .where(eq(runActivitySnapshots.runId, runId));
  return row;
}

/** Infrastructure-only time passage, scoped to a run created by this test. */
export async function advanceRunActivityClockFixture(
  runId: string,
  milliseconds: number,
): Promise<void> {
  await db()
    .update(runActivitySnapshots)
    .set({
      expiresAt: sql`${runActivitySnapshots.expiresAt} - ${milliseconds} * interval '1 millisecond'`,
      nextAttemptAt: sql`${runActivitySnapshots.nextAttemptAt} - ${milliseconds} * interval '1 millisecond'`,
      claimExpiresAt: sql`${runActivitySnapshots.claimExpiresAt} - ${milliseconds} * interval '1 millisecond'`,
    })
    .where(eq(runActivitySnapshots.runId, runId));
}

/** A stalled database writer is not constructible through a production API. */
export async function holdRunActivityFixture(
  runId: string,
  signal: AbortSignal,
) {
  const ready = createDeferredPromise<void>(signal);
  const release = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await tx
      .select({ runId: runActivitySnapshots.runId })
      .from(runActivitySnapshots)
      .where(eq(runActivitySnapshots.runId, runId))
      .for("update");
    ready.resolve(undefined);
    await release.promise;
  });
  await ready.promise;
  return {
    release: () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    },
    done,
  };
}
