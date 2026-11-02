import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import {
  claimCompatibleStoredExecutionContextSchema,
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  elapsedSinceApiStartMs,
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
  runnersSteerContract,
  runnerVersionSchema,
  STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
  STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
  type ExecutionContext,
  type HeldSandboxState,
  type HeldHomeState,
  type RunnerClaimCapabilities,
  type RunnerInstalledVersions,
  type RunnerPreference,
  type RunnerPreferenceClaimState,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";

import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { runnerState } from "@okouai/db/runtime/runner-state";
import type {
  RunnerHeldSandboxState as PersistedRunnerHeldSandboxState,
  RunnerHeldHomeState as PersistedRunnerHeldHomeState,
} from "@okouai/db/jsonb-contracts/runner-state";
import { command } from "ccstate";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { infer as zInfer } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import {
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
  type PgPoolAcquisitionCapture,
  type PgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { monotonicNow, now, nowDate } from "../../lib/time";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { runnerAuth$, type RunnerAuthContext } from "../auth/runner-auth";
import { generateSandboxToken } from "../auth/tokens";
import { authorization$, request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { JsonResponseObserver } from "../context/route";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { signClaimedContentBundle$ } from "../services/content-bundle-claim";
import {
  workflowClaimInput,
  type WorkflowClaimInput,
} from "../services/workflow-claim.service";
import {
  createRunnerGroupRealtimeToken,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";

import {
  recordClaimResponseJsonSerialization,
  recordSandboxOperations,
} from "../external/sandbox-op-log";
import type { RouteEntry } from "../route-entry";
import {
  declareSteeredInput$,
  loadNextSteerableInput$,
} from "../services/active-input-delivery.service";
import { dispatchCompleteSideEffects$ } from "../services/agent-run-lifecycle.service";
import { scheduleReleasedSlotPicks$ } from "../services/agent-run-slot-scheduling.service";
import {
  commitFailedQueuedRun$,
  type ReleasedRunSlot,
} from "../services/agent-run-terminal-transition.service";
import { notifyRunningChatRunOfPendingInput$ } from "../services/chat-thread-queue-drain.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "../services/connector-catalog-slug-source.service";
import { connectorRunnerFirewallCatalog$ } from "../services/connector-runner-firewall-catalog.service";
import { resolveConnectorRuntimeTargets$ } from "../services/connector-runtime-sync.service";
import { decryptPersistentSecretsMap } from "../services/crypto.utils";
import { resolvePiModelConfigForClaim } from "../services/pi-model-config-claim-capability";
import {
  resolveRunnerReusePreference$,
  runnerPreferenceTelemetryDimensions,
  runnerReuseKeyTelemetryKind,
  runnerReusePreferenceLookupError,
  runnerReusePreferencePollPriority,
} from "../services/runner-reuse-preference";
import {
  buildClaimTransitionSql,
  claimTransitionSqlRowSchema,
  decodeClaimTransitionResult,
  type ClaimTransitionResult,
} from "../services/runner-claim-transition";

import {
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshesRecord,
  readActiveNetworkPolicyRefreshes$,
} from "../services/user-permission-grants.service";
import { safeSync, settle, tapError } from "../utils";

const L = logger("Runners");

type SandboxOperationAttrs = Parameters<
  typeof recordSandboxOperations
>[0][number];
type RunnerClaimIdentity = NonNullable<
  zInfer<(typeof runnersJobClaimContract.claim)["body"]>["runnerIdentity"]
>;
interface RunnerClaimAttribution {
  readonly runnerIdentity: RunnerClaimIdentity;
  readonly runnerHostname: string | null;
  readonly runnerVersion: string | null;
  /** Okou CLI installed in the claimant's rootfs; null for legacy runners. */
  readonly installedVersions: RunnerInstalledVersions | null;
}

function runnerClaimAttributionDimensions(
  attribution: RunnerClaimAttribution | undefined,
): Record<string, string> {
  if (!attribution) {
    return {};
  }

  return {
    runner_id: attribution.runnerIdentity.runnerId,
    runner_heartbeat_generation: String(
      attribution.runnerIdentity.heartbeatGeneration,
    ),
    ...(attribution.runnerHostname
      ? { runner_hostname: attribution.runnerHostname }
      : {}),
    ...(attribution.runnerVersion
      ? { runner_version: attribution.runnerVersion }
      : {}),
    ...(attribution.installedVersions
      ? {
          runner_installed_cli_version: attribution.installedVersions.cli,
          runner_installed_pi_agent_runtime_version:
            attribution.installedVersions.piAgentRuntime,
        }
      : {}),
  };
}

const STALE_RUNNER_THRESHOLD_MS = 5 * 60 * 1000;
const INVALID_EXECUTION_CONTEXT_ERROR =
  "Runner job missing valid execution context";
const runnerClaimVersionHeaderSchema = runnerVersionSchema.optional();
const MAX_VALIDATION_ISSUES_TO_LOG = 10;

function mergeClaimVars(args: {
  readonly runVars: Record<string, string> | null;
  readonly connectorVars: Record<string, string> | null | undefined;
}): Record<string, string> | null {
  const merged: Record<string, string> = {};
  if (args.runVars) {
    Object.assign(merged, args.runVars);
  }
  if (args.connectorVars) {
    Object.assign(merged, args.connectorVars);
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

interface ClaimFailedSideEffectArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly error: string;
  readonly releasedSlots: readonly ReleasedRunSlot[];
}

type ClaimRouteTimingSpanKind = "parent" | "top_level" | "nested";
type ClaimNetworkPolicyRefreshPath = "current_catalog" | "no_builtin_targets";
type ClaimRouteTimingActionType =
  | "claim_route_request_to_transition_start"
  | "claim_route_request_to_response_ready"
  | "claim_route_request_prepare"
  | "claim_route_lookup_authorization"
  | "claim_route_lookup_query"
  | "claim_route_lookup_pool_acquire"
  | "claim_route_lookup_sql_call"
  | "claim_route_lookup_application_remainder"
  | "claim_route_context_parse"
  | "claim_route_secret_materialization"
  | "claim_route_response_assembly"
  | "claim_route_response_network_policy_refresh"
  | "claim_route_response_resume_session"
  | "claim_route_transition_running"
  | "claim_route_transition_execute";

interface ClaimRouteTimingRecord {
  readonly actionType: ClaimRouteTimingActionType;
  readonly spanKind: ClaimRouteTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly fallbackReason?: "invalid_keys";
  readonly policyRefreshPath?: ClaimNetworkPolicyRefreshPath;
  readonly dimensions?: Readonly<Record<string, string>>;
}

class ClaimRouteTimingCollector {
  private readonly records: ClaimRouteTimingRecord[] = [];

  async measureLookup<T>(operation: () => Promise<T>): Promise<T> {
    const pool: PgPoolAcquisitionCapture = { acquisitions: [] };
    const query: PgQueryExecutionCapture = { executions: [] };
    const startedAt = monotonicNow();
    return await withPgPoolAcquisitionCapture(pool, async () => {
      return await withPgQueryExecutionCapture(query, operation);
    }).finally(() => {
      safeSync(() => {
        const durationMs = monotonicNow() - startedAt;
        const timestamp = nowDate().toISOString();
        const dimensions = {
          db_pool_capture:
            pool.acquisitions.length === 1
              ? "single"
              : pool.acquisitions.length === 0
                ? "missing"
                : "multiple",
          db_query_capture:
            query.executions.length === 1
              ? "single"
              : query.executions.length === 0
                ? "missing"
                : "multiple",
        };
        this.records.push({
          actionType: "claim_route_lookup_query",
          spanKind: "nested",
          durationMs,
          timestamp,
          dimensions,
        });
        const [acquisition] = pool.acquisitions;
        const [execution] = query.executions;
        if (pool.acquisitions.length === 1 && acquisition) {
          this.records.push({
            actionType: "claim_route_lookup_pool_acquire",
            spanKind: "nested",
            durationMs: acquisition.durationMs,
            timestamp: new Date(acquisition.finishedAt).toISOString(),
            dimensions: {
              ...dimensions,
              db_pool_acquire_path: acquisition.path,
            },
          });
        }
        if (query.executions.length === 1 && execution) {
          this.records.push({
            actionType: "claim_route_lookup_sql_call",
            spanKind: "nested",
            durationMs: execution.durationMs,
            timestamp: new Date(execution.finishedAt).toISOString(),
            dimensions,
          });
        }
        // The one lookup acquires once and executes once, sequentially. The
        // remainder includes query construction and Drizzle result mapping.
        // Missing/ambiguous coverage must not become zero wait or SQL time.
        if (
          pool.acquisitions.length === 1 &&
          query.executions.length === 1 &&
          acquisition &&
          execution &&
          durationMs >= acquisition.durationMs + execution.durationMs
        ) {
          this.records.push({
            actionType: "claim_route_lookup_application_remainder",
            spanKind: "nested",
            durationMs:
              durationMs - acquisition.durationMs - execution.durationMs,
            timestamp,
            dimensions,
          });
        }
      });
    });
  }

  recordElapsed(
    actionType: ClaimRouteTimingActionType,
    spanKind: ClaimRouteTimingSpanKind,
    startedAt: number,
    finishedAt: number = now(),
  ): void {
    this.records.push({
      actionType,
      spanKind,
      durationMs: Math.max(0, finishedAt - startedAt),
      timestamp: new Date(finishedAt).toISOString(),
    });
  }

  measureInvalidKeySecretMaterialization<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    return operation().finally(() => {
      const finishedAt = now();
      this.records.push({
        actionType: "claim_route_secret_materialization",
        spanKind: "top_level",
        durationMs: Math.max(0, finishedAt - startedAt),
        timestamp: new Date(finishedAt).toISOString(),
        fallbackReason: "invalid_keys",
      });
    });
  }

  recordNetworkPolicyRefresh(
    startedAt: number,
    finishedAt: number,
    path: ClaimNetworkPolicyRefreshPath | undefined,
  ): void {
    this.records.push({
      actionType: "claim_route_response_network_policy_refresh",
      spanKind: "nested",
      durationMs: Math.max(0, finishedAt - startedAt),
      timestamp: new Date(finishedAt).toISOString(),
      ...(path === undefined ? {} : { policyRefreshPath: path }),
    });
  }

  flush(args: {
    readonly runId: string;
    readonly runnerGroup: string;
    readonly profile: string;
    readonly authType: RunnerAuthContext["type"];
    readonly discoverySource: string | undefined;
    readonly pollReason: string | undefined;
    readonly runnerAttribution: RunnerClaimAttribution | undefined;
  }): void {
    const records = this.records.splice(0);
    const dimensions: Record<string, string> = {
      runner_group: args.runnerGroup,
      profile: args.profile,
      auth_type: args.authType,
    };
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    if (apiCommitSha) {
      dimensions.api_commit_sha = apiCommitSha;
    }
    if (args.discoverySource) {
      dimensions.discovery_source = args.discoverySource;
    }
    if (args.pollReason) {
      dimensions.poll_reason = args.pollReason;
    }

    recordSandboxOperations(
      records.map((record) => {
        return {
          sandboxType: "runner",
          actionType: record.actionType,
          durationMs: record.durationMs,
          success: true,
          runId: args.runId,
          timestamp: record.timestamp,
          dimensions: {
            ...dimensions,
            ...record.dimensions,
            span_kind: record.spanKind,
            ...(record.spanKind === "nested"
              ? runnerClaimAttributionDimensions(args.runnerAttribution)
              : {}),
            ...(record.fallbackReason
              ? { fallback_reason: record.fallbackReason }
              : {}),
            ...(record.policyRefreshPath
              ? { policy_refresh_path: record.policyRefreshPath }
              : {}),
          },
        };
      }),
    );
  }
}

interface ValidationIssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

function validationIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "<root>";
  }
  return path
    .map((segment) => {
      return String(segment);
    })
    .join(".");
}

function warnInvalidStoredExecutionContext(
  runId: string,
  issues: readonly ValidationIssueLike[],
): void {
  const validationIssueCount = issues.length;
  const validationIssues = issues
    .slice(0, MAX_VALIDATION_ISSUES_TO_LOG)
    .map((issue) => {
      return {
        path: validationIssuePath(issue.path),
        code: issue.code,
        message: issue.message,
      };
    });
  L.warn(INVALID_EXECUTION_CONTEXT_ERROR, {
    runId,
    validationIssueCount,
    validationIssues,
    validationIssuesOmitted: Math.max(
      0,
      validationIssueCount - MAX_VALIDATION_ISSUES_TO_LOG,
    ),
  });
}

const unauthorizedNotAuthenticated = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    }),
  }),
});

