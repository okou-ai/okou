import {
  RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  type RunnerPreference,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
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
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { command } from "ccstate";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import type { RunnerReusePreferenceTiming } from "./runner-reuse-timing.service";

const RUNNER_REUSE_PROTECTION_MS = 2000;
const RUNNER_EXACT_SOURCE_PROTECTION_MS = Math.min(
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

/**
 * Pending discovery reads the owned Thread's durable predecessor, independently
 * of its native readiness or a retained producer row. The first claim advances
 * the Thread to this Run; discovery must then stop treating it as a source.
 * Native intent is already frozen in the job's execution context before claim.
 */
function runnerThreadPredecessorRunId(args: {
  readonly runId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
}): SQL {
  const source = new QueryBuilder()
    .select({ id: chatThreads.frameworkSessionRunId })
    .from(currentRun)
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, currentRun.chatThreadId),
        eq(chatThreads.userId, currentRun.userId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, chatThreads.agentId),
        eq(agents.orgId, currentRun.orgId),
      ),
    )
    .where(
      and(
        eq(currentRun.id, args.runId),
        eq(currentRun.status, "pending"),
        ne(chatThreads.frameworkSessionRunId, currentRun.id),
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
  readonly sourceRunId?: SQLWrapper;
}): SQL {
  const reusableSandbox =
    args.sourceRunId !== undefined
      ? sql`jsonb_build_object(
        'profile', cast(${args.profile} as text),
        'sourceRunId', cast(${args.sourceRunId} as text)
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
  readonly sourceRunId?: SQLWrapper;
}): SQL {
  const homeCache =
    args.sourceRunId === undefined
      ? sql`jsonb_build_object('profile', cast(${args.profile} as text), 'homeAffinityVersion', 1)`
      : sql`jsonb_build_object('profile', cast(${args.profile} as text), 'homeAffinityVersion', 1,
        'sourceRunId', cast(${args.sourceRunId} as text))`;
  const heldHomeStates = sql`jsonb_build_array(jsonb_build_object(
    'reuseKey', cast(${args.reuseKey} as text),
    'homeCaches', jsonb_build_array(${homeCache})
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

/** Locality hint only: the source process need not still exist or advertise Home. */
function sourceHostProbeCondition(args: {
  readonly runnerGroup: string;
  readonly profile: SQLWrapper;
}): SQL {
  return (
    and(
      inArray(finalizingSourceRun.status, ["completed", "cancelled", "failed"]),
      eq(finalizingSourceRun.runnerGroup, args.runnerGroup),
      eq(
        sql`${finalizingSourceRun.launchSnapshot}->>'runnerProfile'`,
        args.profile,
      ),
      isNotNull(finalizingSourceRun.runnerHostname),
      ne(finalizingSourceRun.runnerHostname, ""),
      eq(runnerState.runnerHostname, finalizingSourceRun.runnerHostname),
      arrayContains(
        runnerState.admittableProfiles,
        sql`jsonb_build_array(cast(${args.profile} as text))`,
      ),
    ) ?? sql`false`
  );
}

function runnerStateHasSourceHostProbe(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
}): SQL {
  return exists(
    new QueryBuilder()
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(
        finalizingSourceRun,
        eq(finalizingSourceRun.id, args.sourceRunId),
      )
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          gt(runnerState.heartbeatGeneration, 0),
          sourceHostProbeCondition(args),
        ),
      ),
  );
}

