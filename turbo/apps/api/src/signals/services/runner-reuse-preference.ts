import { enum as zEnum } from "zod";
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
  zodEnumDriverValueDecoder,
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

const predecessorRun = alias(agentRuns, "reuse_predecessor_run");
const sourceHomePublisherState = alias(runnerState, "source_home_publisher");
const currentRun = alias(agentRuns, "reuse_current_run");
const sourceHomeEvidenceKindSchema = zEnum([
  "advertised",
  "expected",
  "location",
]);

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
    | typeof sourceHomePublisherState.activeReuseProducers;
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
    | typeof sourceHomePublisherState.activeReuseProducers;
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
    inArray(predecessorRun.status, ["completed", "cancelled", "failed"]),
    or(
      gt(predecessorRun.completedAt, args.completedAfter),
      args.activeProducer,
    ),
    eq(predecessorRun.runnerGroup, args.runnerGroup),
    isNotNull(sql`${predecessorRun.launchSnapshot}->>'runnerProfile'`),
    eq(sql`${predecessorRun.launchSnapshot}->>'runnerProfile'`, args.profile),
    isNotNull(predecessorRun.runnerId),
    isNotNull(predecessorRun.runnerHeartbeatGeneration),
    eq(args.runnerId, predecessorRun.runnerId),
    eq(args.heartbeatGeneration, predecessorRun.runnerHeartbeatGeneration),
  );
}

/** Source placement survives the publishing process and is only advisory. */
function sourceHomePlacementCondition(args: {
  readonly runnerGroup: string;
  readonly profile: SQLWrapper;
}): SQL {
  return (
    and(
      inArray(predecessorRun.status, ["completed", "cancelled", "failed"]),
      eq(predecessorRun.runnerGroup, args.runnerGroup),
      eq(sql`${predecessorRun.launchSnapshot}->>'runnerProfile'`, args.profile),
      isNotNull(predecessorRun.runnerHostname),
      ne(predecessorRun.runnerHostname, ""),
      eq(runnerState.runnerHostname, predecessorRun.runnerHostname),
      arrayContains(
        runnerState.admittableProfiles,
        sql`jsonb_build_array(cast(${args.profile} as text))`,
      ),
    ) ?? sql`false`
  );
}

function sourceHomeConditions(args: {
  readonly runnerGroup: string;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
}) {
  const location = sourceHomePlacementCondition(args);
  const producer =
    and(
      eq(sourceHomePublisherState.runnerId, predecessorRun.runnerId),
      eq(
        sourceHomePublisherState.heartbeatGeneration,
        predecessorRun.runnerHeartbeatGeneration,
      ),
      eq(sourceHomePublisherState.runnerGroup, args.runnerGroup),
      gt(sourceHomePublisherState.lastSeenAt, args.freshAfter),
      gt(sourceHomePublisherState.heartbeatGeneration, 0),
      eq(
        sourceHomePublisherState.runnerHostname,
        predecessorRun.runnerHostname,
      ),
      activeProducerCondition({
        inventory: sourceHomePublisherState.activeReuseProducers,
        reuseKey: args.reuseKey,
        profile: args.profile,
        sourceRunId: predecessorRun.id,
      }),
    ) ?? sql`false`;
  return {
    location,
    producer,
    expected:
      and(
        location,
        or(gt(predecessorRun.completedAt, args.completedAfter), producer),
      ) ?? sql`false`,
  };
}

function runnerStateHasSourceHome(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly evidence: "expected" | "location";
}): SQL {
  const home = sourceHomeConditions(args);
  return exists(
    new QueryBuilder()
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(predecessorRun, eq(predecessorRun.id, args.sourceRunId))
      .leftJoin(
        sourceHomePublisherState,
        eq(sourceHomePublisherState.runnerId, predecessorRun.runnerId),
      )
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          gt(runnerState.heartbeatGeneration, 0),
          home[args.evidence],
        ),
      ),
  );
}

function sourceHomePollHolders(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
}) {
  const { runnerId, ...conditions } = args;
  const holders = (evidence: "expected" | "location") => {
    return {
      global: runnerStateHasSourceHome({ ...conditions, evidence }),
      local: runnerStateHasSourceHome({ ...conditions, evidence, runnerId }),
    };
  };
  return { expected: holders("expected"), location: holders("location") };
}

function runnerStateHasFinalizingPredecessor(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly activeProducer: SQL;
}): SQL {
  return exists(
    new QueryBuilder()
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(predecessorRun, eq(predecessorRun.id, args.sourceRunId))
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          gt(runnerState.heartbeatGeneration, 0),
          finalizingPredecessorCondition({
            ...args,
            runnerId: runnerState.runnerId,
            heartbeatGeneration: runnerState.heartbeatGeneration,
          }),
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
    sourceRunId: predecessorRun.id,
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
  };
  return {
    global: runnerStateHasFinalizingPredecessor(conditions),
    local: runnerStateHasFinalizingPredecessor({
      ...conditions,
      runnerId: args.runnerId,
    }),
  };
}

