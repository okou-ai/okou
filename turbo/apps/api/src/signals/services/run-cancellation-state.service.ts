import type { RunnerCancellationResponse } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, eq } from "drizzle-orm";

import type { SandboxAuth } from "../../types/auth";
import type { ReadonlyDb } from "../external/db";

/** The signed Run identity remains verifiable after its history has been erased. */
export async function readRunCancellationState(
  db: ReadonlyDb,
  auth: SandboxAuth,
  expected: {
    readonly runnerGroup: string;
    readonly runnerId: string;
    readonly heartbeatGeneration: number;
  },
  signal: AbortSignal,
): Promise<RunnerCancellationResponse> {
  signal.throwIfAborted();
  // Do not filter by owner or claim: a mismatch is not physical absence.
  const [run] = await db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      runnerGroup: agentRuns.runnerGroup,
      runnerId: agentRuns.runnerId,
      heartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
      mode: agentRuns.runnerCancellationMode,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, auth.runId));
  signal.throwIfAborted();

  const identity = { protocolVersion: 1 as const, runId: auth.runId };
  if (!run) {
    return { ...identity, state: "gone" };
  }
  const claimMatches =
    (run.runnerId === null && run.heartbeatGeneration === null) ||
    (run.runnerId === expected.runnerId &&
      run.heartbeatGeneration === expected.heartbeatGeneration);
  if (
    run.userId !== auth.userId ||
    run.orgId !== auth.orgId ||
    run.runnerGroup !== expected.runnerGroup ||
    !claimMatches
  ) {
    return { ...identity, state: "unavailable" };
  }
  // The committed deletion receipt is authoritative before B1 has captured
  // enough locators to remove the Run. Keep it present for capture, but stop
  // the authenticated Runner immediately while cleanup remains pending.
  const [deletion] = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.kind, "clerk-user-deletion"),
        eq(backgroundJobs.userId, run.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return { ...identity, state: "present", mode: deletion ? "hard" : run.mode };
}