const unauthorizedAuthenticationRequired = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Authentication required",
      code: "UNAUTHORIZED",
    }),
  }),
});

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: {
      error: { message, code: "FORBIDDEN" },
    },
  };
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
}

function canonicalizeHeldSandboxStates(
  states: readonly HeldSandboxState[],
): PersistedRunnerHeldSandboxState[] {
  return states.map((state) => {
    return {
      reuseKey: state.reuseKey,
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
      reusableSandbox: {
        profile: state.reusableSandbox.profile,
        sourceRunId: state.reusableSandbox.sourceRunId,
      },
    };
  });
}

function canonicalizeHeldHomeStates(
  states: readonly HeldHomeState[],
): PersistedRunnerHeldHomeState[] {
  return states.map((state) => {
    const [first, ...remaining] = state.homeCaches;
    if (!first) {
      throw new Error("Held home state requires a home cache");
    }
    return {
      reuseKey: state.reuseKey,
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
      homeCaches: [
        {
          profile: first.profile,
          homeAffinityVersion: first.homeAffinityVersion,
          sourceRunId: first.sourceRunId,
        },
        ...remaining.map((cache) => {
          return {
            profile: cache.profile,
            homeAffinityVersion: cache.homeAffinityVersion,
            sourceRunId: cache.sourceRunId,
          };
        }),
      ],
    };
  });
}

const heartbeatBody$ = bodyResultOf(runnersHeartbeatContract.heartbeat);

const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedNotAuthenticated;
  }

  const body = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  if (!isOfficialRunnerGroup(body.data.group)) {
    return badRequestMessage("Invalid runner group");
  }

  const heldSandboxStates = canonicalizeHeldSandboxStates(
    body.data.heldSandboxStates,
  );
  const heldHomeStates =
    auth.type === "official-runner"
      ? canonicalizeHeldHomeStates(body.data.heldHomeStates)
      : [];
  const admittableProfiles = body.data.admittableProfiles;
  // Every accepted writer replaces locality. An omitted or PAT hostname cannot
  // retain an earlier official observation; stale messages retain the whole row.
  const runnerHostname =
    auth.type === "official-runner" ? (body.data.runnerHostname ?? null) : null;
  const currentDate = nowDate();
  const snapshotOrder = {
    generation: body.data.snapshotGeneration,
    sequence: body.data.snapshotSequence,
  };
  const db = set(writeDb$);
  await db
    .insert(runnerState)
    .values({
      runnerId: body.data.runnerId,
      runnerHostname,
      runnerGroup: body.data.group,
      heartbeatGeneration: snapshotOrder.generation,
      heartbeatSequence: snapshotOrder.sequence,
      totalVcpu: body.data.totalVcpu,
      totalMemoryMb: body.data.totalMemoryMb,
      maxConcurrent: body.data.maxConcurrent,
      allocatedVcpu: body.data.allocatedVcpu,
      allocatedMemoryMb: body.data.allocatedMemoryMb,
      runningCount: body.data.runningCount,
      admittableProfiles,
      heldSandboxStates,
      heldHomeStates,
      activeReuseProducers: body.data.activeReuseProducers,
      mode: body.data.mode,
      lastSeenAt: currentDate,
    })
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: {
        runnerHostname,
        runnerGroup: body.data.group,
        heartbeatGeneration: snapshotOrder.generation,
        heartbeatSequence: snapshotOrder.sequence,
        totalVcpu: body.data.totalVcpu,
        totalMemoryMb: body.data.totalMemoryMb,
        maxConcurrent: body.data.maxConcurrent,
        allocatedVcpu: body.data.allocatedVcpu,
        allocatedMemoryMb: body.data.allocatedMemoryMb,
        runningCount: body.data.runningCount,
        // A fresh heartbeat still advances the ordered scalar state below.
        // Reuse stored TOAST values for unchanged JSONB snapshots instead of
        // rewriting them on every heartbeat.
        admittableProfiles: sql`CASE WHEN ${runnerState.admittableProfiles} IS DISTINCT FROM excluded.admittable_profiles THEN excluded.admittable_profiles ELSE ${runnerState.admittableProfiles} END`,
        heldSandboxStates: sql`CASE WHEN ${runnerState.heldSandboxStates} IS DISTINCT FROM excluded.held_sandbox_states THEN excluded.held_sandbox_states ELSE ${runnerState.heldSandboxStates} END`,
        heldHomeStates: sql`CASE WHEN ${runnerState.heldHomeStates} IS DISTINCT FROM excluded.held_home_states THEN excluded.held_home_states ELSE ${runnerState.heldHomeStates} END`,
        activeReuseProducers: sql`CASE WHEN ${runnerState.activeReuseProducers} IS DISTINCT FROM excluded.active_reuse_producers THEN excluded.active_reuse_producers ELSE ${runnerState.activeReuseProducers} END`,
        mode: body.data.mode,
        lastSeenAt: currentDate,
      },
      setWhere: or(
        lt(runnerState.heartbeatGeneration, snapshotOrder.generation),
        and(
          eq(runnerState.heartbeatGeneration, snapshotOrder.generation),
          lt(runnerState.heartbeatSequence, snapshotOrder.sequence),
        ),
      ),
    });
  signal.throwIfAborted();

  await db
    .delete(runnerState)
    .where(
      lt(
        runnerState.lastSeenAt,
        new Date(currentDate.getTime() - STALE_RUNNER_THRESHOLD_MS),
      ),
    );
  signal.throwIfAborted();

  return { status: 200 as const, body: { ok: true as const } };
});

