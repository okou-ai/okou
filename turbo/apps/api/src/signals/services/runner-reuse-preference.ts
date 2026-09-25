import type { RunnerPreference } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runnerState } from "@okouai/db/schema/runner-state";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";

const RUNNER_REUSE_PROTECTION_MS = 2000;
const RUNNER_EXACT_HISTORY_PROTECTION_MS = Math.min(
  1000,
  RUNNER_REUSE_PROTECTION_MS,
);
const RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS = 1500;
const RUNNER_REUSE_HOLDER_FRESH_MS = 30_000;

const finalizingSourceRun = alias(agentRuns, "finalizing_source_run");

function runnerReuseHolderFreshAfter(currentDate: Date): Date {
  return new Date(currentDate.getTime() - RUNNER_REUSE_HOLDER_FRESH_MS);
}

function reusableSandboxCondition(args: {
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly historyGenerationRunId?: SQLWrapper;
}): SQL {
  const reusableSandbox =
    args.historyGenerationRunId !== undefined
      ? sql`jsonb_build_object(
        'profile', cast(${args.profile} as text),
        'historyGenerationRunId', cast(${args.historyGenerationRunId} as text)
      )`
      : sql`jsonb_build_object('profile', cast(${args.profile} as text))`;
  const heldSandboxStates = sql`jsonb_build_array(
    jsonb_build_object(
      'reuseKey', cast(${args.reuseKey} as text),
      'reusableSandbox', ${reusableSandbox}
    )
  )`;
  return arrayContains(runnerState.heldSandboxStates, heldSandboxStates);
}

function activeProducerCondition(args: {
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly historyGenerationRunId: SQLWrapper;
}): SQL {
  return arrayContains(
    runnerState.activeReuseProducers,
    sql`jsonb_build_array(jsonb_build_object(
      'runId', cast(${args.historyGenerationRunId} as text),
      'reuseKey', cast(${args.reuseKey} as text),
      'profile', cast(${args.profile} as text)
    ))`,
  );
}

function capableWorkspaceCondition(args: {
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
}): SQL {
  const heldWorkspaceStates = sql`jsonb_build_array(
    jsonb_build_object(
      'reuseKey', cast(${args.reuseKey} as text),
      'workspaceCaches', jsonb_build_array(
        jsonb_build_object(
          'profile', cast(${args.profile} as text),
          'workspaceAffinityVersion', 1
        )
      )
    )
  )`;
  const admittableProfiles = sql`jsonb_build_array(
    cast(${args.profile} as text)
  )`;
  return sql`(
    ${arrayContains(runnerState.heldWorkspaceStates, heldWorkspaceStates)}
    AND ${arrayContains(runnerState.admittableProfiles, admittableProfiles)}
  )`;
}

function runnerStateHas(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly freshAfter: Date;
  readonly resourceCondition: SQL;
}): SQL {
  return exists(
    args.db
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          gt(runnerState.heartbeatGeneration, 0),
          args.resourceCondition,
        ),
      ),
  );
}

function finalizingPredecessorCondition(args: {
  readonly runnerGroup: string;
  readonly completedAfter: Date;
  readonly activeProducer: SQL;
}): SQL | undefined {
  // The recent-completion guard also covers a current Runner whose first
  // producer-bearing heartbeat has not reached the API yet. The process
  // generation and short completion deadline bound that advisory preference.
  // admittableProfiles is remaining capacity, so it may be empty while this
  // process is still finalizing. Poll and Ably recipients enforce static
  // profile support before admitting the advisory preference.
  return and(
    eq(finalizingSourceRun.status, "completed"),
    or(
      gt(finalizingSourceRun.completedAt, args.completedAfter),
      args.activeProducer,
    ),
    eq(finalizingSourceRun.runnerGroup, args.runnerGroup),
    isNotNull(finalizingSourceRun.runnerId),
    isNotNull(finalizingSourceRun.runnerHeartbeatGeneration),
    eq(runnerState.runnerId, finalizingSourceRun.runnerId),
    eq(
      runnerState.heartbeatGeneration,
      finalizingSourceRun.runnerHeartbeatGeneration,
    ),
  );
}

