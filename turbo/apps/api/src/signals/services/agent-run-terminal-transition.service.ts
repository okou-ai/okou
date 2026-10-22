import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { captureBillingRunTerminalSql } from "@okouai/db/operations/billing-run-lifecycle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { command } from "ccstate";
import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";

import { notFound, runNotCancellable } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { scheduleReleasedSlotPicks$ } from "./agent-run-slot-scheduling.service";

import type { Tx } from "../../lib/db-types";
import { disconnectedPersonalAccountCleanupSql } from "./model-provider-account.service";

export interface CancelRunResult {
  readonly apiStartTime: number;
  readonly runId: string;
  readonly previousStatus: string;
  readonly userId: string;
  readonly orgId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly runnerCancellationMode: RunnerCancellationMode | null;
  readonly runnerCancellationChanged: boolean;
  readonly alreadyCancelled: boolean;
}

interface CancelRunArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runnerCancellationMode: RunnerCancellationMode;
  readonly userRequested?: true;
  /** Cleanup retries must not turn an already-cancelled Run into a new hard request. */
  readonly preserveExistingCancellation?: true;
  readonly apiStartTime?: number;
}

type LockedCancellationRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "status"
  | "userId"
  | "orgId"
  | "sandboxId"
  | "runnerGroup"
  | "chatThreadId"
  | "cancellationRecoveryCompleted"
>;

/** Build only result values; this helper has no capabilities. */
function cancellationResult(
  run: LockedCancellationRun,
  apiStartTime: number,
  runnerCancellationMode: RunnerCancellationMode | null,
  runnerCancellationChanged: boolean,
  alreadyCancelled: boolean,
): CancelRunResult {
  return {
    apiStartTime,
    runId: run.id,
    previousStatus: run.status,
    userId: run.userId,
    orgId: run.orgId,
    sandboxId: run.sandboxId,
    runnerGroup: run.runnerGroup,
    chatThreadId: run.chatThreadId,
    cancellationRecoveryCompleted: run.cancellationRecoveryCompleted,
    runnerCancellationMode,
    runnerCancellationChanged,
    alreadyCancelled,
  };
}

const lockedCancellationRunFields = {
  id: agentRuns.id,
  status: agentRuns.status,
  userId: agentRuns.userId,
  orgId: agentRuns.orgId,
  sandboxId: agentRuns.sandboxId,
  runnerGroup: agentRuns.runnerGroup,
  runnerCancellationMode: agentRuns.runnerCancellationMode,
  chatThreadId: agentRuns.chatThreadId,
  cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
} as const;

const ACTIVE_STATUSES = ["pending", "running"] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

function isActiveStatus(status: string): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

const cancelledRunFields = Object.freeze({
  runId: agentRuns.id,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  runnerGroup: agentRuns.runnerGroup,
  modelProviderId: agentRuns.modelProviderId,
  startedAt: agentRuns.startedAt,
});

function cancellableRunConditions(run: {
  readonly id: string;
  readonly status: string;
}): readonly [SQL, ...SQL[]] {
  return [eq(agentRuns.id, run.id), eq(agentRuns.status, run.status)];
}

function cancellationOwnerCondition(
  runId: string,
  owner: Pick<CancelRunArgs, "userId" | "orgId" | "userRequested">,
) {
  return and(
    eq(agentRuns.id, runId),
    eq(agentRuns.userId, owner.userId),
    eq(agentRuns.orgId, owner.orgId),
    owner.userRequested
      ? or(
          isNull(agentRuns.officialWorkflowProvenance),
          notInArray(agentRuns.triggerSource, [
            "automation-schedule",
            "automation-event",
          ]),
        )
      : undefined,
  );
}

/**
 * The cancellation mutation owner. Classify under the existing tenant-scoped
 * Run lock, then commit terminal state, attached cleanup and queue deletion
 * together. Never-started slot release is the last SQL statement; started
 * Runs retain their slots until Runner completion. Recovery and hard-upgrade
 * behavior remain distinct from the post-commit side-effect dispatcher.
 */
