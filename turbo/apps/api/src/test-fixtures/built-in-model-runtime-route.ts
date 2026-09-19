import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";
import {
  withBuiltInModelRuntimeRouteCandidateUnavailableForTest as withRuntimeRouteCandidateUnavailable,
  withBuiltInModelRuntimeRouteUnavailableForTest as withRuntimeRouteUnavailable,
} from "../signals/services/built-in-model-runtime-route.service";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

interface BuiltInModelRuntimeRouteFixtureIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

interface HeldBuiltInModelRouteBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly cancelBlockedQueries: () => Promise<number>;
}

/**
 * Missing operator-managed keys are global infrastructure state and cannot be
 * isolated through a user-facing API. This fixture scopes that state to one
 * async request chain so route tests never delete or restore shared key rows.
 */
export function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteUnavailable(selectedModel, work);
}

/**
 * A candidate cooldown is global infrastructure state. Scope the unavailable
 * candidate to one async test flow while preserving normal route selection.
 */
export function withBuiltInModelRuntimeRouteCandidateUnavailableForTest<T>(
  candidate: BuiltInModelRuntimeRouteFixtureIdentity,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteCandidateUnavailable(candidate, work);
}

function routeCondition(route: BuiltInModelRuntimeRouteFixtureIdentity) {
  return and(
    eq(builtInModelCandidateCooldown.selectedModel, route.selectedModel),
    eq(builtInModelCandidateCooldown.modelRuntimeProvider, route.providerType),
    eq(builtInModelCandidateCooldown.modelRuntimeModel, route.upstreamModel),
  );
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
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected one built-in model route waiter count row");
  }
  return row.waiterCount;
}

async function transactionBackendPid(
  tx: Parameters<typeof executeRawRows>[0],
): Promise<number> {
  const rows = await executeRawRows(
    tx,
    sql`SELECT pg_backend_pid() AS "pid"`,
    databasePidRowSchema,
  );
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error("Expected one built-in model route fixture backend pid");
  }
  return row.pid;
}

/**
 * No production API can leave this row lock open while a report is processed.
 * This fixture creates that infrastructure-only ordering so receipt time stays
 * externally testable through the report and route APIs.
 */
export async function holdBuiltInModelRouteLockFixture(args: {
  readonly route: BuiltInModelRuntimeRouteFixtureIdentity;
  readonly signal: AbortSignal;
}): Promise<HeldBuiltInModelRouteBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await tx
      .select({ selectedModel: builtInModelCandidateCooldown.selectedModel })
      .from(builtInModelCandidateCooldown)
      .where(routeCondition(args.route))
      .for("update");
    if (rows.length !== 1) {
      throw new Error("Expected one built-in model route fixture row");
    }
    started.resolve(await transactionBackendPid(tx));
    await released.promise;
  });
  const pid = await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await blockedWaiterCount(pid);
    },
    // A real query failure cannot be requested through the report API. Only
    // cancel queries waiting on this fixture's owned row lock.
    cancelBlockedQueries: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT pg_cancel_backend(activity.pid) AS cancelled
          FROM pg_stat_activity AS activity
          WHERE ${pid} = ANY(pg_blocking_pids(activity.pid))
        `,
        z.object({ cancelled: z.boolean() }),
      );
      return rows.filter((row) => {
        return row.cancelled;
      }).length;
    },
  };
}
