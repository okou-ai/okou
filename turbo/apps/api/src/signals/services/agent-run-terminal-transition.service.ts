import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
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
    });
  if (transitioned.length === 0) {
    return transitioned;
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