function sourceHostProbePollHolders(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
}) {
  const { runnerId, ...conditions } = args;
  return {
    global: runnerStateHasSourceHostProbe(conditions),
    local: runnerStateHasSourceHostProbe({ ...conditions, runnerId }),
  };
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

function finalizingPollHolders(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQL;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly protectedAfter: Date;
}) {
  const producer = {
    reuseKey: args.reuseKey,
    profile: args.profile,
    sourceRunId: finalizingSourceRun.id,
    protectedAfter: args.protectedAfter,
  };
  const conditions = {
    runnerGroup: args.runnerGroup,
    sourceRunId: args.sourceRunId,
    profile: args.profile,
    freshAfter: args.freshAfter,
    completedAfter: args.completedAfter,
    activeProducer: pendingFinalizingProducerCondition({
      ...producer,
      inventory: runnerState.activeReuseProducers,
    }),
    peerActiveProducer: pendingFinalizingProducerCondition({
      ...producer,
      inventory: peerFinalizingRunnerState.activeReuseProducers,
    }),
  };
  return {
    global: runnerStateHasFinalizingPredecessor(conditions),
    local: runnerStateHasFinalizingPredecessor({
      ...conditions,
      runnerId: args.runnerId,
    }),
  };
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
  const sourceProtectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_EXACT_SOURCE_PROTECTION_MS,
  );
  const finalizingCompletedAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
  );
  const producerProtectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const freshAfter = runnerReuseHolderFreshAfter(args.currentDate);
  const { reuseKey, profile } = runnerJobQueue;
  const sourceRunId = runnerThreadPredecessorRunId({
    runId: runnerJobQueue.runId,
    reuseKey,
  });
  const exactCondition = reusableSandboxCondition({
    reuseKey,
    profile,
    sourceRunId,
  });
  const reusableCondition = reusableSandboxCondition({ reuseKey, profile });
  const homeCondition = capableHomeCondition({ reuseKey, profile });
  const sourceHomeCondition = capableHomeCondition({
    reuseKey,
    profile,
    sourceRunId,
  });
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
  const hasGlobalSourceHome = global(sourceHomeCondition);
  const hasLocalSourceHome = local(sourceHomeCondition);
  const hostProbe = sourceHostProbePollHolders({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    profile,
    sourceRunId,
    freshAfter,
  });
  const finalizing = finalizingPollHolders({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    reuseKey,
    profile,
    sourceRunId,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
    protectedAfter: producerProtectedAfter,
  });
  return sql`CASE
    WHEN ${and(
      discoveryWindowCondition(sourceProtectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      isNotNull(sourceRunId),
      hasGlobalExact,
    )}
    THEN CASE WHEN ${hasLocalExact} THEN 9 ELSE 0 END
    WHEN ${and(
      isNotNull(runnerJobQueue.reuseKey),
      discoveryWindowCondition(producerProtectedAfter),
      finalizing.global,
    )}
    THEN CASE
      WHEN ${hasLocalExact} THEN 8
      WHEN ${finalizing.local} THEN 7
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalSourceHome,
    )}
    THEN CASE
      WHEN ${hasLocalExact} THEN 6
      WHEN ${hasLocalSourceHome} THEN 5
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
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hostProbe.global,
    )}
    THEN CASE WHEN ${hostProbe.local} THEN 2 ELSE 0 END
    ELSE 0
  END`;
}

type PositiveRunnerPreference = Extract<
  RunnerPreference,
  { kind: "preference" }
>;
type NoRunnerPreference = Extract<RunnerPreference, { kind: "noPreference" }>;

const preferenceResolutionByTier = {
  exactSandbox: "exact_source_run",
  finalizingPredecessor: "finalizing_predecessor",
  peerFinalizingPredecessor: "peer_finalizing_predecessor",
  reusableSandbox: "matching_reusable_sandbox",
  homeCache: "matching_home_cache",
  sourceHomeCache: "matching_source_home_cache",
  sourceHostProbe: "source_host_probe",
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
): Record<string, string> & {
  readonly runner_preference_resolution: RunnerPreferenceTelemetryResolution;
} {
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
  readonly hasExactSource: boolean;
  readonly hasSourceHome: boolean;
  readonly isFinalizingPredecessor: boolean;
  readonly isPeerFinalizingPredecessor: boolean;
  readonly isSourceHostProbe: boolean;
  readonly finalizingSourceHasActiveProducer: boolean;
  readonly hasReusableSandbox: boolean;
  readonly sourceCompletedAt: Date | null;
  readonly finalizingSourceRunId: string | null;
}