const pollBody$ = bodyResultOf(runnersPollContract.poll);

function recordPollTimingMetrics(args: {
  readonly runId: string;
  readonly runnerId: string | undefined;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly pollReason: string | undefined;
  readonly runnerPreference: RunnerPreference;
  readonly reuseKeyKind: "thread" | "session" | "none";
  readonly reuseKey: string | null;
  readonly queueCreatedAtMs: number;
  readonly pollRequestStartedAtMs: number;
  readonly pendingJobLookupStartedAtMs: number;
  readonly pendingJobLookupFinishedAtMs: number;
  readonly pollResponseAtMs: number;
}): void {
  const dimensions: Record<string, string> = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    auth_type: args.authType,
    ...(args.runnerId === undefined ? {} : { runner_id: args.runnerId }),
    reuse_key_kind: args.reuseKeyKind,
    ...(args.reuseKey === null ? {} : { reuse_key: args.reuseKey }),
    ...runnerPreferenceTelemetryDimensions(args.runnerPreference),
  };
  if (args.pollReason) {
    dimensions.poll_reason = args.pollReason;
  }

  recordSandboxOperations([
    {
      sandboxType: "runner",
      actionType: "runner_poll_pending_job_lookup",
      durationMs: Math.max(
        0,
        args.pendingJobLookupFinishedAtMs - args.pendingJobLookupStartedAtMs,
      ),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_poll_request_to_job_response",
      durationMs: Math.max(
        0,
        args.pollResponseAtMs - args.pollRequestStartedAtMs,
      ),
      success: true,
      runId: args.runId,
      dimensions,
    },
    {
      sandboxType: "runner",
      actionType: "runner_queue_to_poll_response",
      durationMs: Math.max(0, args.pollResponseAtMs - args.queueCreatedAtMs),
      success: true,
      runId: args.runId,
      dimensions,
    },
  ]);
}

function runnerPollPriorityOrder(args: {
  readonly runnerId: string | undefined;
  readonly runnerGroup: string;
  readonly currentDate: Date;
}): SQL[] {
  if (!args.runnerId) {
    return [];
  }
  return [
    desc(
      runnerReusePreferencePollPriority({
        runnerId: args.runnerId,
        runnerGroup: args.runnerGroup,
        currentDate: args.currentDate,
      }),
    ),
  ];
}

const resolvePollRunnerReusePreference$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly runnerGroup: string;
      readonly profile: string;
      readonly reuseKey: string | null;
      readonly discoveryStartedAt: Date | null;
    },
  ) => {
    const resolution = await tapError(
      set(resolveRunnerReusePreference$, args),
      (error) => {
        L.warn("Failed to resolve runner reuse preference for poll response", {
          runId: args.runId,
          runnerGroup: args.runnerGroup,
          profile: args.profile,
          error,
        });
      },
    );
    return resolution?.preference ?? runnerReusePreferenceLookupError();
  },
);

const findPendingRunnerJob$ = command(
  async (
    { get },
    args: {
      readonly conditions: readonly SQL[];
      readonly priorityOrder: readonly SQL[];
    },
  ) => {
    const [pendingJob] = await get(db$)
      .select({
        runId: runnerJobQueue.runId,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
        profile: runnerJobQueue.profile,
        cliAgentSessionId: runnerJobQueue.cliAgentSessionId,
        reuseKey: runnerJobQueue.reuseKey,
        createdAt: runnerJobQueue.createdAt,
        discoveryStartedAt: runnerJobQueue.discoveryStartedAt,
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .where(and(...args.conditions))
      .orderBy(
        ...args.priorityOrder,
        runnerJobQueue.createdAt,
        runnerJobQueue.runId,
      )
      .limit(1);
    return pendingJob;
  },
);

const pollInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const pollRequestStartedAtMs = now();
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedAuthenticationRequired;
  }

  const body = await get(pollBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const { group, supportedProfiles, excludedRunIds } = body.data;
  const whereConditions: SQL[] = [
    eq(runnerJobQueue.runnerGroup, group),
    gt(runnerJobQueue.expiresAt, sql`now()`),
    eq(agentRuns.status, "pending"),
  ];

  if (auth.type === "official-runner") {
    if (!isOfficialRunnerGroup(group)) {
      return forbidden("Official runners can only poll vm0/* groups");
    }
  } else {
    if (!isOfficialRunnerGroup(group)) {
      return forbidden("Only vm0/* runner groups are supported");
    }
    whereConditions.push(eq(agentRuns.userId, auth.userId));
  }

  whereConditions.push(inArray(runnerJobQueue.profile, supportedProfiles));
  if (excludedRunIds && excludedRunIds.length > 0) {
    whereConditions.push(notInArray(runnerJobQueue.runId, excludedRunIds));
  }
  set(writeDb$);
  const pendingJobLookupStartedAtMs = now();
  const currentDate = nowDate();
  const reusePreferencePriorityOrder = runnerPollPriorityOrder({
    runnerId: body.data.runnerId,
    runnerGroup: group,
    currentDate,
  });
  const pendingJob = await set(findPendingRunnerJob$, {
    conditions: whereConditions,
    priorityOrder: reusePreferencePriorityOrder,
  });
  signal.throwIfAborted();
  const pendingJobLookupFinishedAtMs = now();

  if (!pendingJob) {
    return { status: 200 as const, body: { job: null } };
  }
  const runnerPreference = await set(resolvePollRunnerReusePreference$, {
    runId: pendingJob.runId,
    runnerGroup: group,
    profile: pendingJob.profile,
    reuseKey: pendingJob.reuseKey,
    discoveryStartedAt: pendingJob.discoveryStartedAt,
  });
  signal.throwIfAborted();
  recordPollTimingMetrics({
    runId: pendingJob.runId,
    runnerId: body.data.runnerId,
    runnerGroup: group,
    profile: pendingJob.profile,
    authType: auth.type,
    pollReason: body.data.telemetry?.pollReason,
    runnerPreference,
    reuseKeyKind: runnerReuseKeyTelemetryKind(pendingJob.reuseKey),
    reuseKey: pendingJob.reuseKey,
    queueCreatedAtMs: pendingJob.createdAt.getTime(),
    pollRequestStartedAtMs,
    pendingJobLookupStartedAtMs,
    pendingJobLookupFinishedAtMs,
    pollResponseAtMs: now(),
  });

  return {
    status: 200 as const,
    body: {
      job: {
        runId: pendingJob.runId,
        prompt: pendingJob.prompt,
        appendSystemPrompt: pendingJob.appendSystemPrompt,
        vars: (pendingJob.vars as Record<string, string>) ?? null,
        experimentalProfile: pendingJob.profile,
        cliAgentSessionId: pendingJob.cliAgentSessionId,
        reuseKey: pendingJob.reuseKey,
        runnerPreference,
      },
    },
  };
});

const claimBody$ = bodyResultOf(runnersJobClaimContract.claim);
const connectorRuntimeSyncBody$ = bodyResultOf(
  runnersConnectorRuntimeSyncContract.sync,
);
const builtinFirewallsResolveBody$ = bodyResultOf(
  runnersBuiltinFirewallsResolveContract.resolve,
);

interface ClaimableJob {
  readonly job: Pick<
    typeof runnerJobQueue.$inferSelect,
    "runnerGroup" | "profile" | "reuseKey" | "executionContext" | "createdAt"
  >;
  readonly run: ClaimedRun;
}

interface ClaimedRun {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string | null;
  readonly modelProvider: (typeof agentRuns.$inferSelect)["modelProvider"];
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly vars: unknown;
  readonly isFirstRun: boolean | null;
}