function readyPollHolders(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly sourceRunId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
}) {
  const identity = { reuseKey: args.reuseKey, profile: args.profile };
  const holders = (resourceCondition: SQL) => {
    return {
      global: runnerStateHas({
        runnerGroup: args.runnerGroup,
        freshAfter: args.freshAfter,
        resourceCondition,
      }),
      local: runnerStateHas({
        runnerId: args.runnerId,
        runnerGroup: args.runnerGroup,
        freshAfter: args.freshAfter,
        resourceCondition,
      }),
    };
  };
  return {
    exact: holders(
      reusableSandboxCondition({ ...identity, sourceRunId: args.sourceRunId }),
    ),
    sourceHome: holders(
      capableHomeCondition({ ...identity, sourceRunId: args.sourceRunId }),
    ),
    reusable: holders(reusableSandboxCondition(identity)),
    home: holders(capableHomeCondition(identity)),
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
  const ready = readyPollHolders({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    sourceRunId,
    reuseKey,
    profile,
    freshAfter,
  });
  const sourceHome = sourceHomePollHolders({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    reuseKey,
    profile,
    sourceRunId,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
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
      ready.exact.global,
    )}
    THEN CASE WHEN ${ready.exact.local} THEN 7 ELSE 0 END
    WHEN ${and(
      isNotNull(runnerJobQueue.reuseKey),
      discoveryWindowCondition(producerProtectedAfter),
      finalizing.global,
    )}
    THEN CASE
      WHEN ${ready.exact.local} THEN 7
      WHEN ${finalizing.local} THEN 6
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      ready.sourceHome.global,
    )}
    THEN CASE
      WHEN ${ready.exact.local} THEN 7
      WHEN ${ready.sourceHome.local} THEN 5
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      sourceHome.expected.global,
    )}
    THEN CASE
      WHEN ${ready.exact.local} THEN 7
      WHEN ${ready.sourceHome.local} THEN 5
      WHEN ${sourceHome.expected.local} THEN 4
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      ready.reusable.global,
    )}
    THEN CASE WHEN ${ready.reusable.local} THEN 3 ELSE 0 END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      ready.home.global,
    )}
    THEN CASE
      WHEN ${ready.reusable.local} THEN 3
      WHEN ${ready.home.local} THEN 2
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      sourceHome.location.global,
    )}
    THEN CASE WHEN ${sourceHome.location.local} THEN 1 ELSE 0 END
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
  reusableSandbox: "matching_reusable_sandbox",
  homeCache: "matching_home_cache",
  sourceHome: "source_home",
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
          ...(preference.tier === "sourceHome"
            ? {
                runner_preference_home_evidence: preference.home.evidence,
                ...(preference.home.evidence === "expected"
                  ? {
                      runner_preference_home_wait_until:
                        preference.home.homeWaitUntil,
                    }
                  : {}),
              }
            : {}),
        }
      : { runner_preference_no_preference_reason: preference.reason }),
  };
}

