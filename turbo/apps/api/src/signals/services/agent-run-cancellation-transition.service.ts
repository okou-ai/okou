import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import {
  neverStartedRunIds,
  transitionAgentRunsToTerminal,
} from "./agent-run-terminal-transition.service";

/** The caller owns the run row lock and has classified its current status.
 * Returns the never-started run IDs whose active rows the caller must release
 * with `releaseActiveAgentRuns` as the last statement of its transaction.
 */
export async function cancelLockedRun(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly status: "queued" | "pending" | "running";
    readonly completedAt: Date;
    readonly runnerCancellationMode: RunnerCancellationMode;
    readonly error?: string;
  },
): Promise<readonly string[]> {
  const transitions = await transitionAgentRunsToTerminal(tx, {
    values: {
      status: "cancelled",
      completedAt: args.completedAt,
      runnerCancellationMode: args.runnerCancellationMode,
      ...(args.error === undefined ? {} : { error: args.error }),
    },
    conditions: [
      eq(agentRuns.id, args.runId),
      eq(agentRuns.status, args.status),
    ],
  });
  if (transitions.length === 0) {
    throw new Error("Locked cancellable run was not updated");
  }
  await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, args.runId));
  await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, args.runId));
  return neverStartedRunIds(transitions);
}