interface RunNetworkPolicyScope {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly status: RunStatus;
}

type ClaimLookupResult = ClaimableJob | ReturnType<typeof notFound>;

function isClaimableJob(value: ClaimLookupResult): value is ClaimableJob {
  return "job" in value;
}

const getRunNetworkPolicyScope$ = command(
  async (
    { get },
    runId: string,
    signal: AbortSignal,
  ): Promise<RunNetworkPolicyScope | undefined> => {
    const db = get(db$);
    const [row] = await db
      .select({
        runId: agentRuns.id,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        agentId: agents.id,
        status: agentRuns.status,
      })
      .from(agentRuns)

      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    return row
      ? {
          ...row,
          status: runStatusSchema.parse(row.status),
        }
      : undefined;
  },
);

function runnerRunAuthorizationError(
  auth: RunnerAuthContext,
  run: Pick<RunNetworkPolicyScope, "userId">,
) {
  if (auth.type === "official-runner") {
    return null;
  }
  return run.userId === auth.userId
    ? null
    : forbidden("Run does not belong to user");
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

const getClaimableJob$ = command(
  async (
    { get },
    runId: string,
    signal: AbortSignal,
  ): Promise<ClaimLookupResult> => {
    const db = get(db$);
    const [jobWithRun] = await db
      .select({
        job: {
          runnerGroup: runnerJobQueue.runnerGroup,
          profile: runnerJobQueue.profile,
          reuseKey: runnerJobQueue.reuseKey,
          executionContext: runnerJobQueue.executionContext,
          createdAt: runnerJobQueue.createdAt,
        },
        run: {
          id: agentRuns.id,
          userId: agentRuns.userId,
          orgId: agentRuns.orgId,
          agentId: agentRuns.agentId,
          prompt: agentRuns.prompt,
          appendSystemPrompt: agentRuns.appendSystemPrompt,
          vars: agentRuns.vars,
          modelProvider: agentRuns.modelProvider,
          // Claim's current input may already belong to this Run; only another
          // run-attributed event is evidence of earlier thread activity.
          isFirstRun: sql`
          CASE WHEN ${agentRuns.chatThreadId} IS NULL THEN NULL
          ELSE ${notExists(
            db
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                and(
                  eq(chatEvents.chatThreadId, agentRuns.chatThreadId),
                  isNotNull(chatEvents.runId),
                  ne(chatEvents.runId, agentRuns.id),
                ),
              ),
          )} END
        `.mapWith(nullableDriverValueDecoder(pgBooleanDecoder)),
        },
      })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
      .where(
        and(
          eq(runnerJobQueue.runId, runId),
          or(isNotNull(agentRuns.agentId), isNull(agentRuns.chatThreadId)),
          gt(runnerJobQueue.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (jobWithRun) {
      return {
        job: jobWithRun.job,
        run: jobWithRun.run,
      };
    }
    return notFound("Job not found in queue");
  },
);

function claimAuthorizationError(
  auth: RunnerAuthContext,
  jobWithRun: ClaimableJob,
) {
  if (auth.type === "official-runner") {
    return isOfficialRunnerGroup(jobWithRun.job.runnerGroup)
      ? null
      : forbidden("Official runners can only claim jobs from vm0/* groups");
  }

  if (jobWithRun.run.userId !== auth.userId) {
    return forbidden("Job does not belong to user");
  }
  if (jobWithRun.run.modelProvider === "built-in") {
    return forbidden("Built-in model jobs require an official runner");
  }
  return isOfficialRunnerGroup(jobWithRun.job.runnerGroup)
    ? null
    : forbidden("Only vm0/* runner groups are supported");
}

type ClaimedTransitionResult = Extract<
  ClaimTransitionResult,
  { readonly status: "claimed" }
>;
type BaseClaimResponse = Omit<ExecutionContext, "contentBundles">;

const withClaimedContentBundles$ = command(
  async (
    { set },
    args: {
      readonly responseBody: BaseClaimResponse;
      readonly claim: ClaimedTransitionResult;
      readonly workflowInput: WorkflowClaimInput;
      readonly officialWorkflowBundles: StoredExecutionContext["officialWorkflowBundles"];
    },
    signal: AbortSignal,
  ): Promise<ExecutionContext> => {
    const instructions =
      args.claim.instructionsBundle === null
        ? undefined
        : await set(
            signClaimedContentBundle$,
            args.claim.instructionsBundle,
            signal,
          );
    const skills = await Promise.all(
      [
        ...args.claim.workflows.map((workflow) => {
          return {
            contentBundle: workflow.contentBundle,
            mountPath: `${args.workflowInput.skillRoot}/${workflow.name}`,
          };
        }),
        ...(args.officialWorkflowBundles ?? []).map((bundle) => {
          return {
            contentBundle: bundle,
            mountPath: bundle.mountPath,
          };
        }),
      ].map(async (workflow) => {
        return {
          ...(await set(
            signClaimedContentBundle$,
            workflow.contentBundle,
            signal,
          )),
          mountPath: workflow.mountPath,
        };
      }),
    );
    signal.throwIfAborted();
    const workflowMountPaths = new Set(
      skills.map((skill) => {
        return skill.mountPath;
      }),
    );
    return {
      ...args.responseBody,
      contentBundles: { format: "tar-gzip-v1", instructions, skills },
      storageManifest: {
        storageMounts: (
          args.responseBody.storageManifest?.storageMounts ?? []
        ).filter((mount) => {
          return (
            !mount.name.startsWith("custom-skill@") &&
            !workflowMountPaths.has(mount.mountPath)
          );
        }),
      },
    };
  },
);

type FailedClaimTransitionResult = Exclude<
  ClaimTransitionResult,
  { readonly status: "claimed" }
>;

function claimTransitionErrorResponse(result: FailedClaimTransitionResult) {
  if (result.status === "agent-unavailable") {
    return notFound("Agent not found");
  }
  if (result.status === "bundle-unavailable") {
    throw new Error("Required content bundle is missing or invalid at claim");
  }
  if (result.status === "workflow-unavailable") {
    return notFound("Workflow is no longer available for this claim");
  }
  if (result.status === "job-not-found") {
    return notFound("Job not found in queue");
  }
  return notFound("Run not found");
}

const transitionClaimedJobToRunning$ = command(
  (
    { set },
    args: {
      readonly runId: string;
      readonly workflowInput: WorkflowClaimInput;
      readonly runnerAttribution: RunnerClaimAttribution | undefined;
      readonly timing: ClaimRouteTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<ClaimTransitionResult> => {
    const { runId, workflowInput, runnerAttribution, timing } = args;
    const db = set(writeDb$);
    return (async () => {
      const query = buildClaimTransitionSql(
        runId,
        {
          id: runnerAttribution?.runnerIdentity.runnerId ?? null,
          heartbeatGeneration:
            runnerAttribution?.runnerIdentity.heartbeatGeneration ?? null,
          hostname: runnerAttribution?.runnerHostname ?? null,
          version: runnerAttribution?.runnerVersion ?? null,
        },
        workflowInput,
      );
      const startedAt = now();
      const result = await (async () => {
        const rowSchema = claimTransitionSqlRowSchema;
        return await (async () => {
          return parseRawRows(rowSchema, await db.execute(query));
        })();
      })().finally(() => {
        timing.recordElapsed(
          "claim_route_transition_execute",
          "nested",
          startedAt,
        );
      });
      const transition = decodeClaimTransitionResult(result);
      signal.throwIfAborted();
      return transition;
    })();
  },
);

type PoisonJobResult =
  | {
      readonly status: "failed";
      readonly releasedSlots: readonly ReleasedRunSlot[];
    }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };
type FailedPoisonJobResult = Exclude<
  PoisonJobResult,
  { readonly status: "failed" }
>;

function poisonJobErrorResponse(result: FailedPoisonJobResult) {
  if (result.status === "job-not-found") {
    return notFound("Job not found in queue");
  }
  return notFound("Run not found");
}

type PreparedSecretValuesResult =
  | {
      readonly status: "resolved";
      readonly secretValues: string[] | null;
    }
  | {
      readonly status: "invalid-keys";
    };

function preparedSecretValuesForRunner(
  storedContext: StoredExecutionContext,
): PreparedSecretValuesResult {
  const keys = storedContext.secretValueEnvironmentKeys;
  if (keys === null) {
    return { status: "resolved", secretValues: null };
  }

  const environment = {
    ...storedContext.environment,
    ...storedContext.platformEnvironment,
  };
  const secretValues: string[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(environment, key)) {
      return { status: "invalid-keys" };
    }
    const value = environment[key];
    if (typeof value !== "string") {
      return { status: "invalid-keys" };
    }
    secretValues.push(value);
  }
  return { status: "resolved", secretValues };
}

async function secretValuesForRunner(
  storedContext: StoredExecutionContext,
  timing: ClaimRouteTimingCollector,
): Promise<string[] | null> {
  const prepared = preparedSecretValuesForRunner(storedContext);
  if (prepared.status === "resolved") {
    return prepared.secretValues;
  }

  return await timing.measureInvalidKeySecretMaterialization(async () => {
    const secretsMap = await decryptPersistentSecretsMap(
      storedContext.encryptedSecrets,
      {},
    );
    if (!secretsMap) {
      return null;
    }

    const envValues = new Set(
      Object.values({
        ...storedContext.environment,
        ...storedContext.platformEnvironment,
      }),
    );
    return Object.values(secretsMap).filter((value) => {
      return envValues.has(value);
    });
  });
}

const readClaimNetworkPolicyRefreshes$ = command(
  async (
    { get, set },
    args: {
      readonly run: ClaimedRun;
      readonly storedContext: StoredExecutionContext;
      readonly timing: ClaimRouteTimingCollector;
    },
  ): Promise<
    Pick<StoredExecutionContext, "networkPolicies" | "networkPolicyRefreshes">
  > => {
    const storedNetworkPolicies = args.storedContext.networkPolicies ?? {};
    assertClaimConnectorIdentity(args.run, args.storedContext);
    if (Object.keys(storedNetworkPolicies).length === 0) {
      return {
        networkPolicies: args.storedContext.networkPolicies,
        networkPolicyRefreshes: undefined,
      };
    }

    const builtinConnectorSlugs = [
      ...new Set(
        args.storedContext.connectorRuntimeTargets.flatMap((target) => {
          return target.kind === "builtin" ? [target.connectorSlug] : [];
        }),
      ),
    ];

    const startedAt = now();
    // Keep the whole finite read in the response owner's allSettled group.
    // Recording accepts captured timing facts, never a database/accessor closure.
    const result = await settle(
      (async (): Promise<{
        readonly value: Pick<
          StoredExecutionContext,
          "networkPolicies" | "networkPolicyRefreshes"
        >;
        readonly path: ClaimNetworkPolicyRefreshPath;
      }> => {
        if (builtinConnectorSlugs.length === 0) {
          return {
            value: {
              networkPolicies: args.storedContext.networkPolicies,
              networkPolicyRefreshes: undefined,
            },
            path: "no_builtin_targets",
          };
        }
        if (args.run.agentId === null) {
          throw new Error(
            "Connector network policy refresh requires an Agent identity",
          );
        }

        const scope = {
          orgId: args.run.orgId,
          userId: args.run.userId,
          agentId: args.run.agentId,
        };
        const plan = connectorRuntimeSlugSelectionReadPlan({
          connectorSlugs: builtinConnectorSlugs,
        });
        const rows = await get(db$)
          .select(plan.columns)
          .from(connectorCatalog)
          .leftJoin(connectorCatalogEntries, plan.join)
          .where(connectorCatalogCurrentWhere());
        const snapshot = connectorRuntimeSlugSelectionFromRows(
          plan.selection,
          rows,
        );
        const refreshes = await set(readActiveNetworkPolicyRefreshes$, {
          scope,
          connectorSlugs: builtinConnectorSlugs,
          snapshot,
        });

        return {
          value: {
            networkPolicies: mergeNetworkPolicyRefreshes(
              storedNetworkPolicies,
              refreshes,
            ),
            networkPolicyRefreshes: networkPolicyRefreshesRecord(refreshes),
          },
          path: "current_catalog",
        };
      })(),
    );
    const finishedAt = now();
    args.timing.recordNetworkPolicyRefresh(
      startedAt,
      finishedAt,
      result.ok ? result.value.path : undefined,
    );
    if (!result.ok) {
      throw result.error;
    }
    return result.value.value;
  },
);

function assertClaimConnectorIdentity(
  run: ClaimedRun,
  storedContext: StoredExecutionContext,
): void {
  if (
    run.agentId === null &&
    storedContext.connectorRuntimeTargets.length > 0
  ) {
    throw new Error(
      "Runs without an agent cannot use connector runtime targets",
    );
  }
}

function claimResponseBody(args: {
  readonly run: ClaimedRun;
  readonly reuseKey: string | null;
  readonly storedContext: StoredExecutionContext;
  readonly sandboxToken: string;
  readonly secretValues: ExecutionContext["secretValues"];
  readonly refreshedPolicies: Pick<
    StoredExecutionContext,
    "networkPolicies" | "networkPolicyRefreshes"
  >;
}): BaseClaimResponse {
  const {
    secretValueEnvironmentKeys: _secretValueEnvironmentKeys,
    customWorkflowSelection: _customWorkflowSelection,
    officialWorkflowBundles: _officialWorkflowBundles,
    storageMounts: _storedStorageMounts,
    ...runnerStoredContext
  } = args.storedContext;
  return {
    ...runnerStoredContext,
    ...(args.run.isFirstRun === null
      ? {}
      : { isFirstRun: args.run.isFirstRun }),
    runId: args.run.id,
    reuseKey: args.reuseKey,
    prompt: args.run.prompt,
    appendSystemPrompt: args.run.appendSystemPrompt,
    vars: mergeClaimVars({
      runVars: (args.run.vars as Record<string, string> | null) ?? null,
      connectorVars: args.storedContext.vars,
    }),
    storageManifest: {
      storageMounts: args.storedContext.storageMounts.map((storedMount) => {
        const { orgId: _orgId, userId: _userId, ...mount } = storedMount;
        return mount;
      }),
    },
    sandboxToken: args.sandboxToken,
    secretValues: args.secretValues,
    connectorRuntimeTargets: args.storedContext.connectorRuntimeTargets,
    networkPolicies: args.refreshedPolicies.networkPolicies,
    networkPolicyRefreshes: args.refreshedPolicies.networkPolicyRefreshes,
  };
}

const buildClaimResponseBodyForClaim$ = command(
  async (
    { set },
    args: {
      readonly run: ClaimedRun;
      readonly reuseKey: string | null;
      readonly storedContext: StoredExecutionContext;
      readonly timing: ClaimRouteTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<BaseClaimResponse> => {
    const secretValues = await secretValuesForRunner(
      args.storedContext,
      args.timing,
    );
    signal.throwIfAborted();
    const timing = args.timing;
    const startedAt = now();
    return await (async () => {
      const refreshedPolicies = await set(readClaimNetworkPolicyRefreshes$, {
        run: args.run,
        storedContext: args.storedContext,
        timing: args.timing,
      });
      signal.throwIfAborted();
      const sandboxToken = generateSandboxToken(
        args.run.userId,
        args.run.id,
        args.run.orgId,
      );
      signal.throwIfAborted();
      return claimResponseBody({
        run: args.run,
        reuseKey: args.reuseKey,
        storedContext: args.storedContext,
        sandboxToken,
        secretValues,
        refreshedPolicies,
      });
    })().finally(() => {
      timing.recordElapsed(
        "claim_route_response_assembly",
        "top_level",
        startedAt,
      );
    });
  },
);

interface ClaimTimingTelemetry {
  readonly discoverySource?: string;
  readonly jobDiscoveredToClaimRequestMs?: number;
  readonly localAdmissionToClaimRequestMs?: number;
  readonly directCandidateNotificationToEnqueueMs?: number;
  readonly directCandidateInboxWaitMs?: number;
  readonly providerDiscoveryToMainLoopMs?: number;
  readonly mainLoopToLocalAdmissionMs?: number;
  readonly pollDueToJobDiscoveredMs?: number;
  readonly pollHttpRequestMs?: number;
  readonly pollReason?: string;
  readonly runnerPreference?: RunnerPreference;
  readonly runnerPreferenceClaimState?: RunnerPreferenceClaimState;
}

type RunnerPreferenceTelemetryState = RunnerPreferenceClaimState | "absent";

interface SuccessfulClaimPreferenceTelemetry {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly claimState: RunnerPreferenceTelemetryState | undefined;
  readonly targetedSelf: boolean | undefined;
}

function successfulClaimPreferenceTelemetry(args: {
  readonly telemetry: ClaimTimingTelemetry | undefined;
  readonly runnerIdentity: RunnerClaimIdentity | undefined;
}): SuccessfulClaimPreferenceTelemetry {
  const preference = args.telemetry?.runnerPreference;
  if (!preference) {
    return {
      dimensions: {},
      claimState: undefined,
      targetedSelf: undefined,
    };
  }

  if (preference.kind === "noPreference") {
    return {
      dimensions: runnerPreferenceTelemetryDimensions(preference),
      claimState: "absent",
      targetedSelf: undefined,
    };
  }

  const claimState = args.telemetry?.runnerPreferenceClaimState;
  return {
    dimensions: runnerPreferenceTelemetryDimensions(preference),
    claimState,
    targetedSelf: args.runnerIdentity
      ? preference.runnerIdentity.runnerId.toLowerCase() ===
          args.runnerIdentity.runnerId.toLowerCase() &&
        preference.runnerIdentity.heartbeatGeneration ===
          args.runnerIdentity.heartbeatGeneration
      : undefined,
  };
}

function scheduleSuccessfulClaimSideEffects(args: {
  readonly jobWithRun: ClaimableJob;
  readonly authType: RunnerAuthContext["type"];
  readonly storedContext: StoredExecutionContext;
  readonly claimRequestStartedAtMs: number;
  readonly claimResult: ClaimedTransitionResult;
  readonly telemetry: ClaimTimingTelemetry | undefined;
  readonly runnerAttribution: RunnerClaimAttribution | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}): void {
  const { job, run } = args.jobWithRun;
  const queueCreatedAtMs = job.createdAt.getTime();
  const preferenceTelemetry = successfulClaimPreferenceTelemetry({
    telemetry: args.telemetry,
    runnerIdentity: args.runnerAttribution?.runnerIdentity,
  });
  scheduleClaimSucceededSideEffects({
    runId: run.id,
    runnerGroup: job.runnerGroup,
    profile: job.profile,
    authType: args.authType,
    apiToRunnerQueueMs: elapsedSinceApiStartMs(
      args.storedContext.apiStartTime,
      queueCreatedAtMs,
    ),
    runnerQueueToClaimRequestMs: Math.max(
      0,
      args.claimRequestStartedAtMs - queueCreatedAtMs,
    ),
    apiToClaimRequestMs: elapsedSinceApiStartMs(
      args.storedContext.apiStartTime,
      args.claimRequestStartedAtMs,
    ),
    apiToClaimMs: elapsedSinceApiStartMs(
      args.storedContext.apiStartTime,
      args.claimResult.claimedAt.getTime(),
    ),
    claimRequestToRunningMs: Math.max(
      0,
      // This historical state boundary ends at PostgreSQL's in-transaction
      // claimedAt, not at an application-clock route parent.
      args.claimResult.claimedAt.getTime() - args.claimRequestStartedAtMs,
    ),
    jobDiscoveredToClaimRequestMs:
      args.telemetry?.jobDiscoveredToClaimRequestMs,
    localAdmissionToClaimRequestMs:
      args.telemetry?.localAdmissionToClaimRequestMs,
    directCandidateNotificationToEnqueueMs:
      args.telemetry?.directCandidateNotificationToEnqueueMs,
    directCandidateInboxWaitMs: args.telemetry?.directCandidateInboxWaitMs,
    providerDiscoveryToMainLoopMs:
      args.telemetry?.providerDiscoveryToMainLoopMs,
    mainLoopToLocalAdmissionMs: args.telemetry?.mainLoopToLocalAdmissionMs,
    discoverySource: args.telemetry?.discoverySource,
    pollDueToJobDiscoveredMs: args.telemetry?.pollDueToJobDiscoveredMs,
    pollHttpRequestMs: args.telemetry?.pollHttpRequestMs,
    pollReason: args.telemetry?.pollReason,
    preferenceDimensions: preferenceTelemetry.dimensions,
    preferenceClaimState: preferenceTelemetry.claimState,
    preferenceTargetedSelf: preferenceTelemetry.targetedSelf,
    reuseKey: job.reuseKey,
    runnerAttribution: args.runnerAttribution,
    claimRouteTiming: args.claimRouteTiming,
  });
}

function scheduleClaimSucceededSideEffects(args: {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly apiToRunnerQueueMs: number | undefined;
  readonly runnerQueueToClaimRequestMs: number;
  readonly apiToClaimRequestMs: number | undefined;
  readonly apiToClaimMs: number | undefined;
  readonly claimRequestToRunningMs: number;
  readonly jobDiscoveredToClaimRequestMs: number | undefined;
  readonly localAdmissionToClaimRequestMs: number | undefined;
  readonly directCandidateNotificationToEnqueueMs: number | undefined;
  readonly directCandidateInboxWaitMs: number | undefined;
  readonly providerDiscoveryToMainLoopMs: number | undefined;
  readonly mainLoopToLocalAdmissionMs: number | undefined;
  readonly discoverySource: string | undefined;
  readonly pollDueToJobDiscoveredMs: number | undefined;
  readonly pollHttpRequestMs: number | undefined;
  readonly pollReason: string | undefined;
  readonly preferenceDimensions: Readonly<Record<string, string>>;
  readonly preferenceClaimState: RunnerPreferenceTelemetryState | undefined;
  readonly preferenceTargetedSelf: boolean | undefined;
  readonly reuseKey: string | null;
  readonly runnerAttribution: RunnerClaimAttribution | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}): void {
  waitUntil(
    tapError(recordClaimTimingMetrics(args), (error) => {
      L.warn("recordSandboxOperation failed", { runId: args.runId, error });
    }),
  );
}

interface ClaimTimingMetricArgs {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly apiToRunnerQueueMs: number | undefined;
  readonly runnerQueueToClaimRequestMs: number;
  readonly apiToClaimRequestMs: number | undefined;
  readonly apiToClaimMs: number | undefined;
  readonly claimRequestToRunningMs: number;
  readonly jobDiscoveredToClaimRequestMs: number | undefined;
  readonly localAdmissionToClaimRequestMs: number | undefined;
  readonly directCandidateNotificationToEnqueueMs: number | undefined;
  readonly directCandidateInboxWaitMs: number | undefined;
  readonly providerDiscoveryToMainLoopMs: number | undefined;
  readonly mainLoopToLocalAdmissionMs: number | undefined;
  readonly discoverySource: string | undefined;
  readonly pollDueToJobDiscoveredMs: number | undefined;
  readonly pollHttpRequestMs: number | undefined;
  readonly pollReason: string | undefined;
  readonly preferenceDimensions: Readonly<Record<string, string>>;
  readonly preferenceClaimState: RunnerPreferenceTelemetryState | undefined;
  readonly preferenceTargetedSelf: boolean | undefined;
  readonly reuseKey: string | null;
  readonly runnerAttribution: RunnerClaimAttribution | undefined;
  readonly claimRouteTiming: ClaimRouteTimingCollector;
}

type ClaimTimingMetricValueKey =
  | "apiToRunnerQueueMs"
  | "runnerQueueToClaimRequestMs"
  | "apiToClaimRequestMs"
  | "apiToClaimMs"
  | "claimRequestToRunningMs"
  | "jobDiscoveredToClaimRequestMs"
  | "localAdmissionToClaimRequestMs"
  | "directCandidateNotificationToEnqueueMs"
  | "directCandidateInboxWaitMs"
  | "providerDiscoveryToMainLoopMs"
  | "mainLoopToLocalAdmissionMs"
  | "pollDueToJobDiscoveredMs"
  | "pollHttpRequestMs";

const CLAIM_TIMING_METRIC_FIELDS = [
  { actionType: "api_to_runner_queue", valueKey: "apiToRunnerQueueMs" },
  {
    actionType: "runner_queue_to_claim_request",
    valueKey: "runnerQueueToClaimRequestMs",
  },
  { actionType: "api_to_claim_request", valueKey: "apiToClaimRequestMs" },
  { actionType: "api_to_claim", valueKey: "apiToClaimMs" },
  {
    actionType: "claim_request_to_running",
    valueKey: "claimRequestToRunningMs",
  },
  {
    actionType: "job_discovered_to_claim_request",
    valueKey: "jobDiscoveredToClaimRequestMs",
  },
  {
    actionType: "local_admission_to_claim_request",
    valueKey: "localAdmissionToClaimRequestMs",
  },
  {
    actionType: "direct_candidate_notification_to_enqueue",
    valueKey: "directCandidateNotificationToEnqueueMs",
  },
  {
    actionType: "direct_candidate_inbox_wait",
    valueKey: "directCandidateInboxWaitMs",
  },
  {
    actionType: "provider_discovery_to_main_loop",
    valueKey: "providerDiscoveryToMainLoopMs",
  },
  {
    actionType: "main_loop_to_local_admission",
    valueKey: "mainLoopToLocalAdmissionMs",
  },
  {
    actionType: "runner_poll_due_to_job_discovered",
    valueKey: "pollDueToJobDiscoveredMs",
  },
  { actionType: "runner_poll_http_request", valueKey: "pollHttpRequestMs" },
] as const satisfies readonly {
  readonly actionType: string;
  readonly valueKey: ClaimTimingMetricValueKey;
}[];

async function recordClaimTimingMetrics(
  args: ClaimTimingMetricArgs,
): Promise<void> {
  await Promise.resolve();
  const dimensions = claimTimingDimensions(args);
  recordSandboxOperations(claimTimingOperations(args, dimensions));
  args.claimRouteTiming.flush({
    runId: args.runId,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    authType: args.authType,
    discoverySource: args.discoverySource,
    pollReason: args.pollReason,
    runnerAttribution: args.runnerAttribution,
  });
}

function claimTimingDimensions(
  args: ClaimTimingMetricArgs,
): Record<string, string> {
  const dimensions: Record<string, string> = {
    runner_group: args.runnerGroup,
    profile: args.profile,
    auth_type: args.authType,
  };
  if (args.discoverySource) {
    dimensions.discovery_source = args.discoverySource;
  }
  if (args.pollReason) {
    dimensions.poll_reason = args.pollReason;
  }
  return dimensions;
}

function claimTimingOperations(
  args: ClaimTimingMetricArgs,
  dimensions: Record<string, string>,
): SandboxOperationAttrs[] {
  const successfulClaimDimensions = claimSuccessfulDimensions(args, dimensions);
  return CLAIM_TIMING_METRIC_FIELDS.map(({ actionType, valueKey }) => {
    return claimTimingOperation(
      args.runId,
      actionType,
      args[valueKey],
      actionType === "claim_request_to_running"
        ? successfulClaimDimensions
        : dimensions,
    );
  }).filter((operation): operation is SandboxOperationAttrs => {
    return operation !== undefined;
  });
}

function claimSuccessfulDimensions(
  args: ClaimTimingMetricArgs,
  dimensions: Record<string, string>,
): Record<string, string> {
  return {
    ...dimensions,
    ...runnerClaimAttributionDimensions(args.runnerAttribution),
    ...args.preferenceDimensions,
    ...(args.reuseKey === null ? {} : { reuse_key: args.reuseKey }),
    ...(args.preferenceClaimState
      ? { runner_preference_claim_state: args.preferenceClaimState }
      : {}),
    ...(args.preferenceTargetedSelf !== undefined
      ? {
          runner_preference_targeted_self: String(args.preferenceTargetedSelf),
        }
      : {}),
  };
}

function claimTimingOperation(
  runId: string,
  actionType: string,
  durationMs: number | undefined,
  dimensions: Record<string, string>,
): SandboxOperationAttrs | undefined {
  if (durationMs === undefined) {
    return undefined;
  }
  return {
    sandboxType: "runner",
    actionType,
    durationMs,
    success: true,
    runId,
    dimensions,
  };
}

const scheduleClaimFailedSideEffects$ = command(
  ({ set }, args: ClaimFailedSideEffectArgs, signal: AbortSignal): void => {
    set(scheduleReleasedSlotPicks$, args.releasedSlots, signal);
    waitUntil(
      tapError(
        set(
          dispatchCompleteSideEffects$,
          {
            kind: "terminal",
            firstTerminalTransition: true,
            runId: args.runId,
            orgId: args.orgId,
            status: "failed",
            error: args.error,
          },
          signal,
        ),
        (error) => {
          L.error("dispatchCompleteSideEffects failed", {
            runId: args.runId,
            error,
          });
        },
      ),
    );
  },
);

const failClaimForInvalidStoredExecutionContext$ = command(
  async function failClaimForInvalidStoredExecutionContext(
    { set },
    args: {
      readonly runId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) {
    const poisonResult = await set(
      commitFailedQueuedRun$,
      args.runId,
      INVALID_EXECUTION_CONTEXT_ERROR,
      signal,
    );
    if (poisonResult.status !== "failed") {
      return poisonJobErrorResponse(poisonResult);
    }
    set(
      scheduleClaimFailedSideEffects$,
      {
        runId: args.runId,
        orgId: args.orgId,
        error: INVALID_EXECUTION_CONTEXT_ERROR,
        releasedSlots: poisonResult.releasedSlots,
      },
      signal,
    );
    return badRequestMessage("Job missing execution context");
  },
);

const resolveStoredExecutionContextForClaim$ = command(
  async function resolveStoredExecutionContextForClaim(
    { set },
    args: {
      readonly runId: string;
      readonly orgId: string;
      readonly executionContext: unknown;
      readonly capabilities: RunnerClaimCapabilities;
      readonly timing: ClaimRouteTimingCollector;
    },
    signal: AbortSignal,
  ) {
    const contextParseStartedAt = now();
    const storedContextResult =
      claimCompatibleStoredExecutionContextSchema.safeParse(
        args.executionContext,
      );
    args.timing.recordElapsed(
      "claim_route_context_parse",
      "top_level",
      contextParseStartedAt,
    );
    signal.throwIfAborted();
    if (!storedContextResult.success) {
      warnInvalidStoredExecutionContext(
        args.runId,
        storedContextResult.error.issues,
      );
      return {
        compatible: false as const,
        response: await set(
          failClaimForInvalidStoredExecutionContext$,
          args,
          signal,
        ),
      };
    }
    const piModelConfigResolution = resolvePiModelConfigForClaim({
      cliAgentType: storedContextResult.data.cliAgentType,
      modelConfig: storedContextResult.data.piModelConfig,
      capabilities: args.capabilities,
    });
    if (piModelConfigResolution.status === "unsupported") {
      return {
        compatible: false as const,
        response: notFound("Job not found in queue"),
      };
    }
    if (piModelConfigResolution.status === "invalid") {
      warnInvalidStoredExecutionContext(
        args.runId,
        piModelConfigResolution.error.issues,
      );
      return {
        compatible: false as const,
        response: await set(
          failClaimForInvalidStoredExecutionContext$,
          args,
          signal,
        ),
      };
    }
    return {
      compatible: true as const,
      value: {
        ...storedContextResult.data,
        piModelConfig: piModelConfigResolution.modelConfig,
      },
    };
  },
);

const claimAuthorizedJob$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly authType: RunnerAuthContext["type"];
      readonly runnerAttribution: RunnerClaimAttribution | undefined;
      readonly capabilities: RunnerClaimCapabilities;
      readonly jobWithRun: ClaimableJob;
      readonly telemetry: ClaimTimingTelemetry | undefined;
      readonly claimRequestStartedAtMs: number;
      readonly claimRouteTiming: ClaimRouteTimingCollector;
    },
    signal: AbortSignal,
  ) => {
    const { runId, jobWithRun, claimRouteTiming } = args;
    const run = jobWithRun.run;

    const storedContextResult = await set(
      resolveStoredExecutionContextForClaim$,
      {
        runId,
        orgId: run.orgId,
        executionContext: jobWithRun.job.executionContext,
        capabilities: args.capabilities,
        timing: claimRouteTiming,
      },
      signal,
    );
    if (!storedContextResult.compatible) {
      return storedContextResult.response;
    }
    const storedContext = storedContextResult.value;
    const workflowInput = workflowClaimInput(storedContext, run.prompt);

    const baseResponseBody = await set(
      buildClaimResponseBodyForClaim$,
      {
        run,
        reuseKey: jobWithRun.job.reuseKey,
        storedContext,
        timing: claimRouteTiming,
      },
      signal,
    );
    signal.throwIfAborted();

    claimRouteTiming.recordElapsed(
      "claim_route_request_to_transition_start",
      "parent",
      args.claimRequestStartedAtMs,
    );
    const transitionStartedAt = now();
    const claimResult = await (async () => {
      return await set(
        transitionClaimedJobToRunning$,
        {
          runId,
          workflowInput,
          runnerAttribution: args.runnerAttribution,
          timing: claimRouteTiming,
        },
        signal,
      );
    })().finally(() => {
      claimRouteTiming.recordElapsed(
        "claim_route_transition_running",
        "top_level",
        transitionStartedAt,
      );
    });
    if (signal.aborted) {
      L.debug("Runner claim request aborted after committed transition", {
        runId,
      });
    }
    signal.throwIfAborted();
    if (claimResult.status !== "claimed") {
      return claimTransitionErrorResponse(claimResult);
    }

    const responseBody = await set(
      withClaimedContentBundles$,
      {
        responseBody: baseResponseBody,
        claim: claimResult,
        workflowInput,
        officialWorkflowBundles: storedContext.officialWorkflowBundles,
      },
      signal,
    );

    const response = {
      status: 200 as const,
      body: responseBody,
    };
    claimRouteTiming.recordElapsed(
      "claim_route_request_to_response_ready",
      "parent",
      args.claimRequestStartedAtMs,
    );
    scheduleSuccessfulClaimSideEffects({
      jobWithRun,
      authType: args.authType,
      storedContext,
      claimRequestStartedAtMs: args.claimRequestStartedAtMs,
      claimResult,
      telemetry: args.telemetry,
      runnerAttribution: args.runnerAttribution,
      claimRouteTiming,
    });

    return response;
  },
);

const claimInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const claimRequestStartedAtMs = now();
  const claimRouteTiming = new ClaimRouteTimingCollector();
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return unauthorizedNotAuthenticated;
  }

  const body = await get(claimBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (auth.type === "official-runner" && !body.data.runnerIdentity) {
    return badRequestMessage("Official runner claim requires runnerIdentity");
  }

  const runnerVersionResult = runnerClaimVersionHeaderSchema.safeParse(
    get(request$).header(CLIENT_VERSION_HEADER),
  );
  if (!runnerVersionResult.success) {
    return badRequestMessage("Invalid X-Client-Version header");
  }

  const runnerAttribution: RunnerClaimAttribution | undefined =
    auth.type === "official-runner" && body.data.runnerIdentity
      ? {
          runnerIdentity: body.data.runnerIdentity,
          runnerHostname: body.data.runnerHostname ?? null,
          runnerVersion: runnerVersionResult.data ?? null,
          installedVersions: body.data.installedVersions ?? null,
        }
      : undefined;

  const runId = get(pathParamsOf(runnersJobClaimContract.claim)).id;
  set(writeDb$);
  claimRouteTiming.recordElapsed(
    "claim_route_request_prepare",
    "top_level",
    claimRequestStartedAtMs,
  );

  const lookupAuthorizationStartedAt = now();
  const jobWithRun = await claimRouteTiming.measureLookup(async () => {
    return await set(getClaimableJob$, runId, signal);
  });
  signal.throwIfAborted();
  if (!isClaimableJob(jobWithRun)) {
    return jobWithRun;
  }
  const authError = claimAuthorizationError(auth, jobWithRun);
  claimRouteTiming.recordElapsed(
    "claim_route_lookup_authorization",
    "top_level",
    lookupAuthorizationStartedAt,
  );
  if (authError) {
    return authError;
  }

  const echoedPreference = body.data.telemetry?.runnerPreference;
  const runnerPreference =
    auth.type !== "official-runner" &&
    echoedPreference?.kind === "preference" &&
    echoedPreference.tier === "homeCache"
      ? undefined
      : echoedPreference;
  signal.throwIfAborted();

  return await set(
    claimAuthorizedJob$,
    {
      runId,
      authType: auth.type,
      runnerAttribution,
      capabilities: body.data.capabilities,
      jobWithRun,
      telemetry: body.data.telemetry
        ? { ...body.data.telemetry, runnerPreference }
        : undefined,
      claimRequestStartedAtMs,
      claimRouteTiming,
    },
    signal,
  );
});

const runnerRealtimeTokenBody$ = bodyResultOf(
  runnerRealtimeTokenContract.create,
);

const connectorRuntimeSyncInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(connectorRuntimeSyncBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const runId = get(
      pathParamsOf(runnersConnectorRuntimeSyncContract.sync),
    ).runId;
    set(writeDb$);
    const run = await set(getRunNetworkPolicyScope$, runId, signal);
    if (!run) {
      return notFound("Run not found");
    }

    const authError = runnerRunAuthorizationError(auth, run);
    if (run.status !== "running") {
      if (authError || !isTerminalRunStatus(run.status)) {
        return notFound("Run not found");
      }
      return {
        status: 409 as const,
        body: {
          error: {
            code: CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
            message: "Run is terminal",
          },
        },
      };
    }
    if (authError) {
      return authError;
    }

    const results = await set(resolveConnectorRuntimeTargets$, {
      scope: {
        orgId: run.orgId,
        userId: run.userId,
        agentId: run.agentId,
      },
      targets: body.data.targets,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { results },
    };
  },
);

const runnerRealtimeTokenInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(runnerRealtimeTokenBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const { group } = body.data;
    if (auth.type === "official-runner") {
      if (!isOfficialRunnerGroup(group)) {
        return forbidden("Official runners can only subscribe to vm0/* groups");
      }
    } else if (!isOfficialRunnerGroup(group)) {
      return forbidden("Only vm0/* runner groups are supported");
    }

    const tokenRequest = await createRunnerGroupRealtimeToken(group);
    signal.throwIfAborted();

    return { status: 200 as const, body: tokenRequest };
  },
);

const builtinFirewallsResolveInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }

    const body = await get(builtinFirewallsResolveBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const catalog = await get(connectorRunnerFirewallCatalog$);
    signal.throwIfAborted();
    const names =
      body.data.names === undefined ? undefined : [...new Set(body.data.names)];
    const missingNames = (names ?? []).filter((name) => {
      return !catalog.has(name);
    });
    if (missingNames.length > 0) {
      return badRequestMessage(
        `Unknown builtin firewall: ${missingNames.join(", ")}`,
      );
    }
    const firewalls = await catalog.load(names);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        catalogDigest: catalog.catalogDigest,
        catalogVersion: catalog.catalogVersion,
        firewalls,
      },
    };
  },
);

