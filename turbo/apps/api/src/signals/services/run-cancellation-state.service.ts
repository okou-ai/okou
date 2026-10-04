import type { RunnerCancellationResponse } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import type { SandboxAuth } from "../../types/auth";
import { db$ } from "../external/db";

/** The signed Run identity remains verifiable after its history has been erased. */
export const readRunCancellationState$ = command(
  async (
    { get },
    auth: SandboxAuth,
    expected: {
      readonly runnerGroup: string;
      readonly runnerId: string;
      readonly heartbeatGeneration: number;
    },
    signal: AbortSignal,
  ): Promise<RunnerCancellationResponse> => {
    signal.throwIfAborted();
    // Do not filter by owner or claim: a mismatch is not physical absence.
    const [run] = await get(db$)
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
    return { ...identity, state: "present", mode: run.mode };
  },
);
