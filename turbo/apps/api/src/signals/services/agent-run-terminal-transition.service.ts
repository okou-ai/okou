import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import { captureBillingRunTerminalSql } from "@okouai/db/operations/billing-run-lifecycle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { command } from "ccstate";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import {
  and,
  count,
  gte,
  eq,
  exists,
  lt,
  gt,
  lte,
  ne,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { notFound, runNotCancellable } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { scheduleReleasedSlotPicks$ } from "./agent-run-slot-scheduling.service";

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

const cancellationLockedRows = alias(agentRuns, "cancellation_locked_run");
const cancellationTerminalRows = alias(agentRuns, "cancellation_terminal_runs");

function cancellationTerminalValues(
  apiStartTime: number,
  mode: RunnerCancellationMode,
) {
  return {
    status: "cancelled" as const,
    completedAt: new Date(apiStartTime),
    runnerCancellationMode: sql`CASE WHEN ${isNull(cancellationLockedRows.cancellationRecoveryCompleted)} THEN 'hard' ELSE ${mode} END`,
  };
}

function cancellationTerminalCondition() {
  // Use the locking CTE's returned state. A target-status predicate can discard
  // an older snapshot tuple before EvalPlanQual visits its updated version.
  return and(
    eq(agentRuns.id, cancellationLockedRows.id),
    inArray(cancellationLockedRows.status, ["pending", "running"]),
  );
}

function cancellationHardUpgradeCondition(
  args: Pick<
    CancelRunArgs,
    "preserveExistingCancellation" | "runnerCancellationMode"
  >,
) {
  return and(
    eq(agentRuns.id, cancellationLockedRows.id),
    eq(cancellationLockedRows.status, "cancelled"),
    !args.preserveExistingCancellation && args.runnerCancellationMode === "hard"
      ? or(
          isNull(cancellationLockedRows.runnerCancellationMode),
          notInArray(cancellationLockedRows.runnerCancellationMode, ["hard"]),
        )
      : sql`false`,
  );
}

function cancellationAccountCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    isNotNull(modelProviderAccounts.disconnectedAt),
    gte(
      query.select({ count: count() }).from(sql`cancellation_run_billing`),
      0,
    ),
    gte(
      query
        .select({ count: count() })
        .from(sql`cancellation_removed_diagnostics`),
      0,
    ),
    sql`EXISTS (
    SELECT 1 FROM cancellation_terminal_runs
    WHERE cancellation_terminal_runs.model_provider_id = ${modelProviderAccounts.id}
      AND cancellation_terminal_runs.org_id = ${modelProviderAccounts.orgId}
      AND cancellation_terminal_runs.user_id = ${modelProviderAccounts.userId}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${agentRuns}
    WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
      AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
      AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
      AND ${agentRuns.status} IN ('pending', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM cancellation_terminal_runs
        WHERE cancellation_terminal_runs.id = ${agentRuns.id}
      )
  )`,
  );
}

function cancellationProviderCleanupCondition() {
  return sql`${modelProviders.id} IN (
    SELECT model_provider_id FROM cancellation_removed_accounts
  ) AND NOT EXISTS (
    SELECT 1 FROM ${modelProviderAccounts}
    WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
      AND NOT EXISTS (
        SELECT 1 FROM cancellation_removed_accounts
        WHERE cancellation_removed_accounts.id = ${modelProviderAccounts.id}
      )
  )`;
}

function cancellationJobCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    inArray(
      runnerJobQueue.runId,
      query
        .select({
          id: sql`${cancellationTerminalRows.id}`.mapWith(agentRuns.id),
        })
        .from(sql`cancellation_terminal_runs`),
    ),
    gte(
      query.select({ count: count() }).from(sql`cancellation_run_billing`),
      0,
    ),
    gte(
      query
        .select({ count: count() })
        .from(sql`cancellation_removed_diagnostics`),
      0,
    ),
    gte(
      query
        .select({ count: count() })
        .from(sql`cancellation_removed_providers`),
      0,
    ),
  );
}

function cancellationSlotReleaseCondition() {
  const query = new QueryBuilder();
  return and(
    inArray(
      activeAgentRuns.runId,
      query
        .select({
          id: sql`${cancellationTerminalRows.id}`.mapWith(agentRuns.id),
        })
        .from(sql`cancellation_terminal_runs`)
        .where(isNull(cancellationTerminalRows.startedAt)),
    ),
    gte(
      query.select({ count: count() }).from(sql`cancellation_run_billing`),
      0,
    ),
    gte(
      query
        .select({ count: count() })
        .from(sql`cancellation_removed_diagnostics`),
      0,
    ),
    gte(
      query
        .select({ count: count() })
        .from(sql`cancellation_removed_providers`),
      0,
    ),
    gte(
      query.select({ count: count() }).from(sql`cancellation_removed_jobs`),
      0,
    ),
  );
}

