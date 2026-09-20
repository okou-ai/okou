import { and, asc, count, eq, exists, gt, lt, lte, or } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunSandboxIntent } from "@okouai/db/schema/agent-run-inference";
import { agentRunInferenceObjects } from "@okouai/db/schema/pi-inference-object";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

/**
 * Shared Sandbox demand ordering. Every writer that spends organization Sandbox
 * capacity reads it while owning the same organization capacity lock: queued
 * legacy promotion, the deferred consumer and ordinary direct legacy creation.
 * It lives outside the consumer service so the create path can order against it
 * without importing the materializer.
 */
function retainedDemand(tx: Pick<Db, "select">) {
  return and(
    ...["configuration", "context"].map((kind) => {
      return exists(
        tx
          .select({ hash: agentRunInferenceObjects.hash })
          .from(agentRunInferenceObjects)
          .where(
            and(
              eq(agentRunInferenceObjects.runId, agentRunSandboxIntent.runId),
              eq(agentRunInferenceObjects.kind, kind),
            ),
          ),
      );
    }),
  );
}

/**
 * `eligibilityTime` is always the reader's current observation instant. Demand
 * stops reserving capacity the moment it expires, so a historical queue
 * position must never be substituted here.
 */
export function eligibleDeferredPiDemandPredicate(
  db: Pick<Db, "select">,
  orgId: string,
  eligibilityTime: Date,
) {
  return and(
    eq(agentRuns.orgId, orgId),
    eq(agentRuns.status, "pending"),
    eq(agentRunSandboxIntent.state, "waiting"),
    retainedDemand(db),
    gt(agentRunSandboxIntent.expiresAt, eligibilityTime),
  );
}

/** Eligible waiting demand, in the documented `(enqueuedAt, runId)` order. */
export async function listDeferredPiCandidates(
  db: Pick<Db, "select">,
  orgId: string,
) {
  return await db
    .select({
      runId: agentRunSandboxIntent.runId,
      createdAt: agentRunSandboxIntent.enqueuedAt,
    })
    .from(agentRunSandboxIntent)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "pending"),
        eq(agentRunSandboxIntent.state, "waiting"),
        retainedDemand(db),
      ),
    )
    .orderBy(
      asc(agentRunSandboxIntent.enqueuedAt),
      asc(agentRunSandboxIntent.runId),
    )
    .limit(100);
}

/**
 * The admission boundary an earlier-demand read is taken at. Ordering position
 * and eligibility are two different instants and must stay separate:
 *
 * - `positionTime` is the candidate's immutable FIFO position. Queued legacy
 *   promotion passes its historical `agent_run_queue.created_at` and retained
 *   deferred promotion passes its historical `enqueuedAt`, so the documented
 *   `(enqueuedAt, runId)` order never changes while a candidate waits.
 * - `eligibilityTime` is the current admission observation instant, captured
 *   under the same organization capacity lock. Only this instant decides
 *   `expiresAt >`, so demand that expired after the candidate took its position
 *   stops reserving a slot without waiting for a consumer to sweep it.
 *
 * Omit `runId` for a fresh direct admission that has no persisted position yet:
 * it is ordered at `positionTime` and yields to demand already persisted at
 * that instant. Such a caller captures one current instant and passes it as
 * both, because its position is that same observation.
 */
export interface EarlierDeferredDemandBoundary {
  readonly positionTime: Date;
  readonly eligibilityTime: Date;
  readonly runId?: string;
}

function earlierDeferredDemandPredicate(
  tx: Pick<Db, "select">,
  orgId: string,
  boundary: EarlierDeferredDemandBoundary,
) {
  const { positionTime, eligibilityTime, runId } = boundary;
  return and(
    eligibleDeferredPiDemandPredicate(tx, orgId, eligibilityTime),
    runId === undefined
      ? lte(agentRunSandboxIntent.enqueuedAt, positionTime)
      : or(
          lt(agentRunSandboxIntent.enqueuedAt, positionTime),
          and(
            eq(agentRunSandboxIntent.enqueuedAt, positionTime),
            lt(agentRunSandboxIntent.runId, runId),
          ),
        ),
  );
}

/** Aggregate that can join another capacity read without a second round trip. */
export function earlierDeferredDemandTotals(
  db: Pick<Db, "select">,
  orgId: string,
  boundary: EarlierDeferredDemandBoundary,
) {
  return db
    .select({ count: count().as("earlier_deferred_demand_count") })
    .from(agentRunSandboxIntent)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
    .where(earlierDeferredDemandPredicate(db, orgId, boundary))
    .as("earlier_deferred_demand_totals");
}

export async function countEarlierDeferredDemand(
  tx: Tx,
  orgId: string,
  boundary: EarlierDeferredDemandBoundary,
): Promise<number> {
  const [earlier] = await tx
    .select({ count: count() })
    .from(agentRunSandboxIntent)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
    .where(earlierDeferredDemandPredicate(tx, orgId, boundary));
  if (!earlier) {
    throw new Error("Earlier deferred demand count query returned no row");
  }
  return earlier.count;
}
