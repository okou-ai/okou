import { agentRunSandboxIntent } from "@okouai/db/schema/agent-run-inference";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, inArray, type SQL } from "drizzle-orm";

import { fencePiInferenceTerminal } from "./pi-inference-lifecycle.service";
import { cleanupDisconnectedPersonalModelProviderAccounts } from "./model-provider-account.service";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

export const COMPUTE_CLOSURE_ERROR = "account_erasure:subject_closed";

/** The admission owner already holds B1 subjects and the run/session rows.
 * Closure has a separate capture lifecycle: preserve diagnostic and provider
 * locators, credit admission and queues instead of ordinary terminal cleanup.
 */
export async function stopErasureClosedComputeRun(
  tx: Tx,
  runId: string,
): Promise<void> {
  const transitioned = await tx
    .update(agentRuns)
    .set({
      status: "cancelled",
      completedAt: nowDate(),
      error: COMPUTE_CLOSURE_ERROR,
    })
    .where(
      and(
        eq(agentRuns.id, runId),
        inArray(agentRuns.status, ["pending", "queued"]),
      ),
    )
    .returning({ launchSnapshot: agentRuns.launchSnapshot });
  for (const run of transitioned) {
    await fencePiInferenceTerminal(tx, runId, run.launchSnapshot, nowDate());
  }
}

type TerminalRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "timeout" | "cancelled"
>;
type AgentRunWrite = typeof agentRuns.$inferInsert;

type TerminalRunValues = Readonly<
  {
    readonly status: TerminalRunStatus;
    readonly completedAt: Date;
  } & Partial<
    Pick<
      AgentRunWrite,
      | "creditAdmitted"
      | "error"
      | "failureReason"
      | "result"
      | "sandboxId"
      | "sandboxReuseResult"
      | "workspaceReuseResult"
    >
  >
>;

interface TransitionAgentRunsToTerminalArgs {
  readonly values: TerminalRunValues;
  readonly conditions: readonly [SQL, ...SQL[]];
}

interface TerminalRunTransition {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runnerGroup: string | null;
}

export async function transitionAgentRunsToTerminal(
  tx: Tx,
  args: TransitionAgentRunsToTerminalArgs,
): Promise<readonly TerminalRunTransition[]> {
  const transitioned = await tx
    .update(agentRuns)
    .set(args.values)
    .where(and(...args.conditions))
    .returning({
      runId: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      runnerGroup: agentRuns.runnerGroup,
      modelProviderId: agentRuns.modelProviderId,
      launchSnapshot: agentRuns.launchSnapshot,
    });
  if (transitioned.length === 0) {
    return transitioned;
  }
  for (const run of transitioned) {
    await fencePiInferenceTerminal(
      tx,
      run.runId,
      run.launchSnapshot,
      args.values.completedAt,
    );
  }
  await tx.delete(agentRunConnectorDiagnosticRegistrations).where(
    inArray(
      agentRunConnectorDiagnosticRegistrations.runId,
      transitioned.map((run) => {
        return run.runId;
      }),
    ),
  );
  await cleanupDisconnectedPersonalModelProviderAccounts(tx, transitioned);
  return transitioned;
}

/** The caller holds complete B1 and Run lifecycle locks. Durable consumer failure
 * fences execution and schedules effects without deleting usage, provider,
 * diagnostic or physical Sandbox cleanup evidence. */
export async function failDeferredPiRun(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly snapshot: typeof agentRuns.$inferSelect.launchSnapshot;
    readonly at: Date;
    readonly status: "failed" | "cancelled" | "timeout";
    readonly error: string;
  },
): Promise<void> {
  await tx
    .update(agentRuns)
    .set({ status: args.status, completedAt: args.at, error: args.error })
    .where(eq(agentRuns.id, args.runId));
  await fencePiInferenceTerminal(tx, args.runId, args.snapshot, args.at);
  await tx
    .update(agentRunSandboxIntent)
    .set({ terminalEffectsPendingAt: args.at })
    .where(eq(agentRunSandboxIntent.runId, args.runId));
}