type CommittedCancellationRow = LockedCancellationRun & {
  readonly runnerCancellationMode: RunnerCancellationMode | null;
  readonly terminalRunId: string | null;
  readonly upgradedRunId: string | null;
  readonly releasedOrgId: string | null;
};

function committedCancellationResult(
  run: CommittedCancellationRow | undefined,
  args: CancelRunArgs,
  apiStartTime: number,
) {
  if (!run) {
    return notFound(`No such run: '${args.runId}'`);
  }
  if (run.status === "cancelled") {
    const changed = run.upgradedRunId !== null;
    return cancellationResult(
      run,
      apiStartTime,
      changed ? "hard" : run.runnerCancellationMode,
      changed,
      true,
    );
  }
  if (!isActiveStatus(run.status)) {
    return runNotCancellable(
      `Run cannot be cancelled: current status is '${run.status}'`,
    );
  }
  if (run.terminalRunId === null) {
    throw new Error("Locked cancellable run was not updated");
  }
  const mode =
    run.cancellationRecoveryCompleted === null
      ? "hard"
      : args.runnerCancellationMode;
  return cancellationResult(run, apiStartTime, mode, true, false);
}

/** The original tenant-scoped Run lock classifies current state, followed by
 * one atomic terminal/billing/cleanup/queue/slot statement. Started slots remain
 * held. The entry's existing post-commit abort and scheduling order is retained. */
export const cancelRun$ = command(
  async ({ set }, args: CancelRunArgs, signal: AbortSignal) => {
    const apiStartTime = args.apiStartTime ?? now();
    const writeDb = set(writeDb$);
    const locked = writeDb
      .$with("cancellation_locked_run")
      .as(
        writeDb
          .select(lockedCancellationRunFields)
          .from(agentRuns)
          .where(cancellationOwnerCondition(args.runId.toLowerCase(), args))
          .for("update"),
      );
    const terminal = writeDb.$with("cancellation_terminal_runs").as(
      writeDb
        .update(agentRuns)
        .set(
          cancellationTerminalValues(apiStartTime, args.runnerCancellationMode),
        )
        .from(locked)
        .where(cancellationTerminalCondition())
        .returning({ ...cancelledRunFields }),
    );
    const hardUpgrade = writeDb
      .$with("cancellation_hard_upgrade")
      .as(
        writeDb
          .update(agentRuns)
          .set({ runnerCancellationMode: "hard" })
          .from(locked)
          .where(cancellationHardUpgradeCondition(args))
          .returning({ id: agentRuns.id }),
      );
    const billing = writeDb
      .$with("cancellation_run_billing", { runId: billingRunAttribution.runId })
      .as(
        captureBillingRunTerminalSql({
          condition: inArray(
            agentRuns.id,
            writeDb.select({ id: terminal.runId }).from(terminal),
          ),
          status: "cancelled",
          completedAt: new Date(apiStartTime),
        }),
      );
    const diagnostics = writeDb.$with("cancellation_removed_diagnostics").as(
      writeDb
        .delete(agentRunConnectorDiagnosticRegistrations)
        .where(
          inArray(
            agentRunConnectorDiagnosticRegistrations.runId,
            writeDb.select({ id: terminal.runId }).from(terminal),
          ),
        )
        .returning({ runId: agentRunConnectorDiagnosticRegistrations.runId }),
    );
    const accounts = writeDb.$with("cancellation_removed_accounts").as(
      writeDb
        .delete(modelProviderAccounts)
        .where(cancellationAccountCleanupCondition())
        .returning({
          id: modelProviderAccounts.id,
          modelProviderId: modelProviderAccounts.modelProviderId,
        }),
    );
    const providers = writeDb
      .$with("cancellation_removed_providers")
      .as(
        writeDb
          .delete(modelProviders)
          .where(cancellationProviderCleanupCondition())
          .returning({ id: modelProviders.id }),
      );
    const jobs = writeDb
      .$with("cancellation_removed_jobs")
      .as(
        writeDb
          .delete(runnerJobQueue)
          .where(cancellationJobCleanupCondition())
          .returning({ runId: runnerJobQueue.runId }),
      );
    const released = writeDb.$with("cancellation_released_slots").as(
      writeDb
        .delete(activeAgentRuns)
        .where(cancellationSlotReleaseCondition())
        .returning({
          runId: activeAgentRuns.runId,
          orgId: activeAgentRuns.orgId,
        }),
    );
    const [run] = await writeDb
      .with(
        locked,
        terminal,
        hardUpgrade,
        billing,
        diagnostics,
        accounts,
        providers,
        jobs,
        released,
      )
      .select({
        id: locked.id,
        status: locked.status,
        userId: locked.userId,
        orgId: locked.orgId,
        sandboxId: locked.sandboxId,
        runnerGroup: locked.runnerGroup,
        runnerCancellationMode: locked.runnerCancellationMode,
        chatThreadId: locked.chatThreadId,
        cancellationRecoveryCompleted: locked.cancellationRecoveryCompleted,
        terminalRunId: terminal.runId,
        upgradedRunId: hardUpgrade.id,
        releasedOrgId: released.orgId,
      })
      .from(locked)
      .leftJoin(terminal, eq(terminal.runId, locked.id))
      .leftJoin(hardUpgrade, eq(hardUpgrade.id, locked.id))
      .leftJoin(released, eq(released.runId, locked.id));
    signal.throwIfAborted();
    const result = committedCancellationResult(run, args, apiStartTime);
    // Only committed slot releases schedule picks, before other side effects.
    const releasedSlots =
      run === undefined || run.releasedOrgId === null
        ? []
        : [{ runId: run.id, orgId: run.releasedOrgId }];
    set(scheduleReleasedSlotPicks$, releasedSlots, signal);
    return result;
  },
);

