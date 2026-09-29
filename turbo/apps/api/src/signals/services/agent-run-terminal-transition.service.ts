import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, inArray, type SQL } from "drizzle-orm";

import { cleanupDisconnectedPersonalModelProviderAccounts } from "./model-provider-account.service";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

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

export interface ReleasedRunSlot {
  readonly runId: string;
  readonly orgId: string;
}

/**
 * The single release of run slots: deletes the active rows of the given runs
 * and returns the slots this call freed. Callers with other writes pass their
 * transaction; standalone releases pass the database directly. Schedule
 * `scheduleReleasedSlotPicks$` after commit, before any other side effect.
 * The row is the per-thread active-run lock, so a concurrent launch may wait
 * on this uncommitted DELETE while holding other locks. When called inside a
 * transaction, this MUST be its last statement. `condition` narrows the release
 * to rows that still match it at delete time.
 */
export async function releaseRunSlots(
  db: Db,
  runIds: readonly string[],
  condition?: SQL,
): Promise<readonly ReleasedRunSlot[]> {
  if (runIds.length === 0) {
    return [];
  }
  return await db
    .delete(activeAgentRuns)
    .where(and(inArray(activeAgentRuns.runId, [...runIds]), condition))
    .returning({
      runId: activeAgentRuns.runId,
      orgId: activeAgentRuns.orgId,
    });
}

/** Release the slots of the never-started runs among `transitions`. Same
 * last-statement rule as `releaseRunSlots`.
 */
export async function releaseNeverStartedRunSlots(
  tx: Tx,
  transitions: readonly TerminalRunTransition[],
): Promise<readonly ReleasedRunSlot[]> {
  return await releaseRunSlots(tx, neverStartedRunIds(transitions));
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