export const cancelRun$ = command(
  async (
    { set },
    args: CancelRunArgs,
    signal: AbortSignal,
  ): Promise<
    | ReturnType<typeof notFound>
    | ReturnType<typeof runNotCancellable>
    | CancelRunResult
  > => {
    const apiStartTime = args.apiStartTime ?? now();
    const runId = args.runId.toLowerCase();
    const writeDb = set(writeDb$);
    let releasedSlots: readonly ReleasedRunSlot[] = [];
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0049; new non-billing transactions are prohibited.
    const transition = writeDb.transaction(async (tx) => {
      const [run] = await tx
        .select(lockedCancellationRunFields)
        .from(agentRuns)
        .where(cancellationOwnerCondition(runId, args))
        .for("update");
      if (!run) {
        return notFound(`No such run: '${args.runId}'`);
      }
      if (run.status === "cancelled") {
        const runnerCancellationChanged =
          !args.preserveExistingCancellation &&
          args.runnerCancellationMode === "hard" &&
          run.runnerCancellationMode !== "hard";
        if (runnerCancellationChanged) {
          await tx
            .update(agentRuns)
            .set({ runnerCancellationMode: "hard" })
            .where(eq(agentRuns.id, run.id));
        }
        return cancellationResult(
          run,
          apiStartTime,
          runnerCancellationChanged ? "hard" : run.runnerCancellationMode,
          runnerCancellationChanged,
          true,
        );
      }
      if (!isActiveStatus(run.status)) {
        return runNotCancellable(
          `Run cannot be cancelled: current status is '${run.status}'`,
        );
      }
      const runnerCancellationMode =
        run.cancellationRecoveryCompleted === null
          ? "hard"
          : args.runnerCancellationMode;
      // The shared terminal transition also captures billing facts and
      // removes attached diagnostics and disconnected personal accounts.
      const transitions = await transitionAgentRunsToTerminal(tx, {
        values: {
          status: "cancelled",
          completedAt: new Date(apiStartTime),
          runnerCancellationMode,
        },
        conditions: cancellableRunConditions(run),
      });
      if (transitions.length === 0) {
        throw new Error("Locked cancellable run was not updated");
      }
      await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, run.id));
      // The active-row DELETE is the last SQL statement. A started Run keeps its slot.
      const releasableRunIds = neverStartedRunIds(transitions);
      if (releasableRunIds.length > 0) {
        releasedSlots = await tx
          .delete(activeAgentRuns)
          .where(inArray(activeAgentRuns.runId, [...releasableRunIds]))
          .returning({
            runId: activeAgentRuns.runId,
            orgId: activeAgentRuns.orgId,
          });
      }
      return cancellationResult(
        run,
        apiStartTime,
        runnerCancellationMode,
        true,
        false,
      );
    });
    const result = await transition;
    signal.throwIfAborted();
    // Only committed slot releases schedule picks, before other side effects.
    set(scheduleReleasedSlotPicks$, releasedSlots, signal);
    return result;
  },
);

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
      | "runnerCancellationMode"
      | "error"
      | "failureReason"
      | "result"
      | "sandboxId"
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
  const terminal = tx.$with("terminal_runs").as(
    tx
      .update(agentRuns)
      .set(args.values)
      .where(and(...args.conditions))
      .returning({ ...cancelledRunFields }),
  );
  // The terminal UPDATE and its billing capture are one atomic statement.
  const capturedBilling = tx.$with("terminal_run_billing", {}).as(
    captureBillingRunTerminalSql({
      condition: inArray(
        agentRuns.id,
        tx.select({ runId: terminal.runId }).from(terminal),
      ),
      status: args.values.status,
      completedAt: args.values.completedAt,
    }),
  );
  const transitioned = await tx
    .with(terminal, capturedBilling)
    .select({
      runId: terminal.runId,
      orgId: terminal.orgId,
      userId: terminal.userId,
      runnerGroup: terminal.runnerGroup,
      modelProviderId: terminal.modelProviderId,
      startedAt: terminal.startedAt,
    })
    .from(terminal);
  if (transitioned.length === 0) {
    return transitioned;
  }
  const runIds = transitioned.map((run) => {
    return run.runId;
  });
  await tx
    .delete(agentRunConnectorDiagnosticRegistrations)
    .where(inArray(agentRunConnectorDiagnosticRegistrations.runId, runIds));
  for (const statement of disconnectedPersonalAccountCleanupSql(transitioned)) {
    await tx.execute(statement);
  }
  return transitioned;
}