const steeredInputBody$ = bodyResultOf(runnersSteerContract.steered);

const nextSteerableInputInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { runId } = get(pathParamsOf(runnersSteerContract.next));
    if (auth.tokenType !== "sandbox" || auth.runId !== runId) {
      return forbidden("Steering is not available");
    }
    set(writeDb$);
    const result = await set(
      loadNextSteerableInput$,
      { runId, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    if (result.outcome === "forbidden") {
      return forbidden("Steering is not available");
    }
    return { status: 200 as const, body: { input: result.input } };
  },
);

const declareSteeredInputInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { runId, eventId } = get(pathParamsOf(runnersSteerContract.steered));
    if (auth.tokenType !== "sandbox" || auth.runId !== runId) {
      return forbidden("Steering is not available");
    }
    const body = await get(steeredInputBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      declareSteeredInput$,
      { runId, eventId, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    switch (result.outcome) {
      case "forbidden": {
        return forbidden("Steering is not available");
      }
      case "not_found": {
        return notFound("Steerable input not found");
      }
      case "conflict": {
        return {
          status: 409 as const,
          body: {
            error:
              result.reason === "run_not_running"
                ? {
                    code: STEERED_INPUT_RUN_NOT_RUNNING_ERROR_CODE,
                    message: "Run is not running",
                  }
                : {
                    code: STEERED_INPUT_ALREADY_CONSUMED_ERROR_CODE,
                    message: "Input was already consumed",
                  },
          },
        };
      }
      case "steered": {
        break;
      }
    }
    if (result.replacementsAppended) {
      await publishChatThreadMessageCreatedSafely({
        userId: auth.userId,
        orgId: auth.orgId,
        threadId: result.chatThreadId,
      });
      signal.throwIfAborted();
      await set(
        notifyRunningChatRunOfPendingInput$,
        result.chatThreadId,
        signal,
      );
      signal.throwIfAborted();
    }
    return { status: 200 as const, body: { outcome: "steered" as const } };
  },
);