interface TerminalRunTransition {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runnerGroup: string | null;
  readonly startedAt: Date | null;
}

export interface ReleasedRunSlot {
  readonly runId: string;
  readonly orgId: string;
}

/**
 * Pure description of the active rows to release and the freed-slot result.
 * Each caller executes it on its own database or existing transaction. Schedule
 * `scheduleReleasedSlotPicks$` after commit, before any other side effect.
 * The row is the per-thread active-run lock, so a concurrent launch may wait
 * on this uncommitted DELETE while holding other locks. When called inside a
 * transaction, this MUST be its last statement. `condition` narrows the release
 * to rows that still match it at delete time.
 */
export function runSlotReleasePlan(runIds: readonly string[], condition?: SQL) {
  if (runIds.length === 0) {
    return null;
  }
  return {
    from: activeAgentRuns,
    where: and(inArray(activeAgentRuns.runId, [...runIds]), condition),
    returning: {
      runId: activeAgentRuns.runId,
      orgId: activeAgentRuns.orgId,
    },
  };
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

function bannedUserAccountCleanupCondition() {
  return sql`EXISTS (
        SELECT 1 FROM banned_runs
        WHERE banned_runs.model_provider_id = ${modelProviderAccounts.id}
          AND banned_runs.org_id = ${modelProviderAccounts.orgId}
          AND banned_runs.user_id = ${modelProviderAccounts.userId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${agentRuns}
        WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
          AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
          AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
          AND ${agentRuns.status} IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM banned_runs WHERE banned_runs.id = ${agentRuns.id}
          )
      )`;
}

function bannedUserProviderCleanupCondition() {
  return sql`${modelProviders.id} IN (
      SELECT model_provider_id FROM banned_removed_accounts
    ) AND NOT EXISTS (
      SELECT 1 FROM ${modelProviderAccounts}
      WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
        AND NOT EXISTS (
          SELECT 1 FROM banned_removed_accounts
          WHERE banned_removed_accounts.id = ${modelProviderAccounts.id}
        )
    )`;
}

// Ban behavior is deliberately separate from account-deletion stop behavior.
// The entry observes cancellation after scheduling committed releases and
// notifying runners, preserving this finite write's existing abort boundary.
export const cancelClerkBannedUserRuns$ = command(
  async function cancelClerkBannedUserRuns(
    { set },
    userId: string,
    _signal: AbortSignal,
  ) {
    const db = set(writeDb$);
    const completedAt = nowDate();
    const cancelled = db.$with("banned_runs").as(
      db
        .update(agentRuns)
        .set({
          status: "cancelled",
          completedAt,
          runnerCancellationMode: "hard",
        })
        .where(
          and(
            eq(agentRuns.userId, userId),
            inArray(agentRuns.status, ["pending", "running"]),
          ),
        )
        .returning({
          runId: agentRuns.id,
          orgId: agentRuns.orgId,
          userId: agentRuns.userId,
          runnerGroup: agentRuns.runnerGroup,
          modelProviderId: agentRuns.modelProviderId,
          startedAt: agentRuns.startedAt,
        }),
    );
    const capturedBilling = db
      .$with("banned_run_billing", { runId: billingRunAttribution.runId })
      .as(
        captureBillingRunTerminalSql({
          condition: inArray(
            agentRuns.id,
            db.select({ runId: cancelled.runId }).from(cancelled),
          ),
          status: "cancelled",
          completedAt,
        }),
      );
    const removedDiagnostics = db.$with("banned_removed_diagnostics").as(
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
    const removedAccounts = db.$with("banned_removed_accounts").as(
      db
        .delete(modelProviderAccounts)
        .where(
          and(
            isNotNull(modelProviderAccounts.disconnectedAt),
            bannedUserAccountCleanupCondition(),
            gte(db.select({ total: count() }).from(capturedBilling), 0),
            gte(db.select({ total: count() }).from(removedDiagnostics), 0),
          ),
        )
        .returning({
          id: modelProviderAccounts.id,
          modelProviderId: modelProviderAccounts.modelProviderId,
        }),
    );
    const removedProviders = db
      .$with("banned_removed_providers")
      .as(
        db
          .delete(modelProviders)
          .where(bannedUserProviderCleanupCondition())
          .returning({ id: modelProviders.id }),
      );
    // The statement snapshot still sees preceding Run/account rows. Cleanup
    // explicitly subtracts the winning terminal/deleted rows instead of relying
    // on a later statement seeing those writes. Slot release consumes all cleanup.
    const released = db.$with("banned_released_slots").as(
      db
        .delete(activeAgentRuns)
        .where(
          and(
            inArray(
              activeAgentRuns.runId,
              db
                .select({ runId: cancelled.runId })
                .from(cancelled)
                .where(isNull(cancelled.startedAt)),
            ),
            gte(db.select({ total: count() }).from(capturedBilling), 0),
            gte(db.select({ total: count() }).from(removedDiagnostics), 0),
            gte(db.select({ total: count() }).from(removedProviders), 0),
          ),
        )
        .returning({
          runId: activeAgentRuns.runId,
          orgId: activeAgentRuns.orgId,
        }),
    );
    return await db
      .with(
        cancelled,
        capturedBilling,
        removedDiagnostics,
        removedAccounts,
        removedProviders,
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
  },
);

interface StaleRunTimeoutCandidate {
  readonly id: string;
  readonly status: string;
  readonly chatThreadId: string | null;
}

type LockedTimeoutRun = Pick<
  typeof agentRuns.$inferSelect,
  | "status"
  | "launchSnapshot"
  | "orgId"
  | "userId"
  | "sandboxId"
  | "runnerGroup"
  | "chatThreadId"
>;

export interface StaleRunTimeoutResult {
  readonly previousStatus: "pending" | "running";
  readonly orgId: string;
  readonly userId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly releasedSlots: readonly ReleasedRunSlot[];
}

type TimeoutTransactionResult =
  | { readonly kind: "retry"; readonly chatThreadId: string | null }
  | { readonly kind: "skipped" }
  | { readonly kind: "committed"; readonly timeout: StaleRunTimeoutResult };

const timeoutLockedRows = alias(agentRuns, "timeout_locked_run");
const timeoutActiveRows = alias(activeAgentRuns, "timeout_locked_active");
const timeoutTerminalRows = alias(agentRuns, "timeout_terminal_runs");

function timeoutRunLockQuery(runId: string) {
  return new QueryBuilder()
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      launchSnapshot: agentRuns.launchSnapshot,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      sandboxId: agentRuns.sandboxId,
      runnerGroup: agentRuns.runnerGroup,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update", { of: agentRuns })
    .limit(1);
}

function timeoutActiveLockQuery(
  runId: string,
  status: string,
  expectedChatThreadId: string | null,
) {
  const query = new QueryBuilder();
  return query
    .select({
      runId: activeAgentRuns.runId,
      lastHeartbeatAt: activeAgentRuns.lastHeartbeatAt,
    })
    .from(activeAgentRuns)
    .where(
      and(
        eq(activeAgentRuns.runId, runId),
        exists(
          query
            .select({ id: sql`${timeoutLockedRows.id}`.mapWith(agentRuns.id) })
            .from(sql`timeout_locked_run`)
            .where(
              and(
                eq(timeoutLockedRows.status, status),
                inArray(timeoutLockedRows.status, ["pending", "running"]),
                expectedChatThreadId === null
                  ? isNull(timeoutLockedRows.chatThreadId)
                  : eq(timeoutLockedRows.chatThreadId, expectedChatThreadId),
              ),
            ),
        ),
      ),
    )
    .for("update", { of: activeAgentRuns });
}

function timeoutTransitionCondition(cutoff: Date) {
  // Both original locks precede the decision. Test the heartbeat returned by
  // its lock, so a refresh that committed while we waited prevents all writes.
  return and(
    eq(agentRuns.id, timeoutLockedRows.id),
    exists(
      new QueryBuilder()
        .select({
          id: sql`${timeoutActiveRows.runId}`.mapWith(activeAgentRuns.runId),
        })
        .from(sql`timeout_locked_active`)
        .where(lt(timeoutActiveRows.lastHeartbeatAt, cutoff)),
    ),
  );
}

function timeoutAccountCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    isNotNull(modelProviderAccounts.disconnectedAt),
    gte(query.select({ count: count() }).from(sql`timeout_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`timeout_removed_diagnostics`),
      0,
    ),
    sql`EXISTS (
      SELECT 1 FROM timeout_terminal_runs
      WHERE timeout_terminal_runs.model_provider_id = ${modelProviderAccounts.id}
        AND timeout_terminal_runs.org_id = ${modelProviderAccounts.orgId}
        AND timeout_terminal_runs.user_id = ${modelProviderAccounts.userId}
    ) AND NOT EXISTS (
      SELECT 1 FROM ${agentRuns}
      WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
        AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
        AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
        AND ${agentRuns.status} IN ('pending', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM timeout_terminal_runs
          WHERE timeout_terminal_runs.id = ${agentRuns.id}
        )
    )`,
  );
}

function timeoutProviderCleanupCondition() {
  return sql`${modelProviders.id} IN (
    SELECT model_provider_id FROM timeout_removed_accounts
  ) AND NOT EXISTS (
    SELECT 1 FROM ${modelProviderAccounts}
    WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
      AND NOT EXISTS (
        SELECT 1 FROM timeout_removed_accounts
        WHERE timeout_removed_accounts.id = ${modelProviderAccounts.id}
      )
  )`;
}

function timeoutJobCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    inArray(
      runnerJobQueue.runId,
      query
        .select({ id: sql`${timeoutTerminalRows.id}`.mapWith(agentRuns.id) })
        .from(sql`timeout_terminal_runs`),
    ),
    gte(query.select({ count: count() }).from(sql`timeout_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`timeout_removed_diagnostics`),
      0,
    ),
    gte(
      query.select({ count: count() }).from(sql`timeout_removed_providers`),
      0,
    ),
  );
}

function timeoutSlotReleaseCondition() {
  const query = new QueryBuilder();
  return and(
    inArray(
      activeAgentRuns.runId,
      query
        .select({ id: sql`${timeoutTerminalRows.id}`.mapWith(agentRuns.id) })
        .from(sql`timeout_terminal_runs`),
    ),
    gte(query.select({ count: count() }).from(sql`timeout_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`timeout_removed_diagnostics`),
      0,
    ),
    gte(
      query.select({ count: count() }).from(sql`timeout_removed_providers`),
      0,
    ),
    gte(query.select({ count: count() }).from(sql`timeout_removed_jobs`), 0),
  );
}

type TimeoutStatementRow = LockedTimeoutRun & {
  readonly id: string;
  readonly lastHeartbeatAt: Date | null;
  readonly terminalRunId: string | null;
  readonly releasedOrgId: string | null;
};

function timeoutStatementResult(
  row: TimeoutStatementRow | undefined,
  run: StaleRunTimeoutCandidate,
  expectedChatThreadId: string | null,
  cutoff: Date,
): TimeoutTransactionResult {
  if (!row) {
    return { kind: "skipped" };
  }
  if (row.chatThreadId !== expectedChatThreadId) {
    return { kind: "retry", chatThreadId: row.chatThreadId };
  }
  if (
    row.status !== run.status ||
    (row.status !== "pending" && row.status !== "running") ||
    row.lastHeartbeatAt === null ||
    row.lastHeartbeatAt >= cutoff
  ) {
    return { kind: "skipped" };
  }
  if (row.terminalRunId === null) {
    throw new Error("Locked stale run lost its timeout transition");
  }
  return {
    kind: "committed",
    timeout: {
      previousStatus: row.status,
      orgId: row.orgId,
      userId: row.userId,
      sandboxId: row.sandboxId,
      runnerGroup: row.runnerGroup,
      chatThreadId: row.chatThreadId,
      releasedSlots:
        row.releasedOrgId === null
          ? []
          : [{ runId: row.id, orgId: row.releasedOrgId }],
    },
  };
}

const timeoutTerminalFields = {
  id: agentRuns.id,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  modelProviderId: agentRuns.modelProviderId,
} as const;

function timeoutTerminalValues(completedAt: Date, timeoutReason: string) {
  return {
    status: "timeout" as const,
    runnerCancellationMode: "hard" as const,
    completedAt,
    error: timeoutReason,
  };
}

export const commitStaleRunTimeout$ = command(
  async (
    { set },
    run: StaleRunTimeoutCandidate,
    cutoff: Date,
    timeoutReason: string,
    signal: AbortSignal,
  ): Promise<StaleRunTimeoutResult | undefined> => {
    const db = set(writeDb$);
    let expectedChatThreadId = run.chatThreadId;
    while (true) {
      signal.throwIfAborted();
      const completedAt = nowDate();
      const locked = db
        .$with("timeout_locked_run")
        .as(timeoutRunLockQuery(run.id));
      const active = db
        .$with("timeout_locked_active")
        .as(timeoutActiveLockQuery(run.id, run.status, expectedChatThreadId));
      const terminal = db.$with("timeout_terminal_runs").as(
        db
          .update(agentRuns)
          .set(timeoutTerminalValues(completedAt, timeoutReason))
          .from(locked)
          .where(timeoutTransitionCondition(cutoff))
          .returning({ ...timeoutTerminalFields }),
      );
      const billing = db
        .$with("timeout_run_billing", { runId: billingRunAttribution.runId })
        .as(
          captureBillingRunTerminalSql({
            condition: inArray(
              agentRuns.id,
              db.select({ id: terminal.id }).from(terminal),
            ),
            status: "timeout",
            completedAt,
          }),
        );
      const diagnostics = db.$with("timeout_removed_diagnostics").as(
        db
          .delete(agentRunConnectorDiagnosticRegistrations)
          .where(
            inArray(
              agentRunConnectorDiagnosticRegistrations.runId,
              db.select({ id: terminal.id }).from(terminal),
            ),
          )
          .returning({ runId: agentRunConnectorDiagnosticRegistrations.runId }),
      );
      const accounts = db.$with("timeout_removed_accounts").as(
        db
          .delete(modelProviderAccounts)
          .where(timeoutAccountCleanupCondition())
          .returning({
            id: modelProviderAccounts.id,
            modelProviderId: modelProviderAccounts.modelProviderId,
          }),
      );
      const providers = db
        .$with("timeout_removed_providers")
        .as(
          db
            .delete(modelProviders)
            .where(timeoutProviderCleanupCondition())
            .returning({ id: modelProviders.id }),
        );
      const jobs = db
        .$with("timeout_removed_jobs")
        .as(
          db
            .delete(runnerJobQueue)
            .where(timeoutJobCleanupCondition())
            .returning({ runId: runnerJobQueue.runId }),
        );
      const released = db.$with("timeout_released_slots").as(
        db
          .delete(activeAgentRuns)
          .where(timeoutSlotReleaseCondition())
          .returning({
            runId: activeAgentRuns.runId,
            orgId: activeAgentRuns.orgId,
          }),
      );
      const [row] = await db
        .with(
          locked,
          active,
          terminal,
          billing,
          diagnostics,
          accounts,
          providers,
          jobs,
          released,
        )
        .select({
          id: locked.id,
          status: locked.status,
          launchSnapshot: locked.launchSnapshot,
          orgId: locked.orgId,
          userId: locked.userId,
          sandboxId: locked.sandboxId,
          runnerGroup: locked.runnerGroup,
          chatThreadId: locked.chatThreadId,
          lastHeartbeatAt: active.lastHeartbeatAt,
          terminalRunId: terminal.id,
          releasedOrgId: released.orgId,
        })
        .from(locked)
        .leftJoin(active, eq(active.runId, locked.id))
        .leftJoin(terminal, eq(terminal.id, locked.id))
        .leftJoin(released, eq(released.runId, locked.id));
      signal.throwIfAborted();
      const result = timeoutStatementResult(
        row,
        run,
        expectedChatThreadId,
        cutoff,
      );
      if (result.kind === "retry") {
        expectedChatThreadId = result.chatThreadId;
        continue;
      }
      return result.kind === "committed" ? result.timeout : undefined;
    }
  },
);

export type FailedQueuedRunResult =
  | {
      readonly status: "failed";
      readonly releasedSlots: readonly ReleasedRunSlot[];
    }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };

const poisonLockedRows = alias(agentRuns, "poison_locked_run");
const poisonJobRows = alias(runnerJobQueue, "poison_locked_job");
const poisonTerminalRows = alias(agentRuns, "poison_terminal_runs");

function poisonRunLockQuery(runId: string) {
  return new QueryBuilder()
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update", { of: agentRuns });
}

function poisonJobLockQuery(runId: string) {
  const query = new QueryBuilder();
  return query
    .select({
      runId: runnerJobQueue.runId,
      expiresAt: runnerJobQueue.expiresAt,
    })
    .from(runnerJobQueue)
    .where(
      and(
        eq(runnerJobQueue.runId, runId),
        exists(
          query
            .select({ id: sql`${poisonLockedRows.id}`.mapWith(agentRuns.id) })
            .from(sql`poison_locked_run`)
            .where(eq(poisonLockedRows.status, "pending")),
        ),
      ),
    )
    .for("update", { of: runnerJobQueue });
}

function poisonTransitionCondition() {
  // Only the queue row returned by its original lock decides expiry; no Run
  // or lifecycle write may precede that current-row decision.
  return and(
    eq(agentRuns.id, poisonLockedRows.id),
    exists(
      new QueryBuilder()
        .select({
          id: sql`${poisonJobRows.runId}`.mapWith(runnerJobQueue.runId),
        })
        .from(sql`poison_locked_job`)
        .where(gt(poisonJobRows.expiresAt, sql`now()`)),
    ),
  );
}

const poisonTerminalFields = {
  id: agentRuns.id,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  modelProviderId: agentRuns.modelProviderId,
  startedAt: agentRuns.startedAt,
} as const;

function poisonTerminalValues(completedAt: Date, errorMessage: string) {
  return { status: "failed" as const, completedAt, error: errorMessage };
}

interface PoisonStatementRow {
  readonly id: string;
  readonly status: string;
  readonly jobRunId: string | null;
  readonly jobIsExpired: boolean | null;
  readonly terminalRunId: string | null;
  readonly releasedOrgId: string | null;
}

function poisonStatementResult(
  row: PoisonStatementRow | undefined,
): FailedQueuedRunResult {
  if (!row || row.status !== "pending") {
    return { status: "run-not-found" };
  }
  if (row.jobRunId === null || row.jobIsExpired) {
    return { status: "job-not-found" };
  }
  if (row.terminalRunId === null) {
    throw new Error("Locked pending run was not failed");
  }
  return {
    status: "failed",
    releasedSlots:
      row.releasedOrgId === null
        ? []
        : [{ runId: row.id, orgId: row.releasedOrgId }],
  };
}
function poisonAccountCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    isNotNull(modelProviderAccounts.disconnectedAt),
    gte(query.select({ count: count() }).from(sql`poison_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`poison_removed_diagnostics`),
      0,
    ),
    sql`EXISTS (
      SELECT 1 FROM poison_terminal_runs
      WHERE poison_terminal_runs.model_provider_id = ${modelProviderAccounts.id}
        AND poison_terminal_runs.org_id = ${modelProviderAccounts.orgId}
        AND poison_terminal_runs.user_id = ${modelProviderAccounts.userId}
    ) AND NOT EXISTS (
      SELECT 1 FROM ${agentRuns}
      WHERE ${eq(agentRuns.modelProviderId, modelProviderAccounts.id)}
        AND ${eq(agentRuns.orgId, modelProviderAccounts.orgId)}
        AND ${eq(agentRuns.userId, modelProviderAccounts.userId)}
        AND ${agentRuns.status} IN ('pending', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM poison_terminal_runs
          WHERE poison_terminal_runs.id = ${agentRuns.id}
        )
    )`,
  );
}

function poisonProviderCleanupCondition() {
  return sql`${modelProviders.id} IN (
    SELECT model_provider_id FROM poison_removed_accounts
  ) AND NOT EXISTS (
    SELECT 1 FROM ${modelProviderAccounts}
    WHERE ${eq(modelProviderAccounts.modelProviderId, modelProviders.id)}
      AND NOT EXISTS (
        SELECT 1 FROM poison_removed_accounts
        WHERE poison_removed_accounts.id = ${modelProviderAccounts.id}
      )
  )`;
}

function poisonJobCleanupCondition() {
  const query = new QueryBuilder();
  return and(
    or(
      inArray(
        runnerJobQueue.runId,
        query
          .select({ id: sql`${poisonLockedRows.id}`.mapWith(agentRuns.id) })
          .from(sql`poison_locked_run`)
          .where(ne(poisonLockedRows.status, "pending")),
      ),
      inArray(
        runnerJobQueue.runId,
        query
          .select({ id: sql`${poisonTerminalRows.id}`.mapWith(agentRuns.id) })
          .from(sql`poison_terminal_runs`),
      ),
    ),
    gte(query.select({ count: count() }).from(sql`poison_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`poison_removed_diagnostics`),
      0,
    ),
    gte(
      query.select({ count: count() }).from(sql`poison_removed_providers`),
      0,
    ),
  );
}

function poisonSlotReleaseCondition() {
  const query = new QueryBuilder();
  return and(
    inArray(
      activeAgentRuns.runId,
      query
        .select({ id: sql`${poisonTerminalRows.id}`.mapWith(agentRuns.id) })
        .from(sql`poison_terminal_runs`)
        .where(isNull(poisonTerminalRows.startedAt)),
    ),
    gte(query.select({ count: count() }).from(sql`poison_run_billing`), 0),
    gte(
      query.select({ count: count() }).from(sql`poison_removed_diagnostics`),
      0,
    ),
    gte(
      query.select({ count: count() }).from(sql`poison_removed_providers`),
      0,
    ),
    gte(query.select({ count: count() }).from(sql`poison_removed_jobs`), 0),
  );
}

/** Quarantine an invalid queued context under the original Run then queue locks.
 * Only a pending Run with a current unexpired job may fail. A nonpending Run
 * only loses queued work; started slots remain until completion. */
export const commitFailedQueuedRun$ = command(
  async (
    { set },
    runId: string,
    errorMessage: string,
    signal: AbortSignal,
  ): Promise<FailedQueuedRunResult> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const completedAt = nowDate();
    const locked = db.$with("poison_locked_run").as(poisonRunLockQuery(runId));
    const job = db.$with("poison_locked_job").as(poisonJobLockQuery(runId));
    const terminal = db.$with("poison_terminal_runs").as(
      db
        .update(agentRuns)
        .set(poisonTerminalValues(completedAt, errorMessage))
        .from(locked)
        .where(poisonTransitionCondition())
        .returning({ ...poisonTerminalFields }),
    );
    const billing = db
      .$with("poison_run_billing", { runId: billingRunAttribution.runId })
      .as(
        captureBillingRunTerminalSql({
          condition: inArray(
            agentRuns.id,
            db.select({ id: terminal.id }).from(terminal),
          ),
          status: "failed",
          completedAt,
        }),
      );
    const diagnostics = db.$with("poison_removed_diagnostics").as(
      db
        .delete(agentRunConnectorDiagnosticRegistrations)
        .where(
          inArray(
            agentRunConnectorDiagnosticRegistrations.runId,
            db.select({ id: terminal.id }).from(terminal),
          ),
        )
        .returning({ runId: agentRunConnectorDiagnosticRegistrations.runId }),
    );
    const accounts = db.$with("poison_removed_accounts").as(
      db
        .delete(modelProviderAccounts)
        .where(poisonAccountCleanupCondition())
        .returning({
          id: modelProviderAccounts.id,
          modelProviderId: modelProviderAccounts.modelProviderId,
        }),
    );
    const providers = db
      .$with("poison_removed_providers")
      .as(
        db
          .delete(modelProviders)
          .where(poisonProviderCleanupCondition())
          .returning({ id: modelProviders.id }),
      );
    const jobs = db
      .$with("poison_removed_jobs")
      .as(
        db
          .delete(runnerJobQueue)
          .where(poisonJobCleanupCondition())
          .returning({ runId: runnerJobQueue.runId }),
      );
    const released = db.$with("poison_released_slots").as(
      db.delete(activeAgentRuns).where(poisonSlotReleaseCondition()).returning({
        runId: activeAgentRuns.runId,
        orgId: activeAgentRuns.orgId,
      }),
    );
    const [row] = await db
      .with(
        locked,
        job,
        terminal,
        billing,
        diagnostics,
        accounts,
        providers,
        jobs,
        released,
      )
      .select({
        id: locked.id,
        status: locked.status,
        jobRunId: job.runId,
        jobIsExpired: lte(job.expiresAt, sql`now()`).mapWith(
          nullableDriverValueDecoder(pgBooleanDecoder),
        ),
        terminalRunId: terminal.id,
        releasedOrgId: released.orgId,
      })
      .from(locked)
      .leftJoin(job, eq(job.runId, locked.id))
      .leftJoin(terminal, eq(terminal.id, locked.id))
      .leftJoin(released, eq(released.runId, locked.id));
    signal.throwIfAborted();
    return poisonStatementResult(row);
  },
);
