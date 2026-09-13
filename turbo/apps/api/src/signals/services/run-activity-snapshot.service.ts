import { FeatureSwitchKey, isFeatureEnabled } from "@okouai/core";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { command } from "ccstate";
import { and, asc, eq, getTableColumns, inArray, lte, sql } from "drizzle-orm";
import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import {
  isForeignKeyViolation,
  isLockNotAvailable,
  safeSqlStateCode,
} from "../../lib/pg-errors";
import { activityRevision, mergeActivity } from "../../lib/run-activity";
import { writeDb$, type Db } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const log = logger("api:run-activity");

export const activityClock = sql`(statement_timestamp() AT TIME ZONE 'UTC')`;
const activityExpiry = sql`${activityClock} + interval '24 hours'`;
export type ActivityTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ActivitySnapshot = typeof runActivitySnapshots.$inferSelect;

export async function activityTransaction<T>(
  db: Db,
  work: (tx: ActivityTx) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return await work(tx);
  });
}

export async function activityEnabled(
  db: Pick<Db, "select">,
  orgId: string,
  userId: string,
): Promise<boolean> {
  return isFeatureEnabled(
    FeatureSwitchKey.ThreadActivitySummary,
    await loadUserFeatureSwitchContext(db, orgId, userId),
  );
}

export interface ActivityRunIdentity {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
}

/** Admission binds this pointer atomically; queued work does not replace it. */
export function eligibleActivityRun(
  db: Pick<Db, "select">,
  identity: ActivityRunIdentity,
) {
  return db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, identity.runId),
        eq(agentRuns.chatThreadId, identity.threadId),
        eq(agentRuns.userId, identity.userId),
        eq(agentRuns.orgId, identity.orgId),
        eq(chatThreads.userId, identity.userId),
        chatThreadOrganizationCondition(db, identity.orgId),
        eq(chatThreads.agentSessionRunId, identity.runId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    );
}

export async function lockActivitySnapshot(tx: ActivityTx, runId: string) {
  await tx.insert(runActivitySnapshots).values({ runId }).onConflictDoNothing();
  const [row] = await tx
    .select({
      ...getTableColumns(runActivitySnapshots),
      clock: activityClock.mapWith(runActivitySnapshots.expiresAt),
    })
    .from(runActivitySnapshots)
    .where(eq(runActivitySnapshots.runId, runId))
    .for("update");
  if (!row) {
    throw new Error("Activity snapshot missing after insert");
  }
  return row;
}

export const captureRunActivity$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
    const db = set(writeDb$);
    const outcome = await settleIncludingAbort(
      activityTransaction(db, async (tx) => {
        const [run] = await tx
          .select({
            threadId: agentRuns.chatThreadId,
            userId: agentRuns.userId,
            orgId: agentRuns.orgId,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, payload.runId));
        if (
          !run?.threadId ||
          run.userId !== payload.context.userId ||
          run.orgId !== payload.context.orgId
        ) {
          return;
        }
        if (!(await activityEnabled(tx, run.orgId, run.userId))) {
          return;
        }
        const identity = {
          ...run,
          threadId: run.threadId,
          runId: payload.runId,
        };
        if (!(await eligibleActivityRun(tx, identity))[0]) {
          return;
        }
        if (mergeActivity([], payload.events).length === 0) {
          return;
        }
        signal.throwIfAborted();
        const row = await lockActivitySnapshot(tx, payload.runId);
        const expired = row.expiresAt <= row.clock;
        const entries = mergeActivity(
          expired ? [] : row.entries,
          payload.events,
        );
        const revision = activityRevision(entries);
        if (!expired && revision === row.activityRevision) {
          return;
        }
        await tx
          .update(runActivitySnapshots)
          .set({
            entries,
            activityRevision: revision,
            expiresAt: activityExpiry,
            ...(expired
              ? {
                  summary: null,
                  summaryRevision: null,
                  claimId: null,
                  claimRevision: null,
                  claimExpiresAt: null,
                }
              : {}),
          })
          .where(eq(runActivitySnapshots.runId, payload.runId));
      }),
    );
    signal.throwIfAborted();
    // Concurrent delivery for one run contends routinely, and a run can be
    // deleted mid-flight; neither is a defect, and both stay silent.
    if (
      outcome.ok ||
      isLockNotAvailable(outcome.error) ||
      isForeignKeyViolation(outcome.error)
    ) {
      return { status: 200 };
    }
    // Never attach a database error: driver messages can include bound
    // evidence. The SQLSTATE class code carries no content and stays.
    const errorCode = safeSqlStateCode(outcome.error);
    log.warn("Activity snapshot capture failed", {
      runId: payload.runId,
      eventCount: payload.events.length,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    return { status: 200 };
  },
);

/** Indexed, one-batch maintenance; disabled accounts still get expiry cleanup. */
export const cleanupExpiredRunActivity$ = command(
  async ({ set }, runIds: readonly string[] | null, signal: AbortSignal) => {
    const db = set(writeDb$);
    const outcome = await settleIncludingAbort(
      activityTransaction(db, async (tx) => {
        const expired = await tx
          .select({ runId: runActivitySnapshots.runId })
          .from(runActivitySnapshots)
          .where(
            and(
              lte(runActivitySnapshots.expiresAt, activityClock),
              runIds === null
                ? undefined
                : inArray(runActivitySnapshots.runId, runIds),
            ),
          )
          .orderBy(
            asc(runActivitySnapshots.expiresAt),
            asc(runActivitySnapshots.runId),
          )
          .limit(500)
          .for("update", { skipLocked: true });
        signal.throwIfAborted();
        if (expired.length === 0) {
          return;
        }
        await tx.delete(runActivitySnapshots).where(
          inArray(
            runActivitySnapshots.runId,
            expired.map((row) => {
              return row.runId;
            }),
          ),
        );
      }),
    );
    signal.throwIfAborted();
    if (outcome.ok) {
      return;
    }
    // The SQLSTATE class code alone; driver messages never reach a record.
    const errorCode = safeSqlStateCode(outcome.error);
    log.warn(
      "Activity snapshot cleanup failed",
      errorCode === undefined ? {} : { errorCode },
    );
  },
);
