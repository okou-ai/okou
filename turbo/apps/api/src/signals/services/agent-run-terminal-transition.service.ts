import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, inArray, type SQL } from "drizzle-orm";

import { cleanupDisconnectedPersonalModelProviderAccounts } from "./model-provider-account.service";
import type { Tx } from "../../lib/db-types";

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
      | "runnerCancellationMode"
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
  readonly startedAt: Date | null;
}

/** Runs that became terminal before reaching `running` have no runner that
 * will report completion, so their active row is released by the transaction
 * that made them terminal. Started runs keep their row until the completion
 * webhook or timeout cleanup releases it.
 */
export function neverStartedRunIds(
  transitions: readonly TerminalRunTransition[],
): readonly string[] {
  return transitions
    .filter((transition) => {
      return transition.startedAt === null;
    })
    .map((transition) => {
      return transition.runId;
    });
}

/** Deletes the active rows of the given runs. The row is the per-thread
 * active-run lock, so a concurrent launch may wait on this uncommitted DELETE
 * while holding other locks. This MUST be the last statement of the enclosing
 * transaction: issuing any further statement or lock afterwards risks a
 * deadlock with that launch.
 */
export async function releaseActiveAgentRuns(
  tx: Tx,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) {
    return;
  }
  await tx
    .delete(activeAgentRuns)
    .where(inArray(activeAgentRuns.runId, [...runIds]));
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
      startedAt: agentRuns.startedAt,
    });
  if (transitioned.length === 0) {
    return transitioned;
  }
  const runIds = transitioned.map((run) => {
    return run.runId;
  });
  await tx
    .delete(agentRunConnectorDiagnosticRegistrations)
    .where(inArray(agentRunConnectorDiagnosticRegistrations.runId, runIds));
  await cleanupDisconnectedPersonalModelProviderAccounts(tx, transitioned);
  return transitioned;
}