function runnerStateHasFinalizingPredecessor(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly historyGenerationRunId: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly activeProducer: SQL;
}): SQL {
  return exists(
    args.db
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(
        finalizingSourceRun,
        eq(
          sql`${finalizingSourceRun.id}::text`,
          sql`cast(${args.historyGenerationRunId} as text)`,
        ),
      )
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          gt(runnerState.heartbeatGeneration, 0),
          finalizingPredecessorCondition({
            runnerGroup: args.runnerGroup,
            completedAfter: args.completedAfter,
            activeProducer: args.activeProducer,
          }),
        ),
      ),
  );
}

/**
 * Poll ordering runs before a job is selected, so any runner with qualifying
 * local reuse may prioritize the job independently of the globally selected
 * preference identity.
 */
export function runnerReusePreferencePollPriority(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly currentDate: Date;
}): SQL {
  const protectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_REUSE_PROTECTION_MS,
  );
  const generationProtectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_EXACT_HISTORY_PROTECTION_MS,
  );
  const finalizingCompletedAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const freshAfter = runnerReuseHolderFreshAfter(args.currentDate);
  const targetGenerationRunId = sql`${runnerJobQueue.executionContext}->'resumeSession'->>'historyGenerationRunId'`;
  const reuseKey = runnerJobQueue.reuseKey;
  const profile = runnerJobQueue.profile;
  const exactCondition = reusableSandboxCondition({
    reuseKey,
    profile,
    historyGenerationRunId: targetGenerationRunId,
  });
  const reusableCondition = reusableSandboxCondition({ reuseKey, profile });
  const workspaceCondition = capableWorkspaceCondition({ reuseKey, profile });
  const global = (resourceCondition: SQL) => {
    return runnerStateHas({
      db: args.db,
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const local = (resourceCondition: SQL) => {
    return runnerStateHas({
      db: args.db,
      runnerId: args.runnerId,
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const hasGlobalExact = global(exactCondition);
  const hasLocalExact = local(exactCondition);
  const hasGlobalReusable = global(reusableCondition);
  const hasLocalReusable = local(reusableCondition);
  const hasGlobalWorkspace = global(workspaceCondition);
  const hasLocalWorkspace = local(workspaceCondition);
  const pendingProducer =
    and(
      gt(runnerJobQueue.createdAt, protectedAfter),
      activeProducerCondition({
        reuseKey,
        profile,
        historyGenerationRunId: targetGenerationRunId,
      }),
    ) ?? sql`false`;
  const hasGlobalFinalizingPredecessor = runnerStateHasFinalizingPredecessor({
    db: args.db,
    runnerGroup: args.runnerGroup,
    historyGenerationRunId: targetGenerationRunId,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
    activeProducer: pendingProducer,
  });
  const hasLocalFinalizingPredecessor = runnerStateHasFinalizingPredecessor({
    db: args.db,
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    historyGenerationRunId: targetGenerationRunId,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
    activeProducer: pendingProducer,
  });
  return sql`CASE
    WHEN ${and(
      gt(runnerJobQueue.createdAt, generationProtectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      isNotNull(targetGenerationRunId),
      hasGlobalExact,
    )}
    THEN CASE WHEN ${hasLocalExact} THEN 7 ELSE 0 END
    WHEN ${and(
      isNotNull(runnerJobQueue.reuseKey),
      isNotNull(targetGenerationRunId),
      hasGlobalFinalizingPredecessor,
    )}
    THEN CASE
      WHEN ${hasLocalExact} THEN 6
      WHEN ${hasLocalFinalizingPredecessor} THEN 5
      ELSE 0
    END
    WHEN ${and(
      gt(runnerJobQueue.createdAt, protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalReusable,
    )}
    THEN CASE WHEN ${hasLocalReusable} THEN 4 ELSE 0 END
    WHEN ${and(
      gt(runnerJobQueue.createdAt, protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalWorkspace,
    )}
    THEN CASE
      WHEN ${hasLocalReusable} THEN 4
      WHEN ${hasLocalWorkspace} THEN 3
      ELSE 0
    END
    ELSE 0
  END`;
}

type PositiveRunnerPreference = Extract<
  RunnerPreference,
  { kind: "preference" }
>;
type NoRunnerPreference = Extract<RunnerPreference, { kind: "noPreference" }>;

const preferenceResolutionByTier = {
  exactSandbox: "exact_history_generation",
  finalizingPredecessor: "finalizing_predecessor",
  reusableSandbox: "matching_reusable_sandbox",
  workspaceCache: "matching_workspace_cache",
} as const satisfies Record<PositiveRunnerPreference["tier"], string>;

const noPreferenceResolutionByReason = {
  noReuseKey: "no_reuse_key",
  expired: "expired",
  noViableHolder: "no_viable_holder",
  lookupError: "lookup_error",
} as const satisfies Record<NoRunnerPreference["reason"], string>;

export type RunnerPreferenceTelemetryResolution =
  | (typeof preferenceResolutionByTier)[keyof typeof preferenceResolutionByTier]
  | (typeof noPreferenceResolutionByReason)[keyof typeof noPreferenceResolutionByReason];

export function runnerReusePreferenceLookupError(): RunnerPreference {
  return {
    kind: "noPreference",
    reason: "lookupError",
  };
}

export function runnerPreferenceTelemetryResolution(
  preference: RunnerPreference,
): RunnerPreferenceTelemetryResolution {
  if (preference.kind === "noPreference") {
    return noPreferenceResolutionByReason[preference.reason];
  }
  return preferenceResolutionByTier[preference.tier];
}

export function runnerPreferenceTelemetryDimensions(
  preference: RunnerPreference,
): Record<string, string> {
  return {
    runner_preference_resolution:
      runnerPreferenceTelemetryResolution(preference),
    runner_preference_decision_kind: preference.kind,
    ...(preference.kind === "preference"
      ? { runner_preference_tier: preference.tier }
      : { runner_preference_no_preference_reason: preference.reason }),
  };
}

interface RunnerReuseHolder {
  readonly runnerIdentity: PositiveRunnerPreference["runnerIdentity"];
  readonly hasExactHistoryGeneration: boolean;
  readonly isFinalizingPredecessor: boolean;
  readonly hasActiveProducer: boolean;
  readonly hasReusableSandbox: boolean;
  readonly sourceCompletedAt: Date | null;
}

async function selectRunnerReuseHolder(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly historyGenerationRunId: string | undefined;
  readonly freshAfter: Date;
  readonly shouldLookUpExactGeneration: boolean;
  readonly shouldLookUpGenericReuse: boolean;
  readonly finalizingCompletedAfter: Date;
}): Promise<RunnerReuseHolder | null> {
  const reusableCondition = args.shouldLookUpGenericReuse
    ? reusableSandboxCondition({
        reuseKey: sql.param(args.reuseKey),
        profile: sql.param(args.profile),
      })
    : sql`false`;
  const workspaceCondition = args.shouldLookUpGenericReuse
    ? capableWorkspaceCondition({
        reuseKey: sql.param(args.reuseKey),
        profile: sql.param(args.profile),
      })
    : sql`false`;
  const exactGenerationCondition =
    args.shouldLookUpExactGeneration &&
    args.historyGenerationRunId !== undefined
      ? reusableSandboxCondition({
          reuseKey: sql.param(args.reuseKey),
          profile: sql.param(args.profile),
          historyGenerationRunId: sql.param(args.historyGenerationRunId),
        })
      : sql`false`;
  const producerCondition =
    args.shouldLookUpGenericReuse && args.historyGenerationRunId
      ? activeProducerCondition({
          reuseKey: sql.param(args.reuseKey),
          profile: sql.param(args.profile),
          historyGenerationRunId: sql.param(args.historyGenerationRunId),
        })
      : sql`false`;
  const finalizingCondition =
    (args.historyGenerationRunId
      ? finalizingPredecessorCondition({
          runnerGroup: args.runnerGroup,
          completedAfter: args.finalizingCompletedAfter,
          activeProducer: producerCondition,
        })
      : undefined) ?? sql`false`;
  const resourceRank = sql`CASE
    WHEN ${exactGenerationCondition} THEN 4
    WHEN ${finalizingCondition} THEN 3
    WHEN ${reusableCondition} THEN 2
    WHEN ${workspaceCondition} THEN 1
    ELSE 0
  END`;
  const [holder] = await args.db
    .select({
      runnerId: runnerState.runnerId,
      heartbeatGeneration: runnerState.heartbeatGeneration,
      hasExactHistoryGeneration: sql`${exactGenerationCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      isFinalizingPredecessor: sql`${finalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasActiveProducer: sql`${producerCondition}`.mapWith(pgBooleanDecoder),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
      sourceCompletedAt: finalizingSourceRun.completedAt,
    })
    .from(runnerState)
    .leftJoin(
      finalizingSourceRun,
      args.historyGenerationRunId
        ? eq(finalizingSourceRun.id, args.historyGenerationRunId)
        : sql`false`,
    )
    .where(
      and(
        eq(runnerState.runnerGroup, args.runnerGroup),
        eq(runnerState.mode, "running"),
        gt(runnerState.lastSeenAt, args.freshAfter),
        gt(runnerState.heartbeatGeneration, 0),
        or(
          exactGenerationCondition,
          finalizingCondition,
          reusableCondition,
          workspaceCondition,
        ),
      ),
    )
    .orderBy(desc(resourceRank), asc(runnerState.runnerId))
    .limit(1);

  if (!holder) {
    return null;
  }
  return {
    runnerIdentity: {
      runnerId: holder.runnerId,
      heartbeatGeneration: holder.heartbeatGeneration,
    },
    hasExactHistoryGeneration: holder.hasExactHistoryGeneration,
    isFinalizingPredecessor: holder.isFinalizingPredecessor,
    hasActiveProducer: holder.hasActiveProducer,
    hasReusableSandbox: holder.hasReusableSandbox,
    sourceCompletedAt: holder.sourceCompletedAt,
  };
}

export async function resolveRunnerReusePreference(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
  readonly currentDate: Date;
  readonly onFinalizingSource?: (
    source: "active_producer" | "completion_bridge",
  ) => void;
}): Promise<RunnerPreference> {
  if (!args.reuseKey) {
    return {
      kind: "noPreference",
      reason: "noReuseKey",
    };
  }
  const matchingReuseExpiresAt = new Date(
    args.createdAt.getTime() + RUNNER_REUSE_PROTECTION_MS,
  );
  const exactHistoryExpiresAt = args.historyGenerationRunId
    ? new Date(args.createdAt.getTime() + RUNNER_EXACT_HISTORY_PROTECTION_MS)
    : null;
  const shouldLookUpGenericReuse = matchingReuseExpiresAt > args.currentDate;
  if (!shouldLookUpGenericReuse && !args.historyGenerationRunId) {
    return {
      kind: "noPreference",
      reason: "expired",
    };
  }

  const freshAfter = runnerReuseHolderFreshAfter(args.currentDate);
  const shouldLookUpExactGeneration =
    exactHistoryExpiresAt !== null && exactHistoryExpiresAt > args.currentDate;
  const finalizingCompletedAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const holder = await selectRunnerReuseHolder({
    db: args.db,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    reuseKey: args.reuseKey,
    historyGenerationRunId: args.historyGenerationRunId,
    freshAfter,
    shouldLookUpExactGeneration,
    shouldLookUpGenericReuse,
    finalizingCompletedAfter,
  });

  if (!holder) {
    return {
      kind: "noPreference",
      reason: shouldLookUpGenericReuse ? "noViableHolder" : "expired",
    };
  }

  if (holder.hasExactHistoryGeneration) {
    if (!exactHistoryExpiresAt) {
      throw new Error("Exact history preference is missing its deadline");
    }
    return {
      kind: "preference",
      runnerIdentity: holder.runnerIdentity,
      tier: "exactSandbox",
      expiresAt: exactHistoryExpiresAt.toISOString(),
    };
  }

  if (holder.isFinalizingPredecessor) {
    if (!holder.sourceCompletedAt) {
      throw new Error("Finalizing predecessor is missing its completion time");
    }
    args.onFinalizingSource?.(
      holder.hasActiveProducer ? "active_producer" : "completion_bridge",
    );
    return {
      kind: "preference",
      runnerIdentity: holder.runnerIdentity,
      tier: "finalizingPredecessor",
      expiresAt: (holder.hasActiveProducer
        ? matchingReuseExpiresAt
        : new Date(
            holder.sourceCompletedAt.getTime() +
              RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
          )
      ).toISOString(),
    };
  }

  return {
    kind: "preference",
    runnerIdentity: holder.runnerIdentity,
    tier: holder.hasReusableSandbox ? "reusableSandbox" : "workspaceCache",
    expiresAt: matchingReuseExpiresAt.toISOString(),
  };
}

export function runnerReuseKeyTelemetryKind(
  reuseKey: string | null,
): "thread" | "session" | "none" {
  if (reuseKey === null) {
    return "none";
  }
  return reuseKey.startsWith("thread:") ? "thread" : "session";
}
