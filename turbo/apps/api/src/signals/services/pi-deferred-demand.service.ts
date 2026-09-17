import { and, asc, count, eq, exists, gt, lt, lte, or } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunSandboxIntent } from "@okouai/db/schema/agent-run-inference";
import { agentRunInferenceObjects } from "@okouai/db/schema/pi-inference-object";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
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

export function eligibleDeferredPiDemandPredicate(
  db: Pick<Db, "select">,
  orgId: string,
  at: Date = nowDate(),
) {
  return and(
    eq(agentRuns.orgId, orgId),
    eq(agentRuns.status, "pending"),
    eq(agentRunSandboxIntent.state, "waiting"),
    retainedDemand(db),
    gt(agentRunSandboxIntent.expiresAt, at),
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
 * Omit `runId` for a fresh direct admission that has no persisted position yet:
 * it is ordered at `at` and yields to demand already persisted at that instant.
 * Already expired demand is excluded so an ineligible head cannot block eligible
 * work until a consumer sweeps it.
 */
export async function countEarlierDeferredDemand(
  tx: Tx,
  orgId: string,
  at: Date,
  runId?: string,
): Promise<number> {
  const [earlier] = await tx
    .select({ count: count() })
    .from(agentRunSandboxIntent)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
    .where(
      and(
        eligibleDeferredPiDemandPredicate(tx, orgId),
        runId === undefined
          ? lte(agentRunSandboxIntent.enqueuedAt, at)
          : or(
              lt(agentRunSandboxIntent.enqueuedAt, at),
              and(
                eq(agentRunSandboxIntent.enqueuedAt, at),
                lt(agentRunSandboxIntent.runId, runId),
              ),
            ),
      ),
    );
  if (!earlier) {
    throw new Error("Earlier deferred demand count query returned no row");
  }
  return earlier.count;
}
