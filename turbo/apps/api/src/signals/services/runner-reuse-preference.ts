import { enum as zEnum, type output } from "zod";
import {
  RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  type RunnerPreference,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { runnerState } from "@okouai/db/runtime/runner-state";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
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
import {
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { db$ } from "../external/db";
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
const predecessorHomeEvidenceKindSchema = zEnum([
  "advertised",
  "expected",
  "location",
]);

interface PendingRunnerThread {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly predecessorRunId: string | null;
}

/**
 * Read the captured owned Thread binding; final publication fences it again.
 * The primary-key lateral lookup yields at most one row and shares its
 * predecessor ID across all reuse conditions. A missing binding leaves it NULL.
 */
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
  // process is still finalizing. Direct dispatch checks profile eligibility
  // before using this advisory preference.
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

type PositiveRunnerPreference = Extract<
  RunnerPreference,
  { kind: "preference" }
>;

interface RunnerReuseCandidate {
  readonly runnerIdentity: PositiveRunnerPreference["runnerIdentity"];
  readonly hasAdvertisedPredecessorSandbox: boolean;
  readonly hasLocalFinalizingPredecessor: boolean;
  readonly predecessorHomeEvidence: output<
    typeof predecessorHomeEvidenceKindSchema
  > | null;
  readonly predecessorRunnerHasActiveProducer: boolean;
  readonly candidateRunnerHasActiveProducer: boolean;
  readonly hasReusableSandbox: boolean;
  readonly hasHomeCache: boolean;
  readonly hasPredecessorHostLocation: boolean;
  readonly predecessorCompletedAt: Date | null;
  readonly predecessorRunId: string | null;
}

const homeEvidenceDecoder = nullableDriverValueDecoder(
  zodEnumDriverValueDecoder(predecessorHomeEvidenceKindSchema),
);

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
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly freshAfter: Date;
  readonly shouldLookUpExactSandbox: boolean;
  readonly shouldLookUpGenericReuse: boolean;
  readonly finalizingCompletedAfter: Date;
  readonly shouldLookUpFinalizingProducer: boolean;
  readonly thread: PendingRunnerThread;
}) {
  const predecessor = pendingRunnerThreadPredecessor(args.thread);
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
      hasAdvertisedPredecessorSandbox: sql`${exactSandboxCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasLocalFinalizingPredecessor: sql`${finalizingCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      predecessorHomeEvidence: sql`${homeEvidence}`.mapWith(
        homeEvidenceDecoder,
      ),
      predecessorRunnerHasActiveProducer:
        sql`coalesce(${predecessorHome.activeProducer}, false)`.mapWith(
          pgBooleanDecoder,
        ),
      candidateRunnerHasActiveProducer: sql`${producerCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
      hasHomeCache: sql`${homeCondition}`.mapWith(pgBooleanDecoder),
      hasPredecessorHostLocation: sql`${predecessorHome.hostLocation}`.mapWith(
        pgBooleanDecoder,
      ),
      predecessorCompletedAt: predecessorRun.completedAt,
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

export interface RunnerReusePreparation {
  readonly selection:
    | {
        readonly ok: true;
        readonly value: RunnerReuseCandidate | null;
      }
    | { readonly ok: false; readonly error: unknown };
  readonly operations: ReturnType<RunnerReusePreferenceTiming["operations"]>;
}

function predecessorCompletionBridgeActive(
  candidate: RunnerReuseCandidate,
  currentDate: Date,
): boolean {
  return (
    candidate.predecessorCompletedAt !== null &&
    candidate.predecessorCompletedAt.getTime() +
      RUNNER_FINALIZING_COMPLETION_BRIDGE_MS >
      currentDate.getTime()
  );
}

function runnerReuseLookupStages(
  args: {
    readonly admittedAt: Date | null;
  },
  currentDate: Date,
) {
  const currentTime = currentDate.getTime();
  const startedAt = args.admittedAt?.getTime();
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
      readonly runnerGroup: string;
      readonly profile: string;
      readonly reuseKey: string;
      readonly shouldLookUpGenericReuse: boolean;
      readonly shouldLookUpExactSandbox: boolean;
      readonly shouldLookUpFinalizingProducer: boolean;
      readonly thread: PendingRunnerThread;
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
          hasAdvertisedPredecessorSandbox: row.hasAdvertisedPredecessorSandbox,
          hasLocalFinalizingPredecessor: row.hasLocalFinalizingPredecessor,
          predecessorHomeEvidence: row.predecessorHomeEvidence,
          predecessorRunnerHasActiveProducer:
            row.predecessorRunnerHasActiveProducer,
          candidateRunnerHasActiveProducer:
            row.candidateRunnerHasActiveProducer,
          hasReusableSandbox: row.hasReusableSandbox,
          hasHomeCache: row.hasHomeCache,
          hasPredecessorHostLocation: row.hasPredecessorHostLocation,
          predecessorCompletedAt: row.predecessorCompletedAt,
          predecessorRunId: row.predecessorRunId,
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
    phase: "holder_select",
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
      return await set(
        selectRunnerReuseCandidate$,
        {
          runnerGroup: args.runnerGroup,
          profile: args.profile,
          reuseKey: args.reuseKey,
          thread: args.thread,
          ...runnerReuseLookupStages({ admittedAt: null }, currentDate),
        },
        timing,
        "holder_select",
      );
    });
    return {
      selection,
      operations: timing.operations({ runId: args.runId, dimensions: {} }),
    };
  },
);

function runnerReusePreferenceResult(args: {
  readonly candidate: RunnerReuseCandidate | null;
  readonly admittedAt: Date;
}): RunnerPreference {
  const { candidate, admittedAt } = args;
  const currentDate = nowDate();
  const stages = runnerReuseLookupStages({ admittedAt }, currentDate);
  if (runnerReuseLookupExpired(stages)) {
    return { kind: "noPreference", reason: "expired" };
  }
  const reuseRoutingExpiresAt = new Date(
    admittedAt.getTime() + RUNNER_REUSE_ROUTING_WINDOW_MS,
  );
  const predecessorWaitUntil = new Date(
    admittedAt.getTime() + RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS,
  );
  const exactSandboxRoutingExpiresAt = new Date(
    admittedAt.getTime() + RUNNER_EXACT_SANDBOX_ROUTING_WINDOW_MS,
  );

  if (!candidate) {
    return {
      kind: "noPreference",
      reason: stages.shouldLookUpGenericReuse ? "noViableHolder" : "expired",
    };
  }

  if (
    stages.shouldLookUpExactSandbox &&
    candidate.hasAdvertisedPredecessorSandbox
  ) {
    if (!candidate.predecessorRunId) {
      throw new Error("Exact sandbox preference is missing its predecessor");
    }
    return {
      kind: "preference",
      runnerIdentity: candidate.runnerIdentity,
      tier: "exactSandbox",
      predecessorRunId: candidate.predecessorRunId,
      expiresAt: exactSandboxRoutingExpiresAt.toISOString(),
    };
  }

  const completionBridgeActive = predecessorCompletionBridgeActive(
    candidate,
    currentDate,
  );
  if (
    stages.shouldLookUpFinalizingProducer &&
    candidate.hasLocalFinalizingPredecessor &&
    (candidate.candidateRunnerHasActiveProducer || completionBridgeActive)
  ) {
    if (!candidate.predecessorCompletedAt || !candidate.predecessorRunId) {
      throw new Error(
        "Finalizing predecessor is missing its identity or completion time",
      );
    }
    return {
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
    };
  }

  if (!stages.shouldLookUpGenericReuse) {
    return { kind: "noPreference", reason: "expired" };
  }
  const homeEvidence = currentPredecessorHomeEvidence(
    candidate,
    completionBridgeActive,
  );
  if (homeEvidence !== null) {
    return predecessorHomePreferenceResult(
      { ...candidate, predecessorHomeEvidence: homeEvidence },
      reuseRoutingExpiresAt,
      predecessorWaitUntil,
    );
  }

  if (!candidate.hasReusableSandbox && !candidate.hasHomeCache) {
    return { kind: "noPreference", reason: "noViableHolder" };
  }
  return {
    kind: "preference",
    runnerIdentity: candidate.runnerIdentity,
    tier: candidate.hasReusableSandbox ? "reusableSandbox" : "homeCache",
    expiresAt: reuseRoutingExpiresAt.toISOString(),
  };
}

/** Resolve the captured direct placement read against the admission clock. */
export function preparedRunnerReusePreference(
  preparation: RunnerReusePreparation | undefined,
  admittedAt: Date,
): RunnerPreference {
  if (preparation === undefined) {
    return { kind: "noPreference", reason: "noReuseKey" };
  }
  if (!preparation.selection.ok) {
    throw preparation.selection.error;
  }
  return runnerReusePreferenceResult({
    candidate: preparation.selection.value,
    admittedAt,
  });
}

function currentPredecessorHomeEvidence(
  candidate: RunnerReuseCandidate,
  completionBridgeActive: boolean,
): RunnerReuseCandidate["predecessorHomeEvidence"] {
  if (
    candidate.predecessorHomeEvidence !== "expected" ||
    candidate.predecessorRunnerHasActiveProducer ||
    completionBridgeActive
  ) {
    return candidate.predecessorHomeEvidence;
  }
  return candidate.hasPredecessorHostLocation &&
    !candidate.hasReusableSandbox &&
    !candidate.hasHomeCache
    ? "location"
    : null;
}

function predecessorHomePreferenceResult(
  candidate: RunnerReuseCandidate,
  routingExpiresAt: Date,
  predecessorWaitUntil: Date,
): RunnerPreference {
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
    kind: "preference",
    runnerIdentity: candidate.runnerIdentity,
    tier: "predecessorHome",
    predecessorRunId: candidate.predecessorRunId,
    expiresAt: routingExpiresAt.toISOString(),
    home,
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
