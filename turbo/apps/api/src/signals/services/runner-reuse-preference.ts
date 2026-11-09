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
import {
  alias,
  QueryBuilder,
  type SubqueryWithSelection,
} from "drizzle-orm/pg-core";
import { command } from "ccstate";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import {
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { db$, writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { RunnerReusePreferenceTiming } from "./runner-reuse-timing.service";

const RUNNER_REUSE_ROUTING_WINDOW_MS = 2000;
const RUNNER_EXACT_SANDBOX_ROUTING_WINDOW_MS = Math.min(
  1000,
  RUNNER_REUSE_ROUTING_WINDOW_MS,
);
// A short bridge covers a terminal predecessor before active-producer inventory
// arrives. Only current producer proof earns the longer telemetry-close budget.
const RUNNER_FINALIZING_COMPLETION_BRIDGE_MS = 1500;
// Allow three 60-second routine reports; state changes still report immediately.
const RUNNER_REUSE_STATE_FRESH_MS = 180_000;

const predecessorRun = alias(agentRuns, "reuse_predecessor_run");
const predecessorRunnerState = alias(runnerState, "predecessor_runner");
const currentRun = alias(agentRuns, "reuse_current_run");
const predecessorHomeEvidenceKindSchema = zEnum([
  "advertised",
  "expected",
  "location",
]);

type RunnerThreadPredecessor = SubqueryWithSelection<
  { id: typeof chatThreads.frameworkSessionRunId },
  "reuse_pred"
>;

/**
 * Pending discovery reads the owned Thread's durable predecessor, independently
 * of its native readiness or a retained producer row. The first claim advances
 * the Thread to this Run; discovery must stop treating it as the predecessor.
 * Native intent is already frozen in the job's execution context before claim.
 *
 * Callers left-join the result laterally `ON true` and every reuse condition
 * reads its `id` column. Primary-key joins yield at most one row, so a missing
 * predecessor is NULL, as with a scalar subquery, while PostgreSQL plans the
 * lookup once instead of once per referencing condition.
 */
function runnerThreadPredecessor(args: {
  readonly runId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
}): RunnerThreadPredecessor {
  return new QueryBuilder()
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
    )
    .as("reuse_pred");
}

interface PendingRunnerThread {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly predecessorRunId: string | null;
}

/** Final publication independently fences this captured owned Thread binding. */
function pendingRunnerThreadPredecessor(args: PendingRunnerThread) {
  return new QueryBuilder()
    .select({ id: chatThreads.frameworkSessionRunId })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
        sql`${chatThreads.frameworkSessionRunId} IS NOT DISTINCT FROM ${args.predecessorRunId}::uuid`,
      ),
    )
    .as("reuse_pred");
}

function runnerReuseStateFreshAfter(currentDate: Date): Date {
  return new Date(currentDate.getTime() - RUNNER_REUSE_STATE_FRESH_MS);
}

