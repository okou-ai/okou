import {
  RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  type RunnerPreference,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runnerState } from "@okouai/db/runtime/runner-state";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { command } from "ccstate";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

const RUNNER_REUSE_PROTECTION_MS = 2000;
const RUNNER_EXACT_HISTORY_PROTECTION_MS = Math.min(
  1000,
  RUNNER_REUSE_PROTECTION_MS,
);
// A short bridge covers a terminal source before active-producer inventory
// arrives. Only current producer proof earns the longer telemetry-close budget.
const RUNNER_FINALIZING_COMPLETION_BRIDGE_MS = 1500;
const RUNNER_REUSE_HOLDER_FRESH_MS = 30_000;

const finalizingSourceRun = alias(agentRuns, "finalizing_source_run");
const peerFinalizingRunnerState = alias(runnerState, "peer_finalizing_runner");
const currentRun = alias(agentRuns, "finalizing_current_run");
const precedingRun = alias(agentRuns, "finalizing_preceding_run");

/** Select identity before eligibility; an older compatible Run is not the predecessor. */
function runnerFinalizingSourceRunId(args: {
  readonly runId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
}): SQL {
  const preceding = new QueryBuilder()
    .select({ id: precedingRun.id })
    .from(precedingRun)
    .where(
      and(
        isNotNull(precedingRun.chatThreadId),
        eq(precedingRun.chatThreadId, currentRun.chatThreadId),
        eq(precedingRun.userId, currentRun.userId),
        eq(precedingRun.orgId, currentRun.orgId),
        ne(precedingRun.id, currentRun.id),
        isNotNull(precedingRun.startedAt),
        // Claims use the database clock; creation uses the API clock. Bound
        // admission order within its own clock domain, never compare the two.
        lte(precedingRun.createdAt, currentRun.createdAt),
      ),
    )
    .orderBy(
      sql`${precedingRun.startedAt} DESC NULLS LAST`,
      sql`${precedingRun.createdAt} DESC NULLS LAST`,
      sql`${precedingRun.id} DESC NULLS LAST`,
    )
    .limit(1)
    .as("finalizing_predecessor");
  // Keep the ordered LIMIT inside a parameterized Chat lookup. Joining all
  // history before limiting otherwise makes PostgreSQL sort the whole Chat.
  const source = new QueryBuilder()
    .select({ id: preceding.id })
    .from(currentRun)
    .innerJoinLateral(preceding, sql`true`)
    .where(
      and(
        eq(currentRun.id, args.runId),
        eq(
          args.reuseKey,
          sql`'thread:' || cast(${currentRun.chatThreadId} as text)`,
        ),
      ),
    );
  return sql`(${source})`;
}

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
  readonly inventory:
    | typeof runnerState.activeReuseProducers
    | typeof peerFinalizingRunnerState.activeReuseProducers;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly sourceRunId: SQLWrapper;
}): SQL {
  return arrayContains(
    args.inventory,
    sql`jsonb_build_array(jsonb_build_object(
      'runId', cast(${args.sourceRunId} as text),
      'reuseKey', cast(${args.reuseKey} as text),
      'profile', cast(${args.profile} as text)
    ))`,
  );
}

function pendingFinalizingProducerCondition(args: {
  readonly inventory:
    | typeof runnerState.activeReuseProducers
    | typeof peerFinalizingRunnerState.activeReuseProducers;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly sourceRunId: SQLWrapper;
  readonly protectedAfter: Date;
}): SQL {
  return (
    and(
      discoveryWindowCondition(args.protectedAfter),
      activeProducerCondition(args),
    ) ?? sql`false`
  );
}

function capableHomeCondition(args: {
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
}): SQL {
  const heldHomeStates = sql`jsonb_build_array(jsonb_build_object(
    'reuseKey', cast(${args.reuseKey} as text),
    'homeCaches', jsonb_build_array(jsonb_build_object(
      'profile', cast(${args.profile} as text), 'homeAffinityVersion', 1
    ))
  ))`;
  return sql`(
    ${arrayContains(runnerState.heldHomeStates, heldHomeStates)}
    AND ${arrayContains(runnerState.admittableProfiles, sql`jsonb_build_array(cast(${args.profile} as text))`)}
  )`;
}

