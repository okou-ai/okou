import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import {
  deleteLockedRuns,
  deleteRunConversations,
  releaseDeletedConversationReferences,
} from "../signals/services/conversation-history-deletion.service";
import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

async function directBlockedWaiterCount(holderPid: number): Promise<number> {
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

interface HeldDatabaseBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}

/** Deletes one run root without invoking a global maintenance sweep. */
export async function deleteAgentRunRootFixture(runId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const runs = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const ids = runs.map((run) => {
      return run.id;
    });
    const removed = await deleteRunConversations(tx, ids);
    await deleteLockedRuns(tx, ids);
    await releaseDeletedConversationReferences(tx, removed);
  });
}

/** Moves a run to a deterministic position in an oldest-first test sweep. */
export async function setAgentRunCreatedAtFixture(
  runId: string,
  createdAt: Date,
): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ createdAt })
    .where(eq(agentRuns.id, runId));
}

export async function insertPendingInlineDeliveryCallbackFixture(
  runId: string,
): Promise<string> {
  const [callback] = await db()
    .insert(agentRunCallbacks)
    .values({ runId, internalKind: "slack:chat", payload: {} })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Expected the inline delivery callback to be inserted");
  }
  return callback.id;
}

export async function readRunCallbackFixture(callbackId: string): Promise<{
  readonly status: string;
  readonly lastError: string | null;
} | null> {
  const [callback] = await db()
    .select({
      status: agentRunCallbacks.status,
      lastError: agentRunCallbacks.lastError,
    })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.id, callbackId));
  return callback ?? null;
}

/** Holds the same per-org credit reconciliation lock as terminal side effects. */
export async function holdOrgCreditLockFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const pid = pidRows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the credit lock holder pid");
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('credit_' || ${args.orgId}))`,
    );
    started.resolve(pid);
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
      return await directBlockedWaiterCount(pid);
    },
  };
}

/**
 * Locks one root, then deletes it in the holding transaction when released.
 * This lets a route test deterministically put a runner write behind the root
 * delete without adding product-only synchronization.
 */
export async function holdAgentRunDeletionFixture(args: {
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<HeldDatabaseBoundary> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const pid = pidRows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the run deletion holder pid");
    }
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .for("update");
    if (!run) {
      throw new Error("Expected the run root to exist before deletion");
    }
    started.resolve(pid);
    await released.promise;
    const removed = await deleteRunConversations(tx, [args.runId]);
    await deleteLockedRuns(tx, [args.runId]);
    await releaseDeletedConversationReferences(tx, removed);
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
      return await directBlockedWaiterCount(pid);
    },
  };
}

/** Infrastructure-only observation: no production endpoint exposes the ledger. */
export async function readHistoryBlobReferenceCountFixture(
  hash: string,
): Promise<number | null> {
  const [row] = await db()
    .select({ count: blobs.refCount })
    .from(blobs)
    .where(eq(blobs.hash, hash));
  return row?.count ?? null;
}
