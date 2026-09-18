import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { modelProviders } from "@okouai/db/schema/model-provider";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { withPreparedLaunchAdmissionTrackingForTest } from "../signals/services/prepared-launch-admission-lock.service";
import {
  createDeferredPromise,
  onRejection,
  settleIncludingAbort,
} from "../signals/utils";

const waiterCountSchema = z.object({ waiterCount: z.number() });
const backendPidSchema = z.object({ pid: z.number() });

// Infrastructure-only synchronization: the API cannot hold a row lock between
// two requests. This holder changes no product rows; the competing production
// writer owns the advisory lock, account mutation, and eventual commit.
export async function holdPersonalSubscriptionProviderRowLockFixture(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly type: "claude-code-oauth-token" | "codex-oauth-token";
  },
  signal: AbortSignal,
) {
  const entered = createDeferredPromise<number>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = onRejection(
    db().transaction(async (tx) => {
      signal.throwIfAborted();
      const [provider] = await tx
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, args.userId),
            eq(modelProviders.type, args.type),
          ),
        )
        .for("no key update");
      signal.throwIfAborted();
      if (!provider) {
        throw new Error("Expected the test-owned subscription provider");
      }
      const [backend] = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS pid`,
        backendPidSchema,
      );
      signal.throwIfAborted();
      if (!backend) {
        throw new Error("Expected the subscription row lock holder pid");
      }
      entered.resolve(backend.pid);
      await released.promise;
      signal.throwIfAborted();
    }),
    (error) => {
      if (!entered.settled()) {
        entered.reject(error);
      }
    },
  );
  // Observe every transaction failure immediately. If cancellation wins before
  // entry, no caller has received the holder yet, so this function must join its
  // rollback before propagating the failure.
  const transaction = settleIncludingAbort(done);
  const entry = await settleIncludingAbort(entered.promise);
  if (!entry.ok) {
    if (!released.settled()) {
      released.resolve();
    }
    const result = await transaction;
    if (!result.ok) {
      throw result.error;
    }
    throw entry.error;
  }
  const holderPid = entry.value;
  return {
    done,
    release() {
      if (!released.settled()) {
        released.resolve();
      }
    },
    async waiterCount() {
      const [row] = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_stat_activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(pid))
        `,
        waiterCountSchema,
      );
      if (!row) {
        throw new Error("Expected the subscription row lock waiter count");
      }
      return row.waiterCount;
    },
  };
}

// Infrastructure-only observation: no API exposes when this request has
// finished preparation and is about to acquire its final admission lock.
export function observePreparedLaunchAdmissionFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}) {
  const attempted = createDeferredPromise<void>(args.signal);
  return {
    attempted: attempted.promise,
    async track<T>(work: () => Promise<T>): Promise<T> {
      return await withPreparedLaunchAdmissionTrackingForTest((orgId) => {
        if (orgId === args.orgId && !attempted.settled()) {
          attempted.resolve(undefined);
        }
      }, work);
    },
  };
}

// Infrastructure-only observation for the refresh/terminal race. Product state
// is created and asserted through production APIs; no API exposes lock timing.
export async function countWaitingPersonalSubscriptionMutationsFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}): Promise<number> {
  const key = `model_provider_state:${args.orgId}:${args.userId}:${args.type}`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT count(*)::int AS "waiterCount"
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND objid = (hashtext(${key})::bigint & 4294967295)::oid
    `,
    waiterCountSchema,
  );
  if (!rows[0]) {
    throw new Error("Expected the aggregate lock waiter count");
  }
  return rows[0].waiterCount;
}

// Infrastructure-only observation: an old Claude writer ignores the provider
// advisory lock and instead waits for a credential row owned by its holder.
// Count direct waiters of that test-owned holder without inspecting query text
// or product rows; no production API exposes PostgreSQL lock timing.
export async function countBlockedPersonalSubscriptionMutationsFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}): Promise<number> {
  const key = `model_provider_state:${args.orgId}:${args.userId}:${args.type}`;
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE EXISTS (
        SELECT 1 FROM pg_locks AS holder
        WHERE holder.pid = ANY(pg_blocking_pids(activity.pid))
          AND holder.locktype = 'advisory' AND holder.granted
          AND holder.objsubid = 1
          AND holder.objid = (hashtext(${key})::bigint & 4294967295)::oid
          AND holder.database = (
            SELECT oid FROM pg_database WHERE datname = current_database()
          )
      )
    `,
    waiterCountSchema,
  );
  if (!rows[0]) {
    throw new Error("Expected the aggregate blocked waiter count");
  }
  return rows[0].waiterCount;
}