export type DeletedOwner =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string };

/** Clerk deletion stops runtime work without erasing credentials or history.
 * This owner-scoped statement commits terminal cancellation, runner queue and
 * transient diagnostic cleanup, and all held slots together, including started
 * runs. Only committed releases schedule picks; notification stays with Clerk.
 */
export const cancelClerkDeletedOwnerRuns$ = command(
  async (
    { set },
    owner: DeletedOwner,
    signal: AbortSignal,
  ): Promise<readonly TerminalRunTransition[]> => {
    const db = set(writeDb$);
    const runScope =
      owner.kind === "user"
        ? eq(agentRuns.userId, owner.userId)
        : eq(agentRuns.orgId, owner.orgId);
    const completedAt = nowDate();
    const cancelled = db.$with("clerk_stopped_runs").as(
      db
        .update(agentRuns)
        .set({
          status: "cancelled",
          completedAt,
          runnerCancellationMode: "hard",
        })
        .where(and(runScope, inArray(agentRuns.status, ["pending", "running"])))
        .returning({ ...cancelledRunFields }),
    );
    const capturedBilling = db.$with("clerk_captured_run_billing", {}).as(
      captureBillingRunTerminalSql({
        condition: inArray(
          agentRuns.id,
          db.select({ runId: cancelled.runId }).from(cancelled),
        ),
        status: "cancelled",
        completedAt,
      }),
    );
    const removedJobs = db.$with("clerk_removed_runner_jobs").as(
      db
        .delete(runnerJobQueue)
        .where(
          inArray(
            runnerJobQueue.runId,
            db.select({ id: agentRuns.id }).from(agentRuns).where(runScope),
          ),
        )
        .returning({ runId: runnerJobQueue.runId }),
    );
    // These registrations are transient runtime attachments, not stored
    // credentials or history. Do not run disconnected account cleanup here.
    const removedDiagnostics = db.$with("clerk_removed_run_diagnostics").as(
      db
        .delete(agentRunConnectorDiagnosticRegistrations)
        .where(
          inArray(
            agentRunConnectorDiagnosticRegistrations.runId,
            db.select({ runId: cancelled.runId }).from(cancelled),
          ),
        )
        .returning({ runId: agentRunConnectorDiagnosticRegistrations.runId }),
    );
    const released = db.$with("clerk_released_run_slots").as(
      db
        .delete(activeAgentRuns)
        .where(
          inArray(
            activeAgentRuns.runId,
            db.select({ id: cancelled.runId }).from(cancelled),
          ),
        )
        .returning({
          runId: activeAgentRuns.runId,
          orgId: activeAgentRuns.orgId,
        }),
    );
    const runs = await db
      .with(
        cancelled,
        capturedBilling,
        removedJobs,
        removedDiagnostics,
        released,
      )
      .select({
        runId: cancelled.runId,
        orgId: cancelled.orgId,
        userId: cancelled.userId,
        runnerGroup: cancelled.runnerGroup,
        startedAt: cancelled.startedAt,
        releasedOrgId: released.orgId,
      })
      .from(cancelled)
      .leftJoin(released, eq(released.runId, cancelled.runId));
    signal.throwIfAborted();
    set(
      scheduleReleasedSlotPicks$,
      runs.flatMap((run) => {
        return run.releasedOrgId === null
          ? []
          : [{ runId: run.runId, orgId: run.releasedOrgId }];
      }),
      signal,
    );
    return runs;
  },
);