interface RunnerReuseHolder {
  readonly runnerIdentity: PositiveRunnerPreference["runnerIdentity"];
  readonly hasExactSource: boolean;
  readonly isFinalizingPredecessor: boolean;
  readonly sourceHomeEvidence: "advertised" | "expected" | "location" | null;
  readonly sourceHomeHasActiveProducer: boolean;
  readonly localSourceHasActiveProducer: boolean;
  readonly hasReusableSandbox: boolean;
  readonly sourceCompletedAt: Date | null;
  readonly sourceRunId: string | null;
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
        sourceRunId: predecessorRun.id,
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
  const sourceHome = sourceHomeConditions({
    runnerGroup: args.runnerGroup,
    reuseKey: sql.param(args.reuseKey),
    profile: sql.param(args.profile),
    freshAfter: args.freshAfter,
    completedAfter: args.finalizingCompletedAfter,
  });
  const expectedHome = args.shouldLookUpGenericReuse
    ? sourceHome.expected
    : sql`false`;
  const locationHome = args.shouldLookUpGenericReuse
    ? sourceHome.location
    : sql`false`;
  const homeEvidence = sql`CASE
    WHEN ${sourceHomeCondition} THEN 'advertised'
    WHEN ${expectedHome} THEN 'expected'
    WHEN ${locationHome} AND NOT (${homeCondition} OR ${reusableCondition}) THEN 'location'
    ELSE NULL
  END`;
  const resourceRank = sql`CASE
    WHEN ${exactSourceCondition} THEN 6
    WHEN ${finalizingCondition} THEN 5
    WHEN ${sourceHomeCondition} THEN 4
    WHEN ${expectedHome} THEN 3
    WHEN ${reusableCondition} THEN 2
    WHEN ${homeCondition} THEN 1
    ELSE 0
  END`;
  return {
    fields: {
      runnerId: runnerState.runnerId,
      heartbeatGeneration: runnerState.heartbeatGeneration,
      hasExactSource: sql`${exactSourceCondition}`.mapWith(pgBooleanDecoder),
      isFinalizingPredecessor: sql`${finalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      sourceHomeEvidence: sql`${homeEvidence}`.mapWith(
        nullableDriverValueDecoder(
          zodEnumDriverValueDecoder(sourceHomeEvidenceKindSchema),
        ),
      ),
      sourceHomeHasActiveProducer:
        sql`coalesce(${sourceHome.producer}, false)`.mapWith(pgBooleanDecoder),
      localSourceHasActiveProducer: sql`${producerCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
      sourceCompletedAt: predecessorRun.completedAt,
      // Ready sandbox/home provenance survives deletion of the settled Run.
      sourceRunId: sourceRunId.mapWith(
        nullableDriverValueDecoder(chatThreads.frameworkSessionRunId),
      ),
    },
    // Only unsettled finalization needs the producer's completion/process facts.
    joinCondition: eq(predecessorRun.id, sourceRunId),
    where: and(
      eq(runnerState.runnerGroup, args.runnerGroup),
      eq(runnerState.mode, "running"),
      gt(runnerState.lastSeenAt, args.freshAfter),
      gt(runnerState.heartbeatGeneration, 0),
      or(
        exactSourceCondition,
        finalizingCondition,
        expectedHome,
        sourceHomeCondition,
        reusableCondition,
        homeCondition,
        locationHome,
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
      .leftJoin(predecessorRun, plan.joinCondition)
      .leftJoin(
        sourceHomePublisherState,
        eq(sourceHomePublisherState.runnerId, predecessorRun.runnerId),
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
          isFinalizingPredecessor: row.isFinalizingPredecessor,
          sourceHomeEvidence: row.sourceHomeEvidence,
          sourceHomeHasActiveProducer: row.sourceHomeHasActiveProducer,
          localSourceHasActiveProducer: row.localSourceHasActiveProducer,
          hasReusableSandbox: row.hasReusableSandbox,
          sourceCompletedAt: row.sourceCompletedAt,
          sourceRunId: row.sourceRunId,
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
    if (!holder.sourceRunId) {
      throw new Error("Exact source preference is missing its producer");
    }
    return {
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: "exactSandbox",
        finalizingSourceRunId: holder.sourceRunId,
        expiresAt: exactSourceExpiresAt.toISOString(),
      },
    };
  }

  if (holder.isFinalizingPredecessor) {
    if (!holder.sourceCompletedAt || !holder.sourceRunId) {
      throw new Error(
        "Finalizing predecessor is missing its source identity or completion time",
      );
    }
    return {
      finalizingSource: holder.localSourceHasActiveProducer
        ? "active_producer"
        : "completion_bridge",
      preference: {
        kind: "preference",
        runnerIdentity: holder.runnerIdentity,
        tier: "finalizingPredecessor",
        finalizingSourceRunId: holder.sourceRunId,
        expiresAt: (holder.localSourceHasActiveProducer
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

  if (holder.sourceHomeEvidence !== null) {
    return sourceHomePreferenceResult(
      holder,
      matchingReuseExpiresAt,
      finalizingProducerExpiresAt,
    );
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

function sourceHomePreferenceResult(
  holder: RunnerReuseHolder,
  routingExpiresAt: Date,
  producerExpiresAt: Date,
): RunnerReusePreferenceResolution {
  if (!holder.sourceRunId || holder.sourceHomeEvidence === null) {
    throw new Error("Source Home preference is missing its source or evidence");
  }
  const evidence = holder.sourceHomeEvidence;
  const home: Extract<
    PositiveRunnerPreference,
    { tier: "sourceHome" }
  >["home"] =
    evidence === "expected"
      ? {
          evidence,
          homeWaitUntil: sourceHomeWaitUntil(
            holder,
            producerExpiresAt,
          ).toISOString(),
        }
      : { evidence };
  return {
    ...(evidence === "expected"
      ? {
          finalizingSource: holder.sourceHomeHasActiveProducer
            ? "active_producer"
            : "completion_bridge",
        }
      : {}),
    preference: {
      kind: "preference",
      runnerIdentity: holder.runnerIdentity,
      tier: "sourceHome",
      sourceRunId: holder.sourceRunId,
      expiresAt: routingExpiresAt.toISOString(),
      home,
    },
  };
}

function sourceHomeWaitUntil(
  holder: RunnerReuseHolder,
  producerExpiresAt: Date,
): Date {
  if (holder.sourceHomeHasActiveProducer) {
    return producerExpiresAt;
  }
  if (!holder.sourceCompletedAt) {
    throw new Error("Expected Home is missing its completion bridge");
  }
  return new Date(
    Math.min(
      holder.sourceCompletedAt.getTime() +
        RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
      producerExpiresAt.getTime(),
    ),
  );
}

export function runnerReuseKeyTelemetryKind(
  reuseKey: string | null,
): "thread" | "session" | "none" {
  if (reuseKey === null) {
    return "none";
  }
  return reuseKey.startsWith("thread:") ? "thread" : "session";
}