function runnerStateHas(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly freshAfter: Date;
  readonly resourceCondition: SQL;
}): SQL {
  return exists(
    new QueryBuilder()
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
  readonly runnerId: SQLWrapper;
  readonly heartbeatGeneration: SQLWrapper;
  readonly runnerGroup: string;
  readonly profile: SQLWrapper;
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
    inArray(finalizingSourceRun.status, ["completed", "cancelled", "failed"]),
    or(
      gt(finalizingSourceRun.completedAt, args.completedAfter),
      args.activeProducer,
    ),
    eq(finalizingSourceRun.runnerGroup, args.runnerGroup),
    isNotNull(sql`${finalizingSourceRun.launchSnapshot}->>'runnerProfile'`),
    eq(
      sql`${finalizingSourceRun.launchSnapshot}->>'runnerProfile'`,
      args.profile,
    ),
    isNotNull(finalizingSourceRun.runnerId),
    isNotNull(finalizingSourceRun.runnerHeartbeatGeneration),
    eq(args.runnerId, finalizingSourceRun.runnerId),
    eq(args.heartbeatGeneration, finalizingSourceRun.runnerHeartbeatGeneration),
  );
}

function peerFinalizingPredecessorCondition(args: {
  readonly runnerGroup: string;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly activeProducer: SQL;
}): SQL | undefined {
  return and(
    finalizingPredecessorCondition({
      ...args,
      runnerId: peerFinalizingRunnerState.runnerId,
      heartbeatGeneration: peerFinalizingRunnerState.heartbeatGeneration,
    }),
    eq(peerFinalizingRunnerState.runnerGroup, args.runnerGroup),
    eq(peerFinalizingRunnerState.mode, "draining"),
    gt(peerFinalizingRunnerState.lastSeenAt, args.freshAfter),
    gt(peerFinalizingRunnerState.heartbeatGeneration, 0),
    isNotNull(finalizingSourceRun.completedAt),
    isNotNull(finalizingSourceRun.runnerHostname),
    ne(finalizingSourceRun.runnerHostname, ""),
    isNotNull(peerFinalizingRunnerState.runnerHostname),
    isNotNull(runnerState.runnerHostname),
    eq(
      peerFinalizingRunnerState.runnerHostname,
      finalizingSourceRun.runnerHostname,
    ),
    eq(runnerState.runnerHostname, peerFinalizingRunnerState.runnerHostname),
    ne(runnerState.runnerId, peerFinalizingRunnerState.runnerId),
    arrayContains(
      runnerState.admittableProfiles,
      sql`jsonb_build_array(cast(${args.profile} as text))`,
    ),
  );
}

function runnerStateHasFinalizingPredecessor(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly activeProducer: SQL;
  readonly peerActiveProducer: SQL;
}): SQL {
  return exists(
    new QueryBuilder()
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(
        finalizingSourceRun,
        eq(finalizingSourceRun.id, args.sourceRunId),
      )
      .leftJoin(
        peerFinalizingRunnerState,
        eq(peerFinalizingRunnerState.runnerId, finalizingSourceRun.runnerId),
      )
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          gt(runnerState.heartbeatGeneration, 0),
          or(
            finalizingPredecessorCondition({
              ...args,
              runnerId: runnerState.runnerId,
              heartbeatGeneration: runnerState.heartbeatGeneration,
            }),
            peerFinalizingPredecessorCondition({
              ...args,
              activeProducer: args.peerActiveProducer,
            }),
          ),
        ),
      ),
  );
}

function discoveryWindowCondition(after: Date): SQL | undefined {
  return or(
    isNull(runnerJobQueue.discoveryStartedAt),
    gt(runnerJobQueue.discoveryStartedAt, after),
  );
}

/**
 * Poll ordering runs before a job is selected, so any runner with qualifying
 * local reuse may prioritize the job independently of the globally selected
 * preference identity.
 */