const observeClaimJsonResponse: JsonResponseObserver = (
  context,
  observation,
) => {
  const runId = context.req.param("id");
  if (runId === undefined) {
    throw new Error("Validated claim route is missing run ID");
  }
  recordClaimResponseJsonSerialization({
    runId,
    byteLength: observation.byteLength,
    serializationDurationMs: observation.serializationDurationMs,
  });
};

export const runnersRoutes: readonly RouteEntry[] = [
  {
    route: runnersHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: runnersPollContract.poll,
    handler: pollInner$,
  },
  {
    route: runnersJobClaimContract.claim,
    handler: claimInner$,
    observeJsonResponse: observeClaimJsonResponse,
    streamJsonResponse: true,
  },
  {
    route: runnersSteerContract.next,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      nextSteerableInputInner$,
    ),
  },
  {
    route: runnersSteerContract.steered,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      declareSteeredInputInner$,
    ),
  },
  {
    route: runnersConnectorRuntimeSyncContract.sync,
    handler: connectorRuntimeSyncInner$,
  },
  {
    route: runnersBuiltinFirewallsResolveContract.resolve,
    handler: builtinFirewallsResolveInner$,
  },
  {
    route: runnerRealtimeTokenContract.create,
    handler: runnerRealtimeTokenInner$,
  },
];
