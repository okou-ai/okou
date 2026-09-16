import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { transitionAgentRunsToTerminal } from "./agent-run-terminal-transition.service";

/** The caller owns the run row lock and has classified its current status. */
export async function cancelLockedRun(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly status: "queued" | "pending" | "running";
    readonly completedAt: Date;
    readonly runnerCancellationMode: RunnerCancellationMode;
    readonly error?: string;
  },
): Promise<void> {
  const [updated] = await transitionAgentRunsToTerminal(tx, {
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
  if (!updated) {
    throw new Error("Locked cancellable run was not updated");
  }
  await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, args.runId));
  await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, args.runId));
}
