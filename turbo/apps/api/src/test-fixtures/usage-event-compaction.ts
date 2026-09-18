import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { billingAttributionBackfill } from "@okouai/db/schema/billing-run-attribution";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { env, optionalEnv } from "../lib/env";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import type { Tx } from "../lib/db-types";
import { executeRawRows } from "../lib/db-raw-rows";
import {
  lockUsageEventCompaction,
  withUsageEventCompactionLockAttemptTrackingForTest,
  withUsageEventCompactionLockScopeForTest,
} from "../signals/services/usage-event-compaction-lock.service";
import { createDeferredPromise } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

/** Simulate another test owner, or the unscoped production admission boundary. */
export async function withUsageEventCompactionScopeFixture<T>(
  scope: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return await withUsageEventCompactionLockScopeForTest(scope, work);
}

/**
 * Holds the scenario's usage-compaction advisory lock so route tests can prove
 * that destructive cleanup waits for the same transaction boundary.
 * An optional owned source reproduces the compactor's raw-row lock followed
 * by the rollup foreign key's Run KEY SHARE lock, without rewriting history.
 */
export async function holdUsageEventCompactionLockFixture(
  signal: AbortSignal,
  source?: {
    readonly idempotencyKey: string;
    readonly runId: string;
  },
) {
  return await holdUsageEventCompactionLock(
    signal,
    lockUsageEventCompaction,
    source,
  );
}

/** An independent SQL participant verifies the unchanged production lock key. */
export async function holdProductionUsageEventCompactionLockFixture(
  signal: AbortSignal,
) {
  return await holdUsageEventCompactionLock(signal, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('vm0'), hashtext('usage_event_compaction'))`,
    );
  });
}

async function holdUsageEventCompactionLock(
  signal: AbortSignal,
  acquire: (tx: Tx) => Promise<void>,
  source?: {
    readonly idempotencyKey: string;
    readonly runId: string;
  },
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly acquisitionAttempted: Promise<void>;
  readonly withAcquisitionAttemptTracking: <T>(
    work: () => Promise<T>,
  ) => Promise<T>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const acquisitionAttempted = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await acquire(tx);
    if (source) {
      const [owned] = await tx
        .select({ id: usageEvent.id })
        .from(usageEvent)
        .where(
          and(
            eq(usageEvent.idempotencyKey, source.idempotencyKey),
            eq(usageEvent.runId, source.runId),
          ),
        )
        .for("update");
      if (!owned) {
        throw new Error("Expected the owned usage compaction source");
      }
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the usage compaction lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
    if (source) {
      // A compactor must still be able to validate its new rollup's FK while
      // holding the source row. NOWAIT makes reversed Run ownership fail here.
      const [run] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, source.runId))
        .for("key share", { noWait: true });
      if (!run) {
        throw new Error("Compaction source lost its live Run reference");
      }
    }
  });
  const holderPid = await Promise.race([started.promise, done]);
  if (holderPid === undefined) {
    throw new Error("Compaction lock fixture finished before acquiring lock");
  }

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    acquisitionAttempted: acquisitionAttempted.promise,
    withAcquisitionAttemptTracking: async <T>(
      work: () => Promise<T>,
    ): Promise<T> => {
      return await withUsageEventCompactionLockAttemptTrackingForTest(() => {
        if (!acquisitionAttempted.settled()) {
          acquisitionAttempted.resolve(undefined);
        }
      }, work);
    },
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/** Historical missing columns cannot be produced through current API writers.
 * Disable capture only in this connection, and only touch this test's org.
 */
export async function makeUsageBillingLegacyFixture(
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await db().transaction(async (tx) => {
    await lockUsageEventCompaction(tx);
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const legacy = {
      billingRunId: null,
      billingAnchorAt: null,
      billingContext: "legacy_unknown",
    };
    await tx.update(usageEvent).set(legacy).where(eq(usageEvent.orgId, orgId));
    await tx
      .update(usageEventHourlyRollup)
      .set(legacy)
      .where(eq(usageEventHourlyRollup.orgId, orgId));
  });
  signal.throwIfAborted();
}

/** Execute the actual operator CLI, bounded to the test-owned organization. */
export async function backfillUsageBillingFixture(
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const jobId = randomUUID();
  const packageDir = fileURLToPath(
    new URL("../../../../packages/db", import.meta.url),
  );
  const [result] = await Promise.allSettled([
    promisify(execFile)(
      "node",
      [
        fileURLToPath(import.meta.resolve("tsx/cli")),
        "scripts/billing-attribution.ts",
        "--org-id",
        orgId,
        "--migrate",
        "--ack-writer-drain",
        "--job-id",
        jobId,
        "--max-rows",
        "1000",
        "--batch-size",
        "2",
        "--max-ms",
        "10000",
      ],
      {
        cwd: packageDir,
        env: {
          PATH: optionalEnv("PATH"),
          HOME: optionalEnv("HOME"),
          DATABASE_URL: env("DATABASE_URL"),
          TZ: "UTC",
        },
        signal,
      },
    ),
  ]);
  await db()
    .delete(billingAttributionBackfill)
    .where(eq(billingAttributionBackfill.id, jobId));
  if (result.status === "rejected") {
    throw result.reason;
  }
}