function readyReuseHolderConditions(
  args: {
    readonly profile: string;
    readonly reuseKey: string;
    readonly shouldLookUpExactSource: boolean;
    readonly shouldLookUpGenericReuse: boolean;
  },
  sourceRunId: SQL,
) {
  const identity = {
    reuseKey: sql.param(args.reuseKey),
    profile: sql.param(args.profile),
  };
  return {
    reusableCondition: args.shouldLookUpGenericReuse
      ? reusableSandboxCondition(identity)
      : sql`false`,
    homeCondition: args.shouldLookUpGenericReuse
      ? capableHomeCondition(identity)
      : sql`false`,
    exactSourceCondition: args.shouldLookUpExactSource
      ? reusableSandboxCondition({ ...identity, sourceRunId })
      : sql`false`,
    sourceHomeCondition: args.shouldLookUpGenericReuse
      ? capableHomeCondition({ ...identity, sourceRunId })
      : sql`false`,
  };
}

function runnerReuseHolderPlan(args: {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly freshAfter: Date;
  readonly shouldLookUpExactSource: boolean;
  readonly shouldLookUpGenericReuse: boolean;
  readonly finalizingCompletedAfter: Date;
  readonly shouldLookUpFinalizingProducer: boolean;
}) {
  const sourceRunId = runnerThreadPredecessorRunId({
    runId: sql.param(args.runId),
    reuseKey: sql.param(args.reuseKey),
  });
  const {
    reusableCondition,
    homeCondition,
    exactSourceCondition,
    sourceHomeCondition,
  } = readyReuseHolderConditions(args, sourceRunId);
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
  const hostProbeCondition = args.shouldLookUpGenericReuse
    ? sourceHostProbeCondition({
        runnerGroup: args.runnerGroup,
        profile: sql.param(args.profile),
      })
    : sql`false`;
  const resourceRank = sql`CASE
    WHEN ${exactSourceCondition} THEN 5
    WHEN ${finalizingCondition} THEN 4
    WHEN ${peerFinalizingCondition} THEN 4
    WHEN ${sourceHomeCondition} THEN 3
    WHEN ${reusableCondition} THEN 2
    WHEN ${homeCondition} THEN 1
    ELSE 0
  END`;
  return {
    fields: {
      runnerId: runnerState.runnerId,
      heartbeatGeneration: runnerState.heartbeatGeneration,
      hasExactSource: sql`${exactSourceCondition}`.mapWith(pgBooleanDecoder),
      hasSourceHome: sql`${sourceHomeCondition}`.mapWith(pgBooleanDecoder),
      isFinalizingPredecessor: sql`${finalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      isPeerFinalizingPredecessor: sql`${peerFinalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      isSourceHostProbe: sql`CASE
        WHEN ${homeCondition} OR ${reusableCondition} THEN false
        ELSE coalesce(${hostProbeCondition}, false)
      END`.mapWith(pgBooleanDecoder),
      // A's producer inventory determines the budget even when B is empty or
      // advertises unrelated producers.
      finalizingSourceHasActiveProducer: sql`CASE
        WHEN ${peerFinalizingCondition} THEN ${peerProducerCondition}
        ELSE ${producerCondition}
      END`.mapWith(pgBooleanDecoder),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
      sourceCompletedAt: finalizingSourceRun.completedAt,
      // Ready sandbox/home provenance survives deletion of the settled Run.
      finalizingSourceRunId: sourceRunId.mapWith(
        nullableDriverValueDecoder(chatThreads.frameworkSessionRunId),
      ),
    },
    // Only unsettled finalization needs the producer's completion/process facts.
    joinCondition: eq(finalizingSourceRun.id, sourceRunId),
    where: and(
      eq(runnerState.runnerGroup, args.runnerGroup),
      eq(runnerState.mode, "running"),
      gt(runnerState.lastSeenAt, args.freshAfter),
      gt(runnerState.heartbeatGeneration, 0),
      or(
        exactSourceCondition,
        finalizingCondition,
        peerFinalizingCondition,
        sourceHomeCondition,
        reusableCondition,
        homeCondition,
        hostProbeCondition,
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
    shouldLookUpExactSource:
      startedAt === undefined ||
      startedAt + RUNNER_EXACT_SOURCE_PROTECTION_MS > currentTime,
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
      readonly shouldLookUpGenericReuse: boolean;
      readonly shouldLookUpExactSource: boolean;
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
          hasExactSource: row.hasExactSource,
          hasSourceHome: row.hasSourceHome,
          isFinalizingPredecessor: row.isFinalizingPredecessor,
          isPeerFinalizingPredecessor: row.isPeerFinalizingPredecessor,
          isSourceHostProbe: row.isSourceHostProbe,
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
    timing?: RunnerReusePreferenceTiming,
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
      !lookupStages.shouldLookUpExactSource
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
    };
    const selectHolder = () => {
      return set(findRunnerReuseHolder$, {
        ...lookupArgs,
        ...lookupStages,
      });
    };
    let holder = await (timing?.measure("holder_select", selectHolder) ??
      selectHolder());

    // Prepare the holder before starting a new window. Both delivery paths
    // await this write before returning a poll result or publishing to Ably.
    const startDiscovery = () => {
      return set(startRunnerJobDiscovery$, args);
    };
    const discoveryStartedAt =
      args.discoveryStartedAt ??
      (await (timing?.measure("discovery_persist", startDiscovery) ??
        startDiscovery()));
    if (discoveryStartedAt === null) {
      return {
        preference: { kind: "noPreference", reason: "noViableHolder" },
      };
    }
    const savedStages = runnerReuseLookupStages(
      {
        discoveryStartedAt,
      },
      nowDate(),
    );
    if (
      !savedStages.shouldLookUpGenericReuse &&
      !savedStages.shouldLookUpFinalizingProducer &&
      !savedStages.shouldLookUpExactSource
    ) {
      return {
        preference: { kind: "noPreference", reason: "expired" },
      };
    }
    if (
      lookupStages.shouldLookUpExactSource !==
        savedStages.shouldLookUpExactSource ||
      lookupStages.shouldLookUpFinalizingProducer !==
        savedStages.shouldLookUpFinalizingProducer ||
      lookupStages.shouldLookUpGenericReuse !==
        savedStages.shouldLookUpGenericReuse
    ) {
      // A competing discovery or the lookup itself may have consumed a stage.
      // Select using the saved deadline without renewing it or retrying writes.
      const reselectHolder = () => {
        return set(findRunnerReuseHolder$, {
          ...lookupArgs,
          ...savedStages,
        });
      };
      holder = await (timing?.measure("holder_reselect", reselectHolder) ??
        reselectHolder());
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
      exactSourceExpiresAt: new Date(
        discoveryStartedAt.getTime() + RUNNER_EXACT_SOURCE_PROTECTION_MS,
      ),
      shouldLookUpGenericReuse: savedStages.shouldLookUpGenericReuse,
    });
  },
);

function runnerReusePreferenceResult(args: {
  readonly holder: RunnerReuseHolder | null;
  readonly matchingReuseExpiresAt: Date;
  readonly finalizingProducerExpiresAt: Date;
  readonly exactSourceExpiresAt: Date;
  readonly shouldLookUpGenericReuse: boolean;
}): RunnerReusePreferenceResolution {
  const {
    holder,
    matchingReuseExpiresAt,
    finalizingProducerExpiresAt,
    exactSourceExpiresAt,
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

  if (holder.hasExactSource) {
    if (!holder.finalizingSourceRunId) {
      throw new Error("Exact source preference is missing its producer");
    }
    return {
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: "exactSandbox",
        finalizingSourceRunId: holder.finalizingSourceRunId,
        expiresAt: exactSourceExpiresAt.toISOString(),
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

  if (holder.hasSourceHome) {
    if (!holder.finalizingSourceRunId) {
      throw new Error("Source home preference is missing its producer");
    }
    return {
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: "sourceHomeCache",
        finalizingSourceRunId: holder.finalizingSourceRunId,
        expiresAt: matchingReuseExpiresAt.toISOString(),
      },
    };
  }

  if (holder.isSourceHostProbe) {
    if (!holder.finalizingSourceRunId) {
      throw new Error("Source host probe is missing its source identity");
    }
    return {
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: "sourceHostProbe",
        finalizingSourceRunId: holder.finalizingSourceRunId,
        expiresAt: matchingReuseExpiresAt.toISOString(),
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