function advertisedSandboxCondition(args: {
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
    | typeof predecessorRunnerState.activeReuseProducers;
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
    | typeof predecessorRunnerState.activeReuseProducers;
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

function advertisedHomeCondition(args: {
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

/** Predecessor placement survives the publishing process and is only advisory. */
function predecessorHostCondition(args: {
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

function predecessorHomeEvidenceConditions(args: {
  readonly runnerGroup: string;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
}) {
  const hostLocation = predecessorHostCondition(args);
  const activeProducer =
    and(
      eq(predecessorRunnerState.runnerId, predecessorRun.runnerId),
      eq(
        predecessorRunnerState.heartbeatGeneration,
        predecessorRun.runnerHeartbeatGeneration,
      ),
      eq(predecessorRunnerState.runnerGroup, args.runnerGroup),
      gt(predecessorRunnerState.lastSeenAt, args.freshAfter),
      gt(predecessorRunnerState.heartbeatGeneration, 0),
      eq(predecessorRunnerState.runnerHostname, predecessorRun.runnerHostname),
      activeProducerCondition({
        inventory: predecessorRunnerState.activeReuseProducers,
        reuseKey: args.reuseKey,
        profile: args.profile,
        sourceRunId: predecessorRun.id,
      }),
    ) ?? sql`false`;
  return {
    hostLocation,
    activeProducer,
    expectedPublication:
      and(
        hostLocation,
        or(gt(predecessorRun.completedAt, args.completedAfter), activeProducer),
      ) ?? sql`false`,
  };
}

function predecessorHomeRunnerExists(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly predecessorRunId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly evidence: "expectedPublication" | "hostLocation";
}): SQL {
  const home = predecessorHomeEvidenceConditions(args);
  return exists(
    new QueryBuilder()
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(predecessorRun, eq(predecessorRun.id, args.predecessorRunId))
      .leftJoin(
        predecessorRunnerState,
        eq(predecessorRunnerState.runnerId, predecessorRun.runnerId),
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

function predecessorHomePollCandidates(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly predecessorRunId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
}) {
  const { runnerId, ...conditions } = args;
  const candidates = (evidence: "expectedPublication" | "hostLocation") => {
    return {
      global: predecessorHomeRunnerExists({ ...conditions, evidence }),
      local: predecessorHomeRunnerExists({ ...conditions, evidence, runnerId }),
    };
  };
  return {
    expectedPublication: candidates("expectedPublication"),
    hostLocation: candidates("hostLocation"),
  };
}

function runnerStateHasFinalizingPredecessor(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly predecessorRunId: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
  readonly completedAfter: Date;
  readonly activeProducer: SQL;
}): SQL {
  return exists(
    new QueryBuilder()
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .innerJoin(predecessorRun, eq(predecessorRun.id, args.predecessorRunId))
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

function finalizingPollCandidates(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly predecessorRunId: SQLWrapper;
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
    predecessorRunId: args.predecessorRunId,
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

function advertisedReusePollCandidates(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly predecessorRunId: SQLWrapper;
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly freshAfter: Date;
}) {
  const identity = { reuseKey: args.reuseKey, profile: args.profile };
  const candidates = (resourceCondition: SQL) => {
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
    exactSandbox: candidates(
      advertisedSandboxCondition({
        ...identity,
        sourceRunId: args.predecessorRunId,
      }),
    ),
    predecessorHome: candidates(
      advertisedHomeCondition({
        ...identity,
        sourceRunId: args.predecessorRunId,
      }),
    ),
    reusable: candidates(advertisedSandboxCondition(identity)),
    home: candidates(advertisedHomeCondition(identity)),
  };
}

/**
 * Poll ordering runs before a job is selected, so any runner with qualifying
 * local reuse may prioritize the job independently of the globally selected
 * preference identity. `priority` reads each job's Thread predecessor from
 * `predecessor`, which the caller left-joins laterally after the job queue.
 */
export function runnerReusePreferencePollPriority(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly currentDate: Date;
}): {
  readonly predecessor: RunnerThreadPredecessor;
  readonly priority: SQL;
} {
  const reuseRoutingAfter = new Date(
    args.currentDate.getTime() - RUNNER_REUSE_ROUTING_WINDOW_MS,
  );
  const exactSandboxRoutingAfter = new Date(
    args.currentDate.getTime() - RUNNER_EXACT_SANDBOX_ROUTING_WINDOW_MS,
  );
  const finalizingCompletedAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
  );
  const finalizingWaitAfter = new Date(
    args.currentDate.getTime() - RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const freshAfter = runnerReuseStateFreshAfter(args.currentDate);
  const { reuseKey, profile } = runnerJobQueue;
  const predecessor = runnerThreadPredecessor({
    runId: runnerJobQueue.runId,
    reuseKey,
  });
  const predecessorRunId = predecessor.id;
  const advertised = advertisedReusePollCandidates({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    predecessorRunId,
    reuseKey,
    profile,
    freshAfter,
  });
  const predecessorHome = predecessorHomePollCandidates({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    reuseKey,
    profile,
    predecessorRunId,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
  });
  const finalizing = finalizingPollCandidates({
    runnerId: args.runnerId,
    runnerGroup: args.runnerGroup,
    reuseKey,
    profile,
    predecessorRunId,
    freshAfter,
    completedAfter: finalizingCompletedAfter,
    protectedAfter: finalizingWaitAfter,
  });
  const priority = sql`CASE
    WHEN ${and(
      discoveryWindowCondition(exactSandboxRoutingAfter),
      isNotNull(runnerJobQueue.reuseKey),
      isNotNull(predecessorRunId),
      advertised.exactSandbox.global,
    )}
    THEN CASE WHEN ${advertised.exactSandbox.local} THEN 7 ELSE 0 END
    WHEN ${and(
      isNotNull(runnerJobQueue.reuseKey),
      discoveryWindowCondition(finalizingWaitAfter),
      finalizing.global,
    )}
    THEN CASE
      WHEN ${advertised.exactSandbox.local} THEN 7
      WHEN ${finalizing.local} THEN 6
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(reuseRoutingAfter),
      isNotNull(runnerJobQueue.reuseKey),
      advertised.predecessorHome.global,
    )}
    THEN CASE
      WHEN ${advertised.exactSandbox.local} THEN 7
      WHEN ${advertised.predecessorHome.local} THEN 5
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(reuseRoutingAfter),
      isNotNull(runnerJobQueue.reuseKey),
      predecessorHome.expectedPublication.global,
    )}
    THEN CASE
      WHEN ${advertised.exactSandbox.local} THEN 7
      WHEN ${advertised.predecessorHome.local} THEN 5
      WHEN ${predecessorHome.expectedPublication.local} THEN 4
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(reuseRoutingAfter),
      isNotNull(runnerJobQueue.reuseKey),
      advertised.reusable.global,
    )}
    THEN CASE WHEN ${advertised.reusable.local} THEN 3 ELSE 0 END
    WHEN ${and(
      discoveryWindowCondition(reuseRoutingAfter),
      isNotNull(runnerJobQueue.reuseKey),
      advertised.home.global,
    )}
    THEN CASE
      WHEN ${advertised.reusable.local} THEN 3
      WHEN ${advertised.home.local} THEN 2
      ELSE 0
    END
    WHEN ${and(
      discoveryWindowCondition(reuseRoutingAfter),
      isNotNull(runnerJobQueue.reuseKey),
      predecessorHome.hostLocation.global,
    )}
    THEN CASE WHEN ${predecessorHome.hostLocation.local} THEN 1 ELSE 0 END
    ELSE 0
  END`;
  return { predecessor, priority };
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
  predecessorHome: "source_home",
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
          ...(preference.tier === "predecessorHome"
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

interface RunnerReuseCandidate {
  readonly runnerIdentity: PositiveRunnerPreference["runnerIdentity"];
  readonly heartbeatSequence: number;
  readonly hasAdvertisedPredecessorSandbox: boolean;
  readonly hasLocalFinalizingPredecessor: boolean;
  readonly predecessorHomeEvidence:
    "advertised" | "expected" | "location" | null;
  readonly predecessorRunnerHasActiveProducer: boolean;
  readonly candidateRunnerHasActiveProducer: boolean;
  readonly hasReusableSandbox: boolean;
  readonly predecessorCompletedAt: Date | null;
  readonly predecessorRunId: string | null;
  readonly predecessorStatus: (typeof agentRuns.$inferSelect)["status"] | null;
  readonly predecessorRunnerId: string | null;
  readonly predecessorHeartbeatGeneration: number | null;
  readonly predecessorHeartbeatSequence: number | null;
}

function advertisedReuseConditions(
  args: {
    readonly profile: string;
    readonly reuseKey: string;
    readonly shouldLookUpExactSandbox: boolean;
    readonly shouldLookUpGenericReuse: boolean;
  },
  predecessorRunId: SQLWrapper,
) {
  const identity = {
    reuseKey: sql.param(args.reuseKey),
    profile: sql.param(args.profile),
  };
  return {
    reusableCondition: args.shouldLookUpGenericReuse
      ? advertisedSandboxCondition(identity)
      : sql`false`,
    homeCondition: args.shouldLookUpGenericReuse
      ? advertisedHomeCondition(identity)
      : sql`false`,
    exactSandboxCondition: args.shouldLookUpExactSandbox
      ? advertisedSandboxCondition({
          ...identity,
          sourceRunId: predecessorRunId,
        })
      : sql`false`,
    advertisedPredecessorHomeCondition: args.shouldLookUpGenericReuse
      ? advertisedHomeCondition({ ...identity, sourceRunId: predecessorRunId })
      : sql`false`,
  };
}

function runnerReuseCandidatePlan(args: {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly freshAfter: Date;
  readonly shouldLookUpExactSandbox: boolean;
  readonly shouldLookUpGenericReuse: boolean;
  readonly finalizingCompletedAfter: Date;
  readonly shouldLookUpFinalizingProducer: boolean;
  readonly pendingThread?: PendingRunnerThread;
}) {
  const predecessor = args.pendingThread
    ? pendingRunnerThreadPredecessor(args.pendingThread)
    : runnerThreadPredecessor({
        runId: sql.param(args.runId),
        reuseKey: sql.param(args.reuseKey),
      });
  const predecessorRunId = predecessor.id;
  const {
    reusableCondition,
    homeCondition,
    exactSandboxCondition,
    advertisedPredecessorHomeCondition,
  } = advertisedReuseConditions(args, predecessorRunId);
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
  const predecessorHome = predecessorHomeEvidenceConditions({
    runnerGroup: args.runnerGroup,
    reuseKey: sql.param(args.reuseKey),
    profile: sql.param(args.profile),
    freshAfter: args.freshAfter,
    completedAfter: args.finalizingCompletedAfter,
  });
  const expectedHome = args.shouldLookUpGenericReuse
    ? predecessorHome.expectedPublication
    : sql`false`;
  const locationHome = args.shouldLookUpGenericReuse
    ? predecessorHome.hostLocation
    : sql`false`;
  const homeEvidence = sql`CASE
    WHEN ${advertisedPredecessorHomeCondition} THEN 'advertised'
    WHEN ${expectedHome} THEN 'expected'
    WHEN ${locationHome} AND NOT (${homeCondition} OR ${reusableCondition}) THEN 'location'
    ELSE NULL
  END`;
  const preferenceRank = sql`CASE
    WHEN ${exactSandboxCondition} THEN 6
    WHEN ${finalizingCondition} THEN 5
    WHEN ${advertisedPredecessorHomeCondition} THEN 4
    WHEN ${expectedHome} THEN 3
    WHEN ${reusableCondition} THEN 2
    WHEN ${homeCondition} THEN 1
    ELSE 0
  END`;
  return {
    fields: {
      runnerId: runnerState.runnerId,
      heartbeatGeneration: runnerState.heartbeatGeneration,
      heartbeatSequence: runnerState.heartbeatSequence,
      hasAdvertisedPredecessorSandbox: sql`${exactSandboxCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasLocalFinalizingPredecessor: sql`${finalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      predecessorHomeEvidence: sql`${homeEvidence}`.mapWith(
        nullableDriverValueDecoder(
          zodEnumDriverValueDecoder(predecessorHomeEvidenceKindSchema),
        ),
      ),
      predecessorRunnerHasActiveProducer:
        sql`coalesce(${predecessorHome.activeProducer}, false)`.mapWith(
          pgBooleanDecoder,
        ),
      candidateRunnerHasActiveProducer: sql`${producerCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
      predecessorCompletedAt: predecessorRun.completedAt,
      predecessorStatus: predecessorRun.status,
      predecessorRunnerId: predecessorRunnerState.runnerId,
      predecessorHeartbeatGeneration:
        predecessorRunnerState.heartbeatGeneration,
      predecessorHeartbeatSequence: predecessorRunnerState.heartbeatSequence,
      // Ready sandbox/home provenance survives deletion of the settled Run.
      predecessorRunId,
    },
    predecessor,
    // Only unsettled finalization needs the producer's completion/process facts.
    joinCondition: eq(predecessorRun.id, predecessorRunId),
    where: and(
      eq(runnerState.runnerGroup, args.runnerGroup),
      eq(runnerState.mode, "running"),
      gt(runnerState.lastSeenAt, args.freshAfter),
      gt(runnerState.heartbeatGeneration, 0),
      or(
        exactSandboxCondition,
        finalizingCondition,
        expectedHome,
        advertisedPredecessorHomeCondition,
        reusableCondition,
        homeCondition,
        locationHome,
      ),
    ),
    orderBy: [desc(preferenceRank), asc(runnerState.runnerId)] as const,
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
  readonly waitBudgetSource?: "active_producer" | "completion_bridge";
}

export interface RunnerReusePreparation {
  readonly selection:
    | {
        readonly ok: true;
        readonly value: {
          readonly thread: PendingRunnerThread;
          readonly candidate: RunnerReuseCandidate | null;
        };
      }
    | { readonly ok: false; readonly error: unknown };
  readonly operations: ReturnType<RunnerReusePreferenceTiming["operations"]>;
}

function preparedReuseUnchanged(
  args: RunnerReusePreferenceArgs,
  prepared: Extract<RunnerReusePreparation["selection"], { ok: true }>["value"],
): SQL {
  const predecessor = runnerThreadPredecessor({
    runId: sql.param(args.runId),
    reuseKey: sql.param(args.reuseKey),
  });
  const predecessorUnchanged = sql`(SELECT ${predecessor.id} FROM ${predecessor}) IS NOT DISTINCT FROM ${prepared.thread.predecessorRunId}::uuid`;
  const conditions: SQL[] = [predecessorUnchanged];
  const candidate = prepared.candidate;
  if (!candidate) {
    return predecessorUnchanged;
  }
  conditions.push(
    exists(
      new QueryBuilder()
        .select({ id: runnerState.runnerId })
        .from(runnerState)
        .where(
          and(
            eq(runnerState.runnerId, candidate.runnerIdentity.runnerId),
            eq(runnerState.runnerGroup, args.runnerGroup),
            eq(runnerState.mode, "running"),
            gt(runnerState.lastSeenAt, runnerReuseStateFreshAfter(nowDate())),
            eq(
              runnerState.heartbeatGeneration,
              candidate.runnerIdentity.heartbeatGeneration,
            ),
            eq(runnerState.heartbeatSequence, candidate.heartbeatSequence),
          ),
        ),
    ),
  );
  if (
    !candidate.hasAdvertisedPredecessorSandbox &&
    (candidate.hasLocalFinalizingPredecessor ||
      candidate.predecessorHomeEvidence !== null) &&
    candidate.predecessorStatus !== null &&
    candidate.predecessorRunId
  ) {
    conditions.push(
      exists(
        new QueryBuilder()
          .select({ id: predecessorRun.id })
          .from(predecessorRun)
          .where(
            and(
              eq(predecessorRun.id, candidate.predecessorRunId),
              eq(predecessorRun.status, candidate.predecessorStatus),
              sql`${predecessorRun.completedAt} IS NOT DISTINCT FROM ${sql.param(candidate.predecessorCompletedAt, predecessorRun.completedAt)}`,
            ),
          ),
      ),
    );
  }
  if (
    !candidate.hasAdvertisedPredecessorSandbox &&
    !candidate.hasLocalFinalizingPredecessor &&
    candidate.predecessorHomeEvidence === "expected" &&
    candidate.predecessorRunnerHasActiveProducer &&
    candidate.predecessorRunnerId !== null &&
    candidate.predecessorHeartbeatGeneration !== null &&
    candidate.predecessorHeartbeatSequence !== null
  ) {
    conditions.push(
      exists(
        new QueryBuilder()
          .select({ id: predecessorRunnerState.runnerId })
          .from(predecessorRunnerState)
          .where(
            and(
              eq(
                predecessorRunnerState.runnerId,
                candidate.predecessorRunnerId,
              ),
              eq(
                predecessorRunnerState.heartbeatGeneration,
                candidate.predecessorHeartbeatGeneration,
              ),
              eq(
                predecessorRunnerState.heartbeatSequence,
                candidate.predecessorHeartbeatSequence,
              ),
              gt(
                predecessorRunnerState.lastSeenAt,
                runnerReuseStateFreshAfter(nowDate()),
              ),
            ),
          ),
      ),
    );
  }
  return sql`(${and(...conditions)})`;
}

function preparedCompletionBridgeExpired(
  candidate: RunnerReuseCandidate | null,
): boolean {
  if (
    !candidate ||
    candidate.hasAdvertisedPredecessorSandbox ||
    candidate.predecessorCompletedAt === null
  ) {
    return false;
  }
  const requiresBridge = candidate.hasLocalFinalizingPredecessor
    ? !candidate.candidateRunnerHasActiveProducer
    : candidate.predecessorHomeEvidence === "expected" &&
      !candidate.predecessorRunnerHasActiveProducer;
  return (
    requiresBridge &&
    candidate.predecessorCompletedAt.getTime() +
      RUNNER_FINALIZING_COMPLETION_BRIDGE_MS <=
      nowDate().getTime()
  );
}

const startRunnerJobDiscovery$ = command(
  async (
    { set },
    args: RunnerReusePreferenceArgs,
    prepared?: Extract<
      RunnerReusePreparation["selection"],
      { ok: true }
    >["value"],
  ) => {
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
      .returning({
        discoveryStartedAt: runnerJobQueue.discoveryStartedAt,
        preparedUnchanged:
          sql`${prepared ? preparedReuseUnchanged(args, prepared) : sql`true`}`.mapWith(
            pgBooleanDecoder,
          ),
      });
    if (!row) {
      return null;
    }
    if (row.discoveryStartedAt === null) {
      throw new Error("Discovered runner job is missing its start time");
    }
    return {
      discoveryStartedAt: row.discoveryStartedAt,
      preparedUnchanged: row.preparedUnchanged,
    };
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
      startedAt + RUNNER_REUSE_ROUTING_WINDOW_MS > currentTime,
    shouldLookUpFinalizingProducer:
      startedAt === undefined ||
      startedAt + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS > currentTime,
    shouldLookUpExactSandbox:
      startedAt === undefined ||
      startedAt + RUNNER_EXACT_SANDBOX_ROUTING_WINDOW_MS > currentTime,
  };
}

function runnerReuseLookupExpired(
  stages: ReturnType<typeof runnerReuseLookupStages>,
): boolean {
  return (
    !stages.shouldLookUpGenericReuse &&
    !stages.shouldLookUpFinalizingProducer &&
    !stages.shouldLookUpExactSandbox
  );
}

const findRunnerReuseCandidate$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly runnerGroup: string;
      readonly profile: string;
      readonly reuseKey: string;
      readonly shouldLookUpGenericReuse: boolean;
      readonly shouldLookUpExactSandbox: boolean;
      readonly shouldLookUpFinalizingProducer: boolean;
      readonly pendingThread?: PendingRunnerThread;
    },
  ): Promise<RunnerReuseCandidate | null> => {
    const currentDate = nowDate();
    const plan = runnerReuseCandidatePlan({
      ...args,
      freshAfter: runnerReuseStateFreshAfter(currentDate),
      finalizingCompletedAfter: new Date(
        currentDate.getTime() - RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
      ),
    });
    const [row] = await get(db$)
      .select(plan.fields)
      .from(runnerState)
      .leftJoinLateral(plan.predecessor, sql`true`)
      .leftJoin(predecessorRun, plan.joinCondition)
      .leftJoin(
        predecessorRunnerState,
        eq(predecessorRunnerState.runnerId, predecessorRun.runnerId),
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
          heartbeatSequence: row.heartbeatSequence,
          hasAdvertisedPredecessorSandbox: row.hasAdvertisedPredecessorSandbox,
          hasLocalFinalizingPredecessor: row.hasLocalFinalizingPredecessor,
          predecessorHomeEvidence: row.predecessorHomeEvidence,
          predecessorRunnerHasActiveProducer:
            row.predecessorRunnerHasActiveProducer,
          candidateRunnerHasActiveProducer:
            row.candidateRunnerHasActiveProducer,
          hasReusableSandbox: row.hasReusableSandbox,
          predecessorCompletedAt: row.predecessorCompletedAt,
          predecessorRunId: row.predecessorRunId,
          predecessorStatus: row.predecessorStatus,
          predecessorRunnerId: row.predecessorRunnerId,
          predecessorHeartbeatGeneration: row.predecessorHeartbeatGeneration,
          predecessorHeartbeatSequence: row.predecessorHeartbeatSequence,
        }
      : null;
  },
);

const selectRunnerReuseCandidate$ = command(
  async (
    { set },
    args: Omit<
      Parameters<typeof runnerReuseCandidatePlan>[0],
      "freshAfter" | "finalizingCompletedAfter"
    >,
    timing: RunnerReusePreferenceTiming | undefined,
    phase: "holder_select" | "holder_reselect",
  ) => {
    const select = () => {
      return set(findRunnerReuseCandidate$, args);
    };
    const capture = timing?.start();
    return await (capture
      ? withPgPoolAcquisitionCapture(capture.pool, async () => {
          const result = await withPgQueryExecutionCapture(
            capture.queries,
            select,
          );
          capture.success = true;
          return result;
        }).finally(() => {
          timing?.record(phase, capture);
        })
      : select());
  },
);

/** The publication owner joins this read even when its guarded write loses. */
export const prepareRunnerReusePreference$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly runnerGroup: string;
      readonly profile: string;
      readonly reuseKey: string;
      readonly thread: PendingRunnerThread;
    },
  ): Promise<RunnerReusePreparation> => {
    if (args.reuseKey !== `thread:${args.thread.threadId}`) {
      throw new Error("Prepared reuse key must match its owned Thread");
    }
    const timing = new RunnerReusePreferenceTiming();
    const currentDate = nowDate();
    const selection = await settleIncludingAbort(async () => {
      return {
        thread: args.thread,
        candidate: await set(
          selectRunnerReuseCandidate$,
          {
            ...args,
            pendingThread: args.thread,
            ...runnerReuseLookupStages(
              { discoveryStartedAt: null },
              currentDate,
            ),
          },
          timing,
          "holder_select",
        ),
      };
    });
    return {
      selection,
      operations: timing.operations({ runId: args.runId, dimensions: {} }),
    };
  },
);

export const resolveRunnerReusePreference$ = command(
  async (
    { set },
    args: RunnerReusePreferenceArgs,
    timing?: RunnerReusePreferenceTiming,
    prepared?: RunnerReusePreparation,
  ): Promise<RunnerReusePreferenceResolution> => {
    if (!args.reuseKey) {
      return {
        preference: { kind: "noPreference", reason: "noReuseKey" },
      };
    }
    if (prepared && !prepared.selection.ok) {
      throw prepared.selection.error;
    }
    const preparedSelection = prepared?.selection.ok
      ? prepared.selection.value
      : undefined;
    const lookupStages = runnerReuseLookupStages(
      preparedSelection ? { discoveryStartedAt: null } : args,
      nowDate(),
    );
    if (runnerReuseLookupExpired(lookupStages)) {
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
    let candidate = preparedSelection
      ? preparedSelection.candidate
      : await set(
          selectRunnerReuseCandidate$,
          { ...lookupArgs, ...lookupStages },
          timing,
          "holder_select",
        );

    // Prepare the candidate before starting a new window. Both delivery paths
    // await this write before returning a poll result or publishing to Ably.
    const startDiscovery = () => {
      return set(startRunnerJobDiscovery$, args, preparedSelection);
    };
    const discovery = args.discoveryStartedAt
      ? {
          discoveryStartedAt: args.discoveryStartedAt,
          preparedUnchanged: preparedSelection === undefined,
        }
      : await (async () => {
          const discoveryCapture = timing?.start();
          return await (discoveryCapture
            ? withPgPoolAcquisitionCapture(discoveryCapture.pool, async () => {
                const result = await withPgQueryExecutionCapture(
                  discoveryCapture.queries,
                  startDiscovery,
                );
                discoveryCapture.success = true;
                return result;
              }).finally(() => {
                timing?.record("discovery_persist", discoveryCapture);
              })
            : startDiscovery());
        })();
    if (discovery === null) {
      return {
        preference: { kind: "noPreference", reason: "noViableHolder" },
      };
    }
    const { discoveryStartedAt } = discovery;
    const savedStages = runnerReuseLookupStages(
      {
        discoveryStartedAt,
      },
      nowDate(),
    );
    if (runnerReuseLookupExpired(savedStages)) {
      return {
        preference: { kind: "noPreference", reason: "expired" },
      };
    }
    if (
      !discovery.preparedUnchanged ||
      (preparedSelection !== undefined &&
        preparedCompletionBridgeExpired(candidate)) ||
      lookupStages.shouldLookUpExactSandbox !==
        savedStages.shouldLookUpExactSandbox ||
      lookupStages.shouldLookUpFinalizingProducer !==
        savedStages.shouldLookUpFinalizingProducer ||
      lookupStages.shouldLookUpGenericReuse !==
        savedStages.shouldLookUpGenericReuse
    ) {
      // A competing discovery or the lookup itself may have consumed a stage.
      // Select using the saved deadline without renewing it or retrying writes.
      candidate = await set(
        selectRunnerReuseCandidate$,
        { ...lookupArgs, ...savedStages },
        timing,
        "holder_reselect",
      );
    }
    return runnerReusePreferenceResult({
      candidate,
      discoveryStartedAt,
      shouldLookUpGenericReuse: savedStages.shouldLookUpGenericReuse,
    });
  },
);

function runnerReusePreferenceResult(args: {
  readonly candidate: RunnerReuseCandidate | null;
  readonly discoveryStartedAt: Date;
  readonly shouldLookUpGenericReuse: boolean;
}): RunnerReusePreferenceResolution {
  const { candidate, discoveryStartedAt, shouldLookUpGenericReuse } = args;
  const reuseRoutingExpiresAt = new Date(
    discoveryStartedAt.getTime() + RUNNER_REUSE_ROUTING_WINDOW_MS,
  );
  const predecessorWaitUntil = new Date(
    discoveryStartedAt.getTime() + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const exactSandboxRoutingExpiresAt = new Date(
    discoveryStartedAt.getTime() + RUNNER_EXACT_SANDBOX_ROUTING_WINDOW_MS,
  );

  if (!candidate) {
    return {
      preference: {
        kind: "noPreference",
        reason: shouldLookUpGenericReuse ? "noViableHolder" : "expired",
      },
    };
  }

  if (candidate.hasAdvertisedPredecessorSandbox) {
    if (!candidate.predecessorRunId) {
      throw new Error("Exact sandbox preference is missing its predecessor");
    }
    return {
      preference: {
        kind: "preference",
        runnerIdentity: candidate.runnerIdentity,
        tier: "exactSandbox",
        predecessorRunId: candidate.predecessorRunId,
        expiresAt: exactSandboxRoutingExpiresAt.toISOString(),
      },
    };
  }

  if (candidate.hasLocalFinalizingPredecessor) {
    if (!candidate.predecessorCompletedAt || !candidate.predecessorRunId) {
      throw new Error(
        "Finalizing predecessor is missing its identity or completion time",
      );
    }
    return {
      waitBudgetSource: candidate.candidateRunnerHasActiveProducer
        ? "active_producer"
        : "completion_bridge",
      preference: {
        kind: "preference",
        runnerIdentity: candidate.runnerIdentity,
        tier: "finalizingPredecessor",
        predecessorRunId: candidate.predecessorRunId,
        expiresAt: (candidate.candidateRunnerHasActiveProducer
          ? predecessorWaitUntil
          : new Date(
              Math.min(
                candidate.predecessorCompletedAt.getTime() +
                  RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
                predecessorWaitUntil.getTime(),
              ),
            )
        ).toISOString(),
      },
    };
  }

  if (candidate.predecessorHomeEvidence !== null) {
    return predecessorHomePreferenceResult(
      candidate,
      reuseRoutingExpiresAt,
      predecessorWaitUntil,
    );
  }

  return {
    preference: {
      kind: "preference",
      runnerIdentity: candidate.runnerIdentity,
      tier: candidate.hasReusableSandbox ? "reusableSandbox" : "homeCache",
      expiresAt: reuseRoutingExpiresAt.toISOString(),
    },
  };
}

function predecessorHomePreferenceResult(
  candidate: RunnerReuseCandidate,
  routingExpiresAt: Date,
  predecessorWaitUntil: Date,
): RunnerReusePreferenceResolution {
  if (
    !candidate.predecessorRunId ||
    candidate.predecessorHomeEvidence === null
  ) {
    throw new Error(
      "Predecessor Home preference is missing its identity or evidence",
    );
  }
  const evidence = candidate.predecessorHomeEvidence;
  const home: Extract<
    PositiveRunnerPreference,
    { tier: "predecessorHome" }
  >["home"] =
    evidence === "expected"
      ? {
          evidence,
          homeWaitUntil: predecessorHomeWaitUntil(
            candidate,
            predecessorWaitUntil,
          ).toISOString(),
        }
      : { evidence };
  return {
    ...(evidence === "expected"
      ? {
          waitBudgetSource: candidate.predecessorRunnerHasActiveProducer
            ? "active_producer"
            : "completion_bridge",
        }
      : {}),
    preference: {
      kind: "preference",
      runnerIdentity: candidate.runnerIdentity,
      tier: "predecessorHome",
      predecessorRunId: candidate.predecessorRunId,
      expiresAt: routingExpiresAt.toISOString(),
      home,
    },
  };
}

function predecessorHomeWaitUntil(
  candidate: RunnerReuseCandidate,
  predecessorWaitUntil: Date,
): Date {
  if (candidate.predecessorRunnerHasActiveProducer) {
    return predecessorWaitUntil;
  }
  if (!candidate.predecessorCompletedAt) {
    throw new Error("Expected Home is missing its completion bridge");
  }
  return new Date(
    Math.min(
      candidate.predecessorCompletedAt.getTime() +
        RUNNER_FINALIZING_COMPLETION_BRIDGE_MS,
      predecessorWaitUntil.getTime(),
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