export function runnerReusePreferencePollPriority(args: {
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
    args.currentDate.getTime() - RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
  );
  const producerProtectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const freshAfter = runnerReuseHolderFreshAfter(args.currentDate);
  const targetGenerationRunId = sql`${runnerJobQueue.executionContext}->'nativeContinuation'->>'generationRunId'`;
  const reuseKey = runnerJobQueue.reuseKey;
  const profile = runnerJobQueue.profile;
  const sourceRunId = runnerFinalizingSourceRunId({
    runId: runnerJobQueue.runId,
    reuseKey,
  });
  const exactCondition = reusableSandboxCondition({
    reuseKey,
    profile,
    historyGenerationRunId: targetGenerationRunId,
  });
  const reusableCondition = reusableSandboxCondition({ reuseKey, profile });
  const homeCondition = capableHomeCondition({ reuseKey, profile });
  const global = (resourceCondition: SQL) => {
    return runnerStateHas({
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const local = (resourceCondition: SQL) => {
    return runnerStateHas({
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
  const hasGlobalHome = global(homeCondition);
  const hasLocalHome = local(homeCondition);
  const pendingProducer = pendingFinalizingProducerCondition({
    inventory: runnerState.activeReuseProducers,
    reuseKey,
    profile,
    sourceRunId: finalizingSourceRun.id,
    protectedAfter: producerProtectedAfter,
  });
  const pendingPeerProducer = pendingFinalizingProducerCondition({
    inventory: peerFinalizingRunnerState.activeReuseProducers,
    reuseKey,
    profile,
    sourceRunId: finalizingSourceRun.id,
    protectedAfter: producerProtectedAfter,
  });
  const hasGlobalFinalizingPredecessor = runnerStateHasFinalizingPredecessor({
    runnerGroup: args.runnerGroup,
    sourceRunId,
    profile,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
    activeProducer: pendingProducer,
    peerActiveProducer: pendingPeerProducer,
  });
  const hasLocalFinalizingPredecessor = runnerStateHasFinalizingPredecessor({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    sourceRunId,
    profile,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
    activeProducer: pendingProducer,
    peerActiveProducer: pendingPeerProducer,
  });
  return sql`CASE
    WHEN ${and(
      discoveryWindowCondition(generationProtectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      isNotNull(targetGenerationRunId),
      hasGlobalExact,
    )}
    THEN CASE WHEN ${hasLocalExact} THEN 7 ELSE 0 END
    WHEN ${and(
      isNotNull(runnerJobQueue.reuseKey),
      discoveryWindowCondition(producerProtectedAfter),
      hasGlobalFinalizingPredecessor,
    )}
    THEN CASE
      WHEN ${hasLocalExact} THEN 6
      WHEN ${hasLocalFinalizingPredecessor} THEN 5
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalReusable,
    )}
    THEN CASE WHEN ${hasLocalReusable} THEN 4 ELSE 0 END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalHome,
    )}
    THEN CASE
      WHEN ${hasLocalReusable} THEN 4
      WHEN ${hasLocalHome} THEN 3
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
  peerFinalizingPredecessor: "peer_finalizing_predecessor",
  reusableSandbox: "matching_reusable_sandbox",
  homeCache: "matching_home_cache",
} as const satisfies Record<PositiveRunnerPreference["tier"], string>;

const noPreferenceResolutionByReason = {
  noReuseKey: "no_reuse_key",
  expired: "expired",
  noViableHolder: "no_viable_holder",
  lookupError: "lookup_error",
} as const satisfies Record<NoRunnerPreference["reason"], string>;

type RunnerPreferenceTelemetryResolution =
  | (typeof preferenceResolutionByTier)[keyof typeof preferenceResolutionByTier]
  | (typeof noPreferenceResolutionByReason)[keyof typeof noPreferenceResolutionByReason];

export function runnerReusePreferenceLookupError(): RunnerPreference {
  return {
    kind: "noPreference",
    reason: "lookupError",
  };
}

function runnerPreferenceTelemetryResolution(
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
      ? {
          runner_preference_tier: preference.tier,
          runner_preference_runner_id: preference.runnerIdentity.runnerId,
          runner_preference_heartbeat_generation: String(
            preference.runnerIdentity.heartbeatGeneration,
          ),
          runner_preference_expires_at: preference.expiresAt,
        }
      : { runner_preference_no_preference_reason: preference.reason }),
  };
}

interface RunnerReuseHolder {
  readonly runnerIdentity: PositiveRunnerPreference["runnerIdentity"];
  readonly hasExactHistoryGeneration: boolean;
  readonly isFinalizingPredecessor: boolean;
  readonly isPeerFinalizingPredecessor: boolean;
  readonly finalizingSourceHasActiveProducer: boolean;
  readonly hasReusableSandbox: boolean;
  readonly sourceCompletedAt: Date | null;
  readonly finalizingSourceRunId: string | null;
}

function runnerReuseHolderPlan(args: {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly historyGenerationRunId: string | undefined;
  readonly freshAfter: Date;
  readonly shouldLookUpExactGeneration: boolean;
  readonly shouldLookUpGenericReuse: boolean;
  readonly finalizingCompletedAfter: Date;
  readonly shouldLookUpFinalizingProducer: boolean;
}) {
  const reusableCondition = args.shouldLookUpGenericReuse
    ? reusableSandboxCondition({
        reuseKey: sql.param(args.reuseKey),
        profile: sql.param(args.profile),
      })
    : sql`false`;
  const homeCondition = args.shouldLookUpGenericReuse
    ? capableHomeCondition({
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
  const producerCondition = args.shouldLookUpFinalizingProducer
    ? activeProducerCondition({
        inventory: runnerState.activeReuseProducers,
        reuseKey: sql.param(args.reuseKey),
        profile: sql.param(args.profile),
        sourceRunId: finalizingSourceRun.id,
      })
    : sql`false`;
  const finalizingCondition =
    (args.shouldLookUpFinalizingProducer
      ? finalizingPredecessorCondition({
          runnerId: runnerState.runnerId,
          heartbeatGeneration: runnerState.heartbeatGeneration,
          runnerGroup: args.runnerGroup,
          profile: sql.param(args.profile),
          completedAfter: args.finalizingCompletedAfter,
          activeProducer: producerCondition,
        })
      : undefined) ?? sql`false`;
  const peerProducerCondition = args.shouldLookUpFinalizingProducer
    ? activeProducerCondition({
        inventory: peerFinalizingRunnerState.activeReuseProducers,
        reuseKey: sql.param(args.reuseKey),
        profile: sql.param(args.profile),
        sourceRunId: finalizingSourceRun.id,
      })
    : sql`false`;
  const peerFinalizingCondition =
    (args.shouldLookUpFinalizingProducer
      ? peerFinalizingPredecessorCondition({
          runnerGroup: args.runnerGroup,
          profile: sql.param(args.profile),
          freshAfter: args.freshAfter,
          completedAfter: args.finalizingCompletedAfter,
          activeProducer: peerProducerCondition,
        })
      : undefined) ?? sql`false`;
  const resourceRank = sql`CASE
    WHEN ${exactGenerationCondition} THEN 4
    WHEN ${finalizingCondition} THEN 3
    WHEN ${peerFinalizingCondition} THEN 3
    WHEN ${reusableCondition} THEN 2
    WHEN ${homeCondition} THEN 1
    ELSE 0
  END`;
  return {
    fields: {
      runnerId: runnerState.runnerId,
      heartbeatGeneration: runnerState.heartbeatGeneration,
      hasExactHistoryGeneration: sql`${exactGenerationCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      isFinalizingPredecessor: sql`${finalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      isPeerFinalizingPredecessor: sql`${peerFinalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      // A's producer inventory determines the budget even when B is empty or
      // advertises unrelated producers.
      finalizingSourceHasActiveProducer: sql`CASE
        WHEN ${peerFinalizingCondition} THEN ${peerProducerCondition}
        ELSE ${producerCondition}
      END`.mapWith(pgBooleanDecoder),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
      sourceCompletedAt: finalizingSourceRun.completedAt,
      finalizingSourceRunId: finalizingSourceRun.id,
    },
    joinCondition: eq(
      finalizingSourceRun.id,
      runnerFinalizingSourceRunId({
        runId: sql.param(args.runId),
        reuseKey: sql.param(args.reuseKey),
      }),
    ),
    where: and(
      eq(runnerState.runnerGroup, args.runnerGroup),
      eq(runnerState.mode, "running"),
      gt(runnerState.lastSeenAt, args.freshAfter),
      gt(runnerState.heartbeatGeneration, 0),
      or(
        exactGenerationCondition,
        finalizingCondition,
        peerFinalizingCondition,
        reusableCondition,
        homeCondition,
      ),
    ),
    orderBy: [desc(resourceRank), asc(runnerState.runnerId)] as const,
  };
}

interface RunnerReusePreferenceArgs {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly discoveryStartedAt: Date | null;
}

interface RunnerReusePreferenceResolution {
  readonly preference: RunnerPreference;
  readonly finalizingSource?: "active_producer" | "completion_bridge";
}

const startRunnerJobDiscovery$ = command(
  async (
    { set },
    args: { readonly runId: string; readonly runnerGroup: string },
  ): Promise<Date | null> => {
    // Both poll and notification can discover the committed row first. Keep
    // their original winner's time even when they race or publication retries.
    const [row] = await set(writeDb$)
      .update(runnerJobQueue)
      .set({
        discoveryStartedAt: sql`COALESCE(
          ${runnerJobQueue.discoveryStartedAt},
          ${sql.param(nowDate(), runnerJobQueue.discoveryStartedAt)}
        )`,
      })
      .where(
        and(
          eq(runnerJobQueue.runId, args.runId),
          eq(runnerJobQueue.runnerGroup, args.runnerGroup),
          gt(runnerJobQueue.expiresAt, sql`now()`),
        ),
      )
      .returning({ discoveryStartedAt: runnerJobQueue.discoveryStartedAt });
    if (!row) {
      return null;
    }
    if (row.discoveryStartedAt === null) {
      throw new Error("Discovered runner job is missing its start time");
    }
    return row.discoveryStartedAt;
  },
);

function runnerReuseLookupStages(
  args: {
    readonly discoveryStartedAt: Date | null;
    readonly historyGenerationRunId: string | undefined;
  },
  currentDate: Date,
) {
  const currentTime = currentDate.getTime();
  const startedAt = args.discoveryStartedAt?.getTime();
  return {
    shouldLookUpGenericReuse:
      startedAt === undefined ||
      startedAt + RUNNER_REUSE_PROTECTION_MS > currentTime,
    shouldLookUpFinalizingProducer:
      startedAt === undefined ||
      startedAt + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS > currentTime,
    shouldLookUpExactGeneration:
      args.historyGenerationRunId !== undefined &&
      (startedAt === undefined ||
        startedAt + RUNNER_EXACT_HISTORY_PROTECTION_MS > currentTime),
  };
}

const findRunnerReuseHolder$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly runnerGroup: string;
      readonly profile: string;
      readonly reuseKey: string;
      readonly historyGenerationRunId: string | undefined;
      readonly shouldLookUpGenericReuse: boolean;
      readonly shouldLookUpExactGeneration: boolean;
      readonly shouldLookUpFinalizingProducer: boolean;
    },
  ): Promise<RunnerReuseHolder | null> => {
    const currentDate = nowDate();
    const plan = runnerReuseHolderPlan({
      ...args,
      freshAfter: runnerReuseHolderFreshAfter(currentDate),
      finalizingCompletedAfter: new Date(
        currentDate.getTime() - RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
      ),
    });
    const [row] = await get(db$)
      .select(plan.fields)
      .from(runnerState)
      .leftJoin(finalizingSourceRun, plan.joinCondition)
      .leftJoin(
        peerFinalizingRunnerState,
        eq(peerFinalizingRunnerState.runnerId, finalizingSourceRun.runnerId),
      )
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(1);
    return row
      ? {
          runnerIdentity: {
            runnerId: row.runnerId,
            heartbeatGeneration: row.heartbeatGeneration,
          },
          hasExactHistoryGeneration: row.hasExactHistoryGeneration,
          isFinalizingPredecessor: row.isFinalizingPredecessor,
          isPeerFinalizingPredecessor: row.isPeerFinalizingPredecessor,
          finalizingSourceHasActiveProducer:
            row.finalizingSourceHasActiveProducer,
          hasReusableSandbox: row.hasReusableSandbox,
          sourceCompletedAt: row.sourceCompletedAt,
          finalizingSourceRunId: row.finalizingSourceRunId,
        }
      : null;
  },
);

export const resolveRunnerReusePreference$ = command(
  async (
    { set },
    args: RunnerReusePreferenceArgs,
  ): Promise<RunnerReusePreferenceResolution> => {
    if (!args.reuseKey) {
      return {
        preference: { kind: "noPreference", reason: "noReuseKey" },
      };
    }
    const lookupStages = runnerReuseLookupStages(args, nowDate());
    if (
      !lookupStages.shouldLookUpGenericReuse &&
      !lookupStages.shouldLookUpFinalizingProducer &&
      !lookupStages.shouldLookUpExactGeneration
    ) {
      return {
        preference: { kind: "noPreference", reason: "expired" },
      };
    }
    const lookupArgs = {
      runId: args.runId,
      runnerGroup: args.runnerGroup,
      profile: args.profile,
      reuseKey: args.reuseKey,
      historyGenerationRunId: args.historyGenerationRunId,
    };
    let holder = await set(findRunnerReuseHolder$, {
      ...lookupArgs,
      ...lookupStages,
    });

    // Prepare the holder before starting a new window. Both delivery paths
    // await this write before returning a poll result or publishing to Ably.
    const discoveryStartedAt =
      args.discoveryStartedAt ?? (await set(startRunnerJobDiscovery$, args));
    if (discoveryStartedAt === null) {
      return {
        preference: { kind: "noPreference", reason: "noViableHolder" },
      };
    }
    const savedStages = runnerReuseLookupStages(
      {
        discoveryStartedAt,
        historyGenerationRunId: args.historyGenerationRunId,
      },
      nowDate(),
    );
    if (
      !savedStages.shouldLookUpGenericReuse &&
      !savedStages.shouldLookUpFinalizingProducer &&
      !savedStages.shouldLookUpExactGeneration
    ) {
      return {
        preference: { kind: "noPreference", reason: "expired" },
      };
    }
    if (
      lookupStages.shouldLookUpExactGeneration !==
        savedStages.shouldLookUpExactGeneration ||
      lookupStages.shouldLookUpFinalizingProducer !==
        savedStages.shouldLookUpFinalizingProducer ||
      lookupStages.shouldLookUpGenericReuse !==
        savedStages.shouldLookUpGenericReuse
    ) {
      // A competing discovery or the lookup itself may have consumed a stage.
      // Select using the saved deadline without renewing it or retrying writes.
      holder = await set(findRunnerReuseHolder$, {
        ...lookupArgs,
        ...savedStages,
      });
    }
    return runnerReusePreferenceResult({
      holder,
      matchingReuseExpiresAt: new Date(
        discoveryStartedAt.getTime() + RUNNER_REUSE_PROTECTION_MS,
      ),
      finalizingProducerExpiresAt: new Date(
        discoveryStartedAt.getTime() +
          RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
      ),
      exactHistoryExpiresAt: args.historyGenerationRunId
        ? new Date(
            discoveryStartedAt.getTime() + RUNNER_EXACT_HISTORY_PROTECTION_MS,
          )
        : null,
      shouldLookUpGenericReuse: savedStages.shouldLookUpGenericReuse,
    });
  },
);

function runnerReusePreferenceResult(args: {
  readonly holder: RunnerReuseHolder | null;
  readonly matchingReuseExpiresAt: Date;
  readonly finalizingProducerExpiresAt: Date;
  readonly exactHistoryExpiresAt: Date | null;
  readonly shouldLookUpGenericReuse: boolean;
}): RunnerReusePreferenceResolution {
  const {
    holder,
    matchingReuseExpiresAt,
    finalizingProducerExpiresAt,
    exactHistoryExpiresAt,
    shouldLookUpGenericReuse,
  } = args;

  if (!holder) {
    return {
      preference: {
        kind: "noPreference",
        reason: shouldLookUpGenericReuse ? "noViableHolder" : "expired",
      },
    };
  }

  if (holder.hasExactHistoryGeneration) {
    if (!exactHistoryExpiresAt) {
      throw new Error("Exact history preference is missing its deadline");
    }
    return {
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: "exactSandbox",
        expiresAt: exactHistoryExpiresAt.toISOString(),
      },
    };
  }

  if (holder.isFinalizingPredecessor || holder.isPeerFinalizingPredecessor) {
    if (!holder.sourceCompletedAt || !holder.finalizingSourceRunId) {
      throw new Error(
        "Finalizing predecessor is missing its source identity or completion time",
      );
    }
    return {
      finalizingSource: holder.finalizingSourceHasActiveProducer
        ? "active_producer"
        : "completion_bridge",
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: holder.isPeerFinalizingPredecessor
          ? "peerFinalizingPredecessor"
          : "finalizingPredecessor",
        finalizingSourceRunId: holder.finalizingSourceRunId,
        expiresAt: (holder.finalizingSourceHasActiveProducer
          ? finalizingProducerExpiresAt
          : new Date(
              Math.min(
                holder.sourceCompletedAt.getTime() +
                  RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
                finalizingProducerExpiresAt.getTime(),
              ),
            )
        ).toISOString(),
      },
    };
  }

  return {
    preference: {
      kind: "preference",
      runnerIdentity: holder.runnerIdentity,
      tier: holder.hasReusableSandbox ? "reusableSandbox" : "homeCache",
      expiresAt: matchingReuseExpiresAt.toISOString(),
    },
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
