import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { usageChatProjectionWork } from "@okouai/db/schema/usage-chat-projection-work";
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ApiDb, Tx } from "../../lib/db-types";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  projectRunUsageEvent$,
  type RunUsageProjectionResult,
} from "./chat-usage-event.service";

const L = logger("UsageChatProjectionWorker");
const databaseNow = sql`timezone('UTC', clock_timestamp())`;
const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
type Work = typeof usageChatProjectionWork.$inferSelect;
type ClaimedWork = Work & { readonly leaseId: string };

async function claimWork(
  db: ApiDb,
  runId: string | undefined,
  signal: AbortSignal,
): Promise<ClaimedWork | null> {
  signal.throwIfAborted();
  return await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ runId: usageChatProjectionWork.runId })
      .from(usageChatProjectionWork)
      .where(
        and(
          runId ? eq(usageChatProjectionWork.runId, runId) : undefined,
          lt(
            usageChatProjectionWork.appliedRevision,
            usageChatProjectionWork.desiredRevision,
          ),
          lte(usageChatProjectionWork.availableAt, databaseNow),
          or(
            isNull(usageChatProjectionWork.leaseId),
            lte(usageChatProjectionWork.leaseExpiresAt, databaseNow),
          ),
        ),
      )
      .orderBy(
        asc(usageChatProjectionWork.availableAt),
        asc(usageChatProjectionWork.runId),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    signal.throwIfAborted();
    if (!candidate) {
      return null;
    }
    const leaseId = randomUUID();
    const [claimed] = await tx
      .update(usageChatProjectionWork)
      .set({
        leaseId,
        leaseExpiresAt: sql`${databaseNow} + ${LEASE_MS} * interval '1 millisecond'`,
        // Keep active leases out of the due index until they expire.
        availableAt: sql`${databaseNow} + ${LEASE_MS} * interval '1 millisecond'`,
        updatedAt: databaseNow,
      })
      .where(eq(usageChatProjectionWork.runId, candidate.runId))
      .returning();
    signal.throwIfAborted();
    if (!claimed) {
      throw new Error("Projection work vanished during claim");
    }
    return { ...claimed, leaseId };
  });
}

async function withActiveLease(
  db: ApiDb,
  work: ClaimedWork,
  signal: AbortSignal,
  update: (tx: Tx) => Promise<void>,
): Promise<boolean> {
  signal.throwIfAborted();
  return await db.transaction(async (tx) => {
    // Check expiry after taking the row lock; a stale claimant never acks work.
    const [locked] = await tx
      .select({ runId: usageChatProjectionWork.runId })
      .from(usageChatProjectionWork)
      .where(
        and(
          eq(usageChatProjectionWork.runId, work.runId),
          eq(usageChatProjectionWork.leaseId, work.leaseId),
          gt(usageChatProjectionWork.leaseExpiresAt, databaseNow),
        ),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    signal.throwIfAborted();
    if (!locked) {
      return false;
    }
    await update(tx);
    signal.throwIfAborted();
    return true;
  });
}

async function runOne(
  db: ApiDb,
  project: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<RunUsageProjectionResult>,
  work: ClaimedWork,
  signal: AbortSignal,
): Promise<void> {
  const outcome = await settle(
    (async () => {
      // The run FK cascades deletion; the chat projection itself checks live
      // thread ownership before writing any content or acknowledgement.
      const result = await project(work.runId, signal);
      signal.throwIfAborted();
      await withActiveLease(db, work, signal, async (tx) => {
        if (result === "discarded") {
          await tx
            .delete(usageChatProjectionWork)
            .where(
              and(
                eq(usageChatProjectionWork.runId, work.runId),
                eq(
                  usageChatProjectionWork.desiredRevision,
                  work.desiredRevision,
                ),
              ),
            );
        } else if (result === "deferred") {
          await tx
            .update(usageChatProjectionWork)
            .set({
              leaseId: null,
              leaseExpiresAt: null,
              availableAt: sql`${databaseNow} + interval '1 minute'`,
              updatedAt: databaseNow,
            })
            .where(eq(usageChatProjectionWork.runId, work.runId));
        } else {
          await tx
            .update(usageChatProjectionWork)
            .set({
              appliedRevision: sql`GREATEST(${usageChatProjectionWork.appliedRevision}, ${work.desiredRevision})`,
              leaseId: null,
              leaseExpiresAt: null,
              availableAt: databaseNow,
              failureCount: 0,
              lastError: null,
              updatedAt: databaseNow,
            })
            .where(eq(usageChatProjectionWork.runId, work.runId));
          // The lock fences concurrent settlements. Only delete this completed
          // epoch; a newer desired revision stays pending for the next claim.
          await tx
            .delete(usageChatProjectionWork)
            .where(
              and(
                eq(usageChatProjectionWork.runId, work.runId),
                eq(
                  usageChatProjectionWork.desiredRevision,
                  work.desiredRevision,
                ),
                eq(
                  usageChatProjectionWork.appliedRevision,
                  work.desiredRevision,
                ),
              ),
            );
        }
      });
    })(),
    signal,
  );
  if (outcome.ok) {
    return;
  }
  const error = outcome.error;
  L.error("Chat usage projection failed; will retry", {
    runId: work.runId,
    errorClass:
      error instanceof Error ? error.constructor.name : "ProjectionFailed",
  });
  // Preserve a poisoned row for observable retries; never acknowledge it.
  await withActiveLease(db, work, signal, async (tx) => {
    const backoffMs = Math.min(
      MAX_BACKOFF_MS,
      60_000 * 2 ** Math.min(work.failureCount, 6),
    );
    await tx
      .update(usageChatProjectionWork)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        failureCount: sql`${usageChatProjectionWork.failureCount} + 1`,
        // Do not persist R2 URLs, event content, or external error messages.
        lastError:
          error instanceof Error
            ? error.constructor.name.slice(0, 64)
            : "ProjectionFailed",
        availableAt: sql`${databaseNow} + ${backoffMs} * interval '1 millisecond'`,
        updatedAt: databaseNow,
      })
      .where(eq(usageChatProjectionWork.runId, work.runId));
  });
}

/** Fast path only; cron owns recovery after a process dies or an ack is lost. */
export const projectCommittedRunUsage$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const work = await claimWork(db, runId, signal);
    if (work) {
      await runOne(
        db,
        (id, s) => {
          return set(projectRunUsageEvent$, id, s);
        },
        work,
        signal,
      );
    }
  },
);

export const drainUsageChatProjection$ = command(
  async (
    { set },
    args: { readonly maxJobs?: number },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const db = set(writeDb$);
    let processed = 0;
    while (processed < (args.maxJobs ?? 10)) {
      signal.throwIfAborted();
      const work = await claimWork(db, undefined, signal);
      if (!work) {
        break;
      }
      await runOne(
        db,
        (id, s) => {
          return set(projectRunUsageEvent$, id, s);
        },
        work,
        signal,
      );
      processed++;
    }
    return { processed };
  },
);
