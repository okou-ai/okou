import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  prepareDeferredPiClaimAdmission,
  lockDeferredPiCatalog,
  validateDeferredPiMaterialization,
  DeferredPiAdmissionChangedError,
  type DeferredPiMaterializationAdmission,
} from "../services/agent-run-create.service";
import { getSandboxAuthForRun } from "./agent-webhook-auth";
import {
  PI_DEFERRED_SANDBOX_HEADER,
  type PiDeferredSandboxConfig,
  claimCompatibleStoredExecutionContextSchema,
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  elapsedSinceApiStartMs,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  runnersActiveInputsContract,
  runnersConnectorRuntimeSyncContract,
  runnersBuiltinFirewallsResolveContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersModelProviderFailuresContract,
  runnersPollContract,
  runnerVersionSchema,
  storedConnectorPermissionBaselineSchema,
  type ClaimCompatibleStoredExecutionContext,
  type ExecutionContext,
  type HeldSandboxState,
  type HeldWorkspaceState,
  type PiModelConfig,
  type RunnerPreference,
  type RunnerPreferenceClaimState,
  type RunnerClaimCapabilities,
  type SessionHistoryDownloadSource,
  type StoredConnectorPermissionBaseline,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  claimDeferredPiJob,
  releaseDeferredPiSandbox,
  readDeferredPiHandoffChunk,
  settleDeferredPiTerminal$,
} from "../services/pi-deferred-sandbox.service";
import {
  isPiInferenceRun,
  legacySandboxRunPredicate,
} from "../services/pi-inference-lifecycle.service";
import { agentRunInference } from "@okouai/db/schema/agent-run-inference";
import { readPiInferenceObject } from "../services/pi-inference-object.service";
import { piDeferredConfigurationSchema } from "../services/pi-deferred-sandbox-contract";
import { command } from "ccstate";
import { activePiMemoryPhase2MaintenanceRunCondition } from "../services/pi-memory-phase2-maintenance.service";
import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { blobs } from "@okouai/db/schema/blob";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import {
  runnerState,
  type RunnerHeldSandboxState as PersistedRunnerHeldSandboxState,
  type RunnerHeldWorkspaceState as PersistedRunnerHeldWorkspaceState,
} from "@okouai/db/schema/runner-state";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  exists,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { runnerAuth$, type RunnerAuthContext } from "../auth/runner-auth";
import { setResHeader$, authorization$, request$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$, type Db } from "../external/db";
import {
  generatePresignedGetUrl,
  publicS3DownloadSource,
  S3ObjectSizeLimitError,
  s3ObjectContentLength,
} from "../external/s3";
import {
  createRunnerGroupRealtimeToken,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { now, nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  prepareComputeRunAdmission,
  validateComputeRunAdmission,
  stopClosedComputeCandidate,
  withComputeOwnershipRetry,
  type ComputeRunOwner,
} from "../services/compute-erasure-admission.service";
import { logger } from "../../lib/log";
import { executeRawRows } from "../../lib/db-raw-rows";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { generateSandboxToken } from "../auth/tokens";
import { decryptPersistentSecretsMap } from "../services/crypto.utils";
import { transitionAgentRunsToTerminal } from "../services/agent-run-terminal-transition.service";
import { dispatchCompleteSideEffects$ } from "../services/agent-run-lifecycle.service";
import { historyGenerationRunIdForStoredExecutionContext } from "../services/agent-run-queue-payload.service";
import { resolvePiModelConfigForClaim } from "../services/pi-model-config-claim-capability";
import { reportBuiltInModelProviderFailure } from "../services/built-in-model-provider-failure.service";
import {
  recordActiveInputDeliveryReceipt,
  reserveActiveInputDelivery,
} from "../services/active-input-delivery.service";
import { notifyRunningChatRunOfPendingInput } from "../services/chat-thread-queue-drain.service";
import { loadConnectorRuntimeSnapshot } from "../services/connector-catalog-runtime.service";
import { loadConnectorRunnerFirewallCatalog } from "../services/connector-runner-firewall-catalog.service";
import { resolveConnectorRuntimeTargets } from "../services/connector-runtime-sync.service";
import {
  networkPolicyRefreshesRecord,
  mergeNetworkPolicyRefreshes,
  networkPolicyRefreshConnectorSlugs,
  resolveActiveNetworkPolicyRefreshes,
  resolveActiveNetworkPolicyRefreshesFromBaseline,
} from "../services/user-permission-grants.service";
import {
  type CompressedSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  resumeSessionHistoryRawBlobKey,
  SESSION_HISTORY_ENCODING_IDENTITY,
  tryNormalizeSessionHistoryBlobEncoding,
} from "../services/session-history-blobs";
import {
  runnerPreferenceTelemetryResolution,
  runnerPreferenceTelemetryDimensions,
  runnerReuseKeyTelemetryKind,
  runnerReusePreferenceLookupError,
  runnerReusePreferencePollPriority,
  resolveRunnerReusePreference,
  type RunnerPreferenceTelemetryResolution,
} from "../services/runner-reuse-preference";
import type { RouteEntry } from "../route-entry";
import { settle, tapError } from "../utils";

const L = logger("Runners");

type SandboxOperationAttrs = Parameters<
  typeof recordSandboxOperations
>[0][number];
type RunnerClaimIdentity = NonNullable<
  z.infer<(typeof runnersJobClaimContract.claim)["body"]>["runnerIdentity"]
>;
interface RunnerClaimAttribution {
  readonly runnerIdentity: RunnerClaimIdentity;
  readonly runnerHostname: string | null;
  readonly runnerVersion: string | null;
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
  };
}

const STALE_RUNNER_THRESHOLD_MS = 5 * 60 * 1000;
const INVALID_EXECUTION_CONTEXT_ERROR =
  "Runner job missing valid execution context";
const runnerClaimVersionHeaderSchema = runnerVersionSchema.optional();
const MAX_VALIDATION_ISSUES_TO_LOG = 10;
const RESUME_SESSION_HISTORY_LOAD_ERROR =
  "Runner job missing resume session history";
const RESUME_SESSION_HISTORY_INVALID_ERROR =
  "Runner job has invalid resume session history";

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
}

class ResumeSessionHistoryLoadError extends Error {
  constructor(
    readonly hash: string,
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "ResumeSessionHistoryLoadError";
  }
}

function isResumeSessionHistoryLoadError(
  error: unknown,
): error is ResumeSessionHistoryLoadError {
  return error instanceof ResumeSessionHistoryLoadError;
}

type ClaimRouteTimingSpanKind = "parent" | "top_level" | "nested";
type ClaimNetworkPolicyRefreshPath =
  | "baseline"
  | "baseline_empty"
  | "no_builtin_targets"
  | "full_missing_baseline"
  | "full_invalid_baseline"
  | "full_incompatible_baseline";
type ClaimRouteTimingActionType =
  | "claim_route_request_to_transition_start"
  | "claim_route_request_to_response_ready"
  | "claim_route_request_prepare"
  | "claim_route_lookup_authorization"
  | "claim_route_context_parse"
  | "claim_route_secret_materialization"
  | "claim_route_response_assembly"
  | "claim_route_response_network_policy_refresh"
  | "claim_route_response_network_policy_refresh_baseline_database"
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
}

class ClaimRouteTimingCollector {
  private readonly records: ClaimRouteTimingRecord[] = [];

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

  measure<T>(
    actionType: ClaimRouteTimingActionType,
    spanKind: ClaimRouteTimingSpanKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    return operation().finally(() => {
      this.recordElapsed(actionType, spanKind, startedAt);
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

  async measureNetworkPolicyRefresh<T>(
    operation: () => Promise<{
      readonly value: T;
      readonly path: ClaimNetworkPolicyRefreshPath;
    }>,
  ): Promise<T> {
    const startedAt = now();
    const result = await settle(operation());
    const finishedAt = now();
    this.records.push({
      actionType: "claim_route_response_network_policy_refresh",
      spanKind: "nested",
      durationMs: Math.max(0, finishedAt - startedAt),
      timestamp: new Date(finishedAt).toISOString(),
      ...(result.ok ? { policyRefreshPath: result.value.path } : {}),
    });
    if (!result.ok) {
      throw result.error;
    }
    return result.value.value;
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
        ...(state.reusableSandbox.historyGenerationRunId
          ? {
              historyGenerationRunId:
                state.reusableSandbox.historyGenerationRunId,
            }
          : {}),
      },
    };
  });
}

function canonicalizeHeldWorkspaceStates(
  states: readonly HeldWorkspaceState[],
): PersistedRunnerHeldWorkspaceState[] {
  return states.map((state) => {
    const [firstWorkspaceCache, ...remainingWorkspaceCaches] =
      state.workspaceCaches;
    if (!firstWorkspaceCache) {
      throw new Error("Held workspace state requires a workspace cache");
    }
    return {
      reuseKey: state.reuseKey,
      lastCompletedAt: new Date(state.lastCompletedAt).toISOString(),
      workspaceCaches: [
        {
          profile: firstWorkspaceCache.profile,
          workspaceAffinityVersion:
            firstWorkspaceCache.workspaceAffinityVersion,
        },
        ...remainingWorkspaceCaches.map((workspaceCache) => {
          return {
            profile: workspaceCache.profile,
            workspaceAffinityVersion: workspaceCache.workspaceAffinityVersion,
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
  const heldWorkspaceStates = canonicalizeHeldWorkspaceStates(
    body.data.heldWorkspaceStates,
  );
  const admittableProfiles = body.data.admittableProfiles;
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
      heldWorkspaceStates,
      mode: body.data.mode,
      lastSeenAt: currentDate,
    })
    .onConflictDoUpdate({
      target: runnerState.runnerId,
      set: {
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
        heldWorkspaceStates,
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
  readonly runnerGroup: string;
  readonly profile: string;
  readonly authType: RunnerAuthContext["type"];
  readonly pollReason: string | undefined;
  readonly runnerPreference: RunnerPreference;
  readonly reuseKeyKind: "thread" | "session" | "none";
  readonly historyGenerationRunId: string | undefined;
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
    reuse_key_kind: args.reuseKeyKind,
    ...runnerPreferenceTelemetryDimensions(args.runnerPreference),
  };
  if (args.pollReason) {
    dimensions.poll_reason = args.pollReason;
  }
  if (args.historyGenerationRunId) {
    dimensions.history_generation_run_id = args.historyGenerationRunId;
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

function runnerPollPriorityOrder(
  db: Pick<Db, "select">,
  args: {
    readonly runnerId: string | undefined;
    readonly runnerGroup: string;
    readonly currentDate: Date;
  },
): SQL[] {
  if (!args.runnerId) {
    return [];
  }
  return [
    desc(
      runnerReusePreferencePollPriority({
        db,
        runnerId: args.runnerId,
        runnerGroup: args.runnerGroup,
        currentDate: args.currentDate,
      }),
    ),
  ];
}

async function resolvePollRunnerReusePreference(
  db: Pick<Db, "select">,
  args: {
    readonly runId: string;
    readonly runnerGroup: string;
    readonly profile: string;
    readonly reuseKey: string | null;
    readonly historyGenerationRunId: string | undefined;
    readonly createdAt: Date;
    readonly currentDate: Date;
  },
) {
  const resolution = await tapError(
    resolveRunnerReusePreference({ db, ...args }),
    (error) => {
      L.warn("Failed to resolve runner reuse preference for poll response", {
        runId: args.runId,
        runnerGroup: args.runnerGroup,
        profile: args.profile,
        error,
      });
    },
  );
  return resolution ?? runnerReusePreferenceLookupError();
}

function pendingRunnerJobs(
  executor: Pick<Db, "select">,
  args: {
    readonly conditions: readonly SQL[];
    readonly priorityOrder: readonly SQL[];
    readonly currentDate: Date;
  },
) {
  return executor
    .select({
      runId: runnerJobQueue.runId,
      launchSnapshot: agentRuns.launchSnapshot,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      agentId: agentSessions.agentId,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      vars: agentRuns.vars,
      profile: runnerJobQueue.profile,
      cliAgentSessionId: runnerJobQueue.cliAgentSessionId,
      reuseKey: runnerJobQueue.reuseKey,
      historyGenerationRunId:
        sql`${runnerJobQueue.executionContext}->'resumeSession'->>'historyGenerationRunId'`.mapWith(
          nullableDriverValueDecoder(pgTextDecoder),
        ),
      createdAt: runnerJobQueue.createdAt,
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      and(
        ...args.conditions,
        or(
          isNotNull(agentSessions.agentId),
          exists(
            executor
              .select({ id: piMemoryPhase2Jobs.memoryStorageId })
              .from(piMemoryPhase2Jobs)
              .where(
                activePiMemoryPhase2MaintenanceRunCondition(executor, {
                  runId: agentRuns.id,
                  userId: agentRuns.userId,
                  orgId: agentRuns.orgId,
                  currentTime: args.currentDate,
                }),
              ),
          ),
        ),
      ),
    )
    .orderBy(
      ...args.priorityOrder,
      runnerJobQueue.createdAt,
      runnerJobQueue.runId,
    );
}

type PendingRunnerJob = Awaited<ReturnType<typeof pendingRunnerJobs>>[number];
async function capturedPollOwner(
  db: Db,
  candidate: PendingRunnerJob,
): Promise<ComputeRunOwner | undefined> {
  if (!isPiInferenceRun(candidate.launchSnapshot)) {
    return candidate;
  }
  const [inference] = await db
    .select({ input: agentRunInference.input })
    .from(agentRunInference)
    .where(eq(agentRunInference.runId, candidate.runId));
  if (!inference) {
    throw new Error("Deferred Pi poll lost its durable input");
  }
  const captured = await readPiInferenceObject(
    db,
    {
      ...candidate,
      kind: "configuration",
      hash: inference.input.configurationHash,
    },
    piDeferredConfigurationSchema,
  );
  if ((captured.body.agentId ?? null) !== candidate.agentId) {
    return undefined;
  }
  return { ...candidate, resourceOwner: captured.resourceOwner };
}

async function admitPendingRunnerJob(
  db: Db,
  candidates: readonly PendingRunnerJob[],
  whereConditions: SQL[],
  reusePreferencePriorityOrder: SQL[],
  currentDate: Date,
) {
  let pendingJob: PendingRunnerJob | undefined;
  for (const candidate of candidates) {
    const owner = await capturedPollOwner(db, candidate);
    if (!owner) {
      continue;
    }
    pendingJob = await withComputeOwnershipRetry(() => {
      return db.transaction(async (tx) => {
        const admission = await prepareComputeRunAdmission(
          tx,
          candidate.runId,
          owner,
        );
        if (!admission || !(await validateComputeRunAdmission(tx, admission))) {
          return undefined;
        }
        if (admission.closed) {
          await stopClosedComputeCandidate(tx, admission);
          return undefined;
        }
        const [job] = await pendingRunnerJobs(tx, {
          conditions: [
            ...whereConditions,
            eq(runnerJobQueue.runId, candidate.runId),
          ],
          priorityOrder: reusePreferencePriorityOrder,
          currentDate,
        })
          .for("share", { of: runnerJobQueue })
          .limit(1);
        return job;
      });
    });
    if (pendingJob) {
      break;
    }
  }
  return pendingJob;
}

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
  const deferredCapable =
    auth.type === "official-runner" &&
    get(request$).header(PI_DEFERRED_SANDBOX_HEADER) === "1";
  const whereConditions: SQL[] = [
    eq(runnerJobQueue.runnerGroup, group),
    gt(runnerJobQueue.expiresAt, sql`now()`),
    eq(agentRuns.status, "pending"),
  ];

  if (!deferredCapable) {
    whereConditions.push(sql`(${legacySandboxRunPredicate()})`);
  }
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
  const db = set(writeDb$);
  const pendingJobLookupStartedAtMs = now();
  const currentDate = nowDate();
  const reusePreferencePriorityOrder = runnerPollPriorityOrder(db, {
    runnerId: body.data.runnerId,
    runnerGroup: group,
    currentDate,
  });
  const candidates = await pendingRunnerJobs(db, {
    conditions: whereConditions,
    priorityOrder: reusePreferencePriorityOrder,
    currentDate,
  }).limit(8);
  signal.throwIfAborted();
  const pendingJob = await admitPendingRunnerJob(
    db,
    candidates,
    whereConditions,
    reusePreferencePriorityOrder,
    currentDate,
  );
  signal.throwIfAborted();
  const pendingJobLookupFinishedAtMs = now();

  if (!pendingJob) {
    return { status: 200 as const, body: { job: null } };
  }
  const runnerPreference = await resolvePollRunnerReusePreference(db, {
    runId: pendingJob.runId,
    runnerGroup: group,
    profile: pendingJob.profile,
    reuseKey: pendingJob.reuseKey,
    historyGenerationRunId: pendingJob.historyGenerationRunId ?? undefined,
    createdAt: pendingJob.createdAt,
    currentDate,
  });
  signal.throwIfAborted();
  recordPollTimingMetrics({
    runId: pendingJob.runId,
    runnerGroup: group,
    profile: pendingJob.profile,
    authType: auth.type,
    pollReason: body.data.telemetry?.pollReason,
    runnerPreference,
    reuseKeyKind: runnerReuseKeyTelemetryKind(pendingJob.reuseKey),
    historyGenerationRunId: pendingJob.historyGenerationRunId ?? undefined,
    queueCreatedAtMs: pendingJob.createdAt.getTime(),
    pollRequestStartedAtMs,
    pendingJobLookupStartedAtMs,
    pendingJobLookupFinishedAtMs,
    pollResponseAtMs: now(),
  });

  if (isPiInferenceRun(pendingJob.launchSnapshot)) {
    set(setResHeader$, PI_DEFERRED_SANDBOX_HEADER, "1");
  }
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
        historyGenerationRunId: pendingJob.historyGenerationRunId ?? undefined,
        runnerPreference,
      },
    },
  };
});

const claimBody$ = bodyResultOf(runnersJobClaimContract.claim);
const modelProviderFailureBody$ = bodyResultOf(
  runnersModelProviderFailuresContract.report,
);
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
  readonly deferredAdmission?: DeferredPiMaterializationAdmission;
}

interface ClaimedRun {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string | null;
  readonly resourceOwner?: ComputeRunOwner["resourceOwner"];
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly vars: unknown;
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

async function getRunNetworkPolicyScope(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<RunNetworkPolicyScope | undefined> {
  const [row] = await db
    .select({
      runId: agentRuns.id,
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      agentId: agents.id,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return row
    ? {
        ...row,
        status: runStatusSchema.parse(row.status),
      }
    : undefined;
}

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

async function getClaimableJob(
  db: Db,
  runId: string,
  signal: AbortSignal,
  deferredCapable: boolean,
): Promise<ClaimLookupResult> {
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
        agentId: agentSessions.agentId,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        vars: agentRuns.vars,
      },
      maintenanceRunId: piMemoryPhase2Jobs.maintenanceRunId,
      resourceOwner: { userId: agents.owner, orgId: agents.orgId },
      inferenceInput: agentRunInference.input,
    })
    .from(runnerJobQueue)
    .innerJoin(agentRuns, eq(runnerJobQueue.runId, agentRuns.id))
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(agentRunInference, eq(agentRunInference.runId, agentRuns.id))
    .leftJoin(agents, eq(agents.id, agentSessions.agentId))
    .leftJoin(
      piMemoryPhase2Jobs,
      and(
        eq(piMemoryPhase2Jobs.maintenanceRunId, agentRuns.id),
        eq(piMemoryPhase2Jobs.orgId, agentRuns.orgId),
        eq(piMemoryPhase2Jobs.userId, agentRuns.userId),
        eq(piMemoryPhase2Jobs.status, "leased"),
      ),
    )
    .where(
      and(
        eq(runnerJobQueue.runId, runId),
        deferredCapable ? undefined : sql`(${legacySandboxRunPredicate()})`,
        gt(runnerJobQueue.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (
    jobWithRun &&
    (jobWithRun.run.agentId !== null || jobWithRun.maintenanceRunId === runId)
  ) {
    const captured = jobWithRun.inferenceInput
      ? await readPiInferenceObject(
          db,
          {
            runId,
            ...jobWithRun.run,
            kind: "configuration",
            hash: jobWithRun.inferenceInput.configurationHash,
          },
          piDeferredConfigurationSchema,
        )
      : undefined;
    return {
      job: jobWithRun.job,
      deferredAdmission: captured
        ? await prepareDeferredPiClaimAdmission(
            db,
            jobWithRun.run,
            captured,
            signal,
          )
        : undefined,
      run: {
        ...jobWithRun.run,
        resourceOwner:
          captured?.resourceOwner ?? jobWithRun.resourceOwner ?? undefined,
      },
    };
  }
  return notFound("Job not found in queue");
}

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
  return isOfficialRunnerGroup(jobWithRun.job.runnerGroup)
    ? null
    : forbidden("Only vm0/* runner groups are supported");
}

type ClaimTransitionResult =
  | { readonly status: "claimed"; readonly claimedAt: Date }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };
type ClaimedTransitionResult = Extract<
  ClaimTransitionResult,
  { readonly status: "claimed" }
>;
type FailedClaimTransitionResult = Exclude<
  ClaimTransitionResult,
  { readonly status: "claimed" }
>;

function claimTransitionErrorResponse(result: FailedClaimTransitionResult) {
  if (result.status === "job-not-found") {
    return notFound("Job not found in queue");
  }
  return notFound("Run not found");
}

const claimTransitionSqlRowSchema = z.object({
  status: z.enum([
    "claimed",
    "job-not-found",
    "run-not-found",
    "invariant-error",
  ]),
  claimedAtMs: z.number().nullable(),
});

function decodeClaimTransitionResult(
  rows: readonly z.infer<typeof claimTransitionSqlRowSchema>[],
): ClaimTransitionResult {
  const row = rows[0];
  if (!row || row.status === "invariant-error") {
    throw new Error("Runner job claim transition violated its invariant");
  }
  if (row.status === "claimed") {
    if (row.claimedAtMs === null) {
      throw new Error("Claimed runner job is missing its transition time");
    }
    return { status: "claimed", claimedAt: new Date(row.claimedAtMs) };
  }
  return { status: row.status };
}

async function lockClaimRun(
  db: Pick<Db, "select">,
  runId: string,
): Promise<{ readonly id: string; readonly status: string } | undefined> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  return run;
}

async function lockRunnerJob(
  db: Pick<Db, "select">,
  runId: string,
): Promise<
  { readonly runId: string; readonly isExpired: boolean } | undefined
> {
  const [row] = await db
    .select({
      runId: runnerJobQueue.runId,
      isExpired: lte(runnerJobQueue.expiresAt, sql`now()`).mapWith(
        pgBooleanDecoder,
      ),
    })
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, runId))
    .for("update");
  return row;
}

function buildClaimTransitionSql(
  runId: string,
  runnerId: string | null,
  runnerHeartbeatGeneration: number | null,
  runnerHostname: string | null,
  runnerVersion: string | null,
): SQL {
  // Materialized outputs make the row locks depend on run, then queue.
  return sql`
          WITH locked_run AS MATERIALIZED (
            SELECT
              ${agentRuns.id} AS "id",
              ${agentRuns.status} AS "status"
            FROM ${agentRuns}
            WHERE ${eq(agentRuns.id, runId)}
              AND ${agentRuns.triggerSource} IS DISTINCT FROM 'goal'
              AND (${legacySandboxRunPredicate()})
            FOR UPDATE
          ),
          locked_job AS MATERIALIZED (
            SELECT
              ${runnerJobQueue.runId} AS "runId",
              ${lte(runnerJobQueue.expiresAt, sql`now()`)} AS "isExpired"
            FROM ${runnerJobQueue}
            INNER JOIN locked_run
              ON locked_run."id" = ${runnerJobQueue.runId}
            FOR UPDATE OF ${runnerJobQueue}
          ),
          claim_clock AS MATERIALIZED (
            SELECT
              date_trunc(
                'milliseconds',
                clock_timestamp() AT TIME ZONE 'UTC'
              ) AS "claimedAt"
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            WHERE
              locked_run."status" = 'pending'
              AND NOT locked_job."isExpired"
          ),
          updated_run AS (
            UPDATE ${agentRuns}
            SET
              status = 'running',
              started_at = claim_clock."claimedAt",
              last_heartbeat_at = claim_clock."claimedAt",
              cancellation_recovery_completed = false,
              runner_id = ${runnerId},
              runner_heartbeat_generation = ${runnerHeartbeatGeneration},
              runner_hostname = ${runnerHostname},
              runner_version = ${runnerVersion}
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            CROSS JOIN claim_clock
            WHERE ${and(
              eq(agentRuns.id, sql`locked_run."id"`),
              eq(agentRuns.status, sql`'pending'`),
            )}
            RETURNING ${agentRuns.id} AS "id", ${agentRuns.startedAt} AS "claimedAt"
          ),
          deleted_job AS (
            DELETE FROM ${runnerJobQueue}
            USING locked_run, locked_job
            WHERE ${and(
              eq(runnerJobQueue.runId, sql`locked_job."runId"`),
              sql`locked_job."runId" = locked_run."id"`,
              sql`(
                locked_run."status" <> 'pending'
                OR EXISTS (
                  SELECT 1
                  FROM updated_run
                  WHERE updated_run."id" = locked_run."id"
                )
              )`,
            )}
            RETURNING ${runnerJobQueue.runId} AS "runId"
          )
          SELECT
            CASE
              WHEN NOT EXISTS (SELECT 1 FROM locked_run)
                THEN 'run-not-found'
              WHEN EXISTS (
                SELECT 1
                FROM locked_run
                WHERE locked_run."status" <> 'pending'
              )
                THEN 'run-not-found'
              WHEN NOT EXISTS (SELECT 1 FROM locked_job)
                OR EXISTS (
                  SELECT 1
                  FROM locked_job
                  WHERE locked_job."isExpired"
                )
                THEN 'job-not-found'
              WHEN EXISTS (SELECT 1 FROM updated_run)
                AND EXISTS (SELECT 1 FROM deleted_job)
                THEN 'claimed'
              ELSE 'invariant-error'
            END AS "status",
            (
              SELECT
                (
                  EXTRACT(EPOCH FROM updated_run."claimedAt") * 1000
                )::double precision
              FROM updated_run
            ) AS "claimedAtMs"
          `;
}

async function transitionClaimedJobToRunning(
  db: Db,
  args: {
    readonly runId: string;
    readonly owner: ComputeRunOwner;
    readonly deferred?: PiDeferredSandboxConfig;
    readonly deferredAdmission?: DeferredPiMaterializationAdmission;
  },
  runnerAttribution: RunnerClaimAttribution | undefined,
  signal: AbortSignal,
  timing: ClaimRouteTimingCollector,
): Promise<ClaimTransitionResult> {
  const { runId, owner } = args;
  const query = buildClaimTransitionSql(
    runId,
    runnerAttribution?.runnerIdentity.runnerId ?? null,
    runnerAttribution?.runnerIdentity.heartbeatGeneration ?? null,
    runnerAttribution?.runnerHostname ?? null,
    runnerAttribution?.runnerVersion ?? null,
  );
  return await withComputeOwnershipRetry(() => {
    return db.transaction(async (tx) => {
      const admission = await prepareComputeRunAdmission(tx, runId, owner);
      if (args.deferred && admission) {
        if (!args.deferredAdmission) {
          return { status: "run-not-found" as const };
        }
        await lockDeferredPiCatalog(tx, args.deferredAdmission);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${owner.orgId}))`,
        );
        await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            inArray(
              chatThreads.id,
              tx
                .select({ id: agentRuns.chatThreadId })
                .from(agentRuns)
                .where(eq(agentRuns.id, runId)),
            ),
          )
          .orderBy(chatThreads.id)
          .for("update");
      }
      if (!admission || !(await validateComputeRunAdmission(tx, admission))) {
        return { status: "run-not-found" as const };
      }
      if (admission.closed) {
        await stopClosedComputeCandidate(tx, admission);
        return { status: "run-not-found" as const };
      }
      if (args.deferred) {
        if (!runnerAttribution) {
          return { status: "run-not-found" as const };
        }
        if (!args.deferredAdmission) {
          return { status: "run-not-found" as const };
        }
        const [current] = await tx
          .select({
            sessionId: agentRuns.sessionId,
            storageMounts: agentRuns.storageMounts,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId));
        if (!current) {
          return { status: "run-not-found" as const };
        }
        const validation = await settle(
          validateDeferredPiMaterialization(tx, {
            admission: args.deferredAdmission,
            run: { ...owner, sessionId: current.sessionId },
            mounts: current.storageMounts ?? [],
          }),
          signal,
        );
        if (!validation.ok) {
          if (validation.error instanceof DeferredPiAdmissionChangedError) {
            return { status: "run-not-found" as const };
          }
          throw validation.error;
        }
        const claimedAt = await claimDeferredPiJob(tx, {
          runId,
          fence: args.deferred,
          runnerId: runnerAttribution.runnerIdentity.runnerId,
          heartbeatGeneration:
            runnerAttribution.runnerIdentity.heartbeatGeneration,
          runnerHostname: runnerAttribution.runnerHostname ?? null,
          runnerVersion: runnerAttribution.runnerVersion ?? null,
        });
        return claimedAt
          ? { status: "claimed" as const, claimedAt }
          : { status: "job-not-found" as const };
      }
      const result = await timing.measure(
        "claim_route_transition_execute",
        "nested",
        async () => {
          return await executeRawRows(tx, query, claimTransitionSqlRowSchema);
        },
      );
      signal.throwIfAborted();
      return decodeClaimTransitionResult(result);
    });
  });
}

type PoisonJobResult =
  | { readonly status: "failed" }
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

async function failPoisonQueuedJob(
  db: Db,
  runId: string,
  owner: ComputeRunOwner,
  errorMessage: string,
  signal: AbortSignal,
): Promise<PoisonJobResult> {
  return await withComputeOwnershipRetry(() => {
    return db.transaction(async (tx) => {
      const admission = await prepareComputeRunAdmission(tx, runId, owner);
      if (!admission || !(await validateComputeRunAdmission(tx, admission))) {
        return { status: "run-not-found" as const };
      }
      if (admission.closed) {
        await stopClosedComputeCandidate(tx, admission);
        return { status: "run-not-found" as const };
      }
      const run = await lockClaimRun(tx, runId);
      signal.throwIfAborted();
      if (!run) {
        return { status: "run-not-found" };
      }
      if (run.status !== "pending") {
        await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
        signal.throwIfAborted();
        return { status: "run-not-found" };
      }

      const job = await lockRunnerJob(tx, runId);
      signal.throwIfAborted();
      if (!job || job.isExpired) {
        return { status: "job-not-found" };
      }

      const failedAt = nowDate();
      const [updatedRun] = await transitionAgentRunsToTerminal(tx, {
        values: {
          status: "failed",
          completedAt: failedAt,
          error: errorMessage,
        },
        conditions: [eq(agentRuns.id, runId), eq(agentRuns.status, "pending")],
      });
      signal.throwIfAborted();
      if (!updatedRun) {
        throw new Error("Locked pending run was not failed");
      }

      await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, runId));
      signal.throwIfAborted();

      return { status: "failed" as const };
    });
  });
}

type PreparedSecretValuesResult =
  | {
      readonly status: "resolved";
      readonly secretValues: string[] | null;
    }
  | {
      readonly status: "invalid-keys";
    };

type ConnectorPermissionBaselineRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "valid";
      readonly value: StoredConnectorPermissionBaseline;
    };

type DecodableCompatibleStoredExecutionContext = Omit<
  ClaimCompatibleStoredExecutionContext,
  "piModelConfig"
> & {
  readonly piModelConfig?: PiModelConfig;
};

function decodeCompatibleStoredExecutionContext(
  context: DecodableCompatibleStoredExecutionContext,
): {
  readonly context: StoredExecutionContext;
  readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
} {
  const {
    connectorPermissionBaseline: rawConnectorPermissionBaseline,
    ...contextWithoutConnectorPermissionBaseline
  } = context;
  if (rawConnectorPermissionBaseline === undefined) {
    return {
      context: contextWithoutConnectorPermissionBaseline,
      connectorPermissionBaseline: { kind: "missing" },
    };
  }
  const baselineResult = storedConnectorPermissionBaselineSchema.safeParse(
    rawConnectorPermissionBaseline,
  );
  if (!baselineResult.success) {
    return {
      context: contextWithoutConnectorPermissionBaseline,
      connectorPermissionBaseline: { kind: "invalid" },
    };
  }
  return {
    context: {
      ...contextWithoutConnectorPermissionBaseline,
      connectorPermissionBaseline: baselineResult.data,
    },
    connectorPermissionBaseline: {
      kind: "valid",
      value: baselineResult.data,
    },
  };
}

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

function connectorPermissionBaselineMatchesStoredContext(
  storedContext: StoredExecutionContext,
  baseline: StoredConnectorPermissionBaseline,
): boolean {
  const baselineConnectorSlugs = Object.keys(baseline.connectors);
  const storedBuiltinConnectorSlugs = new Set(
    storedContext.connectorRuntimeTargets.flatMap((target) => {
      return target.kind === "builtin" ? [target.connectorSlug] : [];
    }),
  );
  const storedNetworkPolicies = storedContext.networkPolicies ?? {};
  return (
    baselineConnectorSlugs.length === storedBuiltinConnectorSlugs.size &&
    baselineConnectorSlugs.every((connectorSlug) => {
      return (
        storedBuiltinConnectorSlugs.has(connectorSlug) &&
        Object.hasOwn(storedNetworkPolicies, connectorSlug)
      );
    })
  );
}

async function refreshClaimNetworkPolicies(args: {
  readonly db: Db;
  readonly run: ClaimedRun;
  readonly storedContext: StoredExecutionContext;
  readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
  readonly timing: ClaimRouteTimingCollector;
}): Promise<
  Pick<StoredExecutionContext, "networkPolicies" | "networkPolicyRefreshes">
> {
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

  return await args.timing.measureNetworkPolicyRefresh(async () => {
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
    const fullRefresh = async (
      path: Extract<ClaimNetworkPolicyRefreshPath, `full_${string}`>,
    ) => {
      const connectorCatalogSnapshot = await loadConnectorRuntimeSnapshot(
        args.db,
      );
      const connectorSlugs = networkPolicyRefreshConnectorSlugs(
        connectorCatalogSnapshot.serverFirewalls,
        builtinConnectorSlugs,
      );
      const refreshes =
        connectorSlugs.length === 0
          ? []
          : await resolveActiveNetworkPolicyRefreshes(
              args.db,
              scope,
              connectorSlugs,
              connectorCatalogSnapshot,
            );
      return { refreshes, path };
    };

    const selectRefresh = async () => {
      if (args.connectorPermissionBaseline.kind === "missing") {
        return await fullRefresh("full_missing_baseline");
      }
      if (args.connectorPermissionBaseline.kind === "invalid") {
        return await fullRefresh("full_invalid_baseline");
      }
      const baseline = args.connectorPermissionBaseline.value;
      if (
        !connectorPermissionBaselineMatchesStoredContext(
          args.storedContext,
          baseline,
        )
      ) {
        return await fullRefresh("full_invalid_baseline");
      }
      const resolution = await resolveActiveNetworkPolicyRefreshesFromBaseline(
        args.db,
        scope,
        baseline,
        async <T>(operation: () => Promise<T>): Promise<T> => {
          return await args.timing.measure(
            "claim_route_response_network_policy_refresh_baseline_database",
            "nested",
            operation,
          );
        },
      );
      if (resolution.kind === "incompatible") {
        return await fullRefresh("full_incompatible_baseline");
      }
      if (resolution.kind === "empty") {
        return {
          refreshes: resolution.refreshes,
          path: "baseline_empty" as const,
        };
      }
      return {
        refreshes: resolution.refreshes,
        path: "baseline" as const,
      };
    };
    const selected = await selectRefresh();

    return {
      value: {
        networkPolicies: mergeNetworkPolicyRefreshes(
          storedNetworkPolicies,
          selected.refreshes,
        ),
        networkPolicyRefreshes: networkPolicyRefreshesRecord(
          selected.refreshes,
        ),
      },
      path: selected.path,
    };
  });
}

function assertClaimConnectorIdentity(
  run: ClaimedRun,
  storedContext: StoredExecutionContext,
): void {
  if (
    run.agentId === null &&
    storedContext.connectorRuntimeTargets.length > 0
  ) {
    throw new Error(
      "Private Pi memory maintenance run cannot use connector runtime targets",
    );
  }
}

type StoredResumeSessionWithHistoryRef = Extract<
  NonNullable<StoredExecutionContext["resumeSession"]>,
  { historyRef: { kind: "blob"; hash: string } }
>;

interface CompressedResumeSessionHistoryRepresentation {
  readonly encoding: CompressedSessionHistoryBlobEncoding;
  readonly rawSize: number;
  readonly encodedSize: number;
  readonly objectKey: string;
  readonly downloadSource: SessionHistoryDownloadSource;
}

interface IdentityResumeSessionHistoryRepresentation {
  readonly encoding: typeof SESSION_HISTORY_ENCODING_IDENTITY;
  readonly rawSize: number;
  readonly encodedSize: number;
  readonly downloadSource: SessionHistoryDownloadSource;
}

function hasResumeSessionHistoryRef(
  resumeSession: StoredExecutionContext["resumeSession"],
): resumeSession is StoredResumeSessionWithHistoryRef {
  return resumeSession !== null && "historyRef" in resumeSession;
}

function invalidResumeSessionHistoryError(
  hash: string,
  cause: unknown,
): ResumeSessionHistoryLoadError {
  return new ResumeSessionHistoryLoadError(
    hash,
    RESUME_SESSION_HISTORY_INVALID_ERROR,
    cause,
  );
}

const generateResumeSessionHistoryUrl$ = command(
  async ({ get }, hash: string): Promise<string> => {
    return await get(
      generatePresignedGetUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        resumeSessionHistoryRawBlobKey(hash),
        undefined,
        true,
      ),
    );
  },
);

const generateResumeSessionHistoryObjectUrl$ = command(
  async ({ get }, objectKey: string): Promise<string> => {
    return await get(
      generatePresignedGetUrl(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        objectKey,
        undefined,
        true,
      ),
    );
  },
);

const loadCompressedResumeSessionHistoryRepresentation$ = command(
  async (
    _,
    args: {
      readonly db: Db;
      readonly encoding: CompressedSessionHistoryBlobEncoding;
      readonly hash: string;
    },
  ): Promise<CompressedResumeSessionHistoryRepresentation | undefined> => {
    const [blob] = await args.db
      .select({
        rawSize: blobs.rawSize,
        encoding: blobs.encoding,
        encodedSize: blobs.encodedSize,
      })
      .from(blobs)
      .where(eq(blobs.hash, args.hash))
      .limit(1);
    if (!blob) {
      return undefined;
    }
    const encoding = tryNormalizeSessionHistoryBlobEncoding(blob.encoding);
    if (encoding === undefined) {
      throw invalidResumeSessionHistoryError(
        args.hash,
        new Error(`invalid session history blob encoding: ${blob.encoding}`),
      );
    }
    if (encoding !== args.encoding) {
      return undefined;
    }
    if (blob.rawSize <= 0 || blob.encodedSize <= 0) {
      return undefined;
    }

    return {
      encoding,
      rawSize: blob.rawSize,
      encodedSize: blob.encodedSize,
      objectKey: resumeSessionHistoryBlobKey(args.hash, encoding),
      downloadSource: publicS3DownloadSource(),
    };
  },
);

function validateCompressedResumeSessionHistoryRepresentation(
  hash: string,
  representation: CompressedResumeSessionHistoryRepresentation,
): void {
  if (
    representation.rawSize <= 0 ||
    representation.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    representation.encodedSize <= 0 ||
    representation.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    throw invalidResumeSessionHistoryError(
      hash,
      new Error(
        `invalid ${representation.encoding} rawSize: ${representation.rawSize}`,
      ),
    );
  }
}

const loadIdentityResumeSessionHistoryRepresentation$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly hash: string;
    },
  ): Promise<IdentityResumeSessionHistoryRepresentation | undefined> => {
    const [blob] = await args.db
      .select({
        rawSize: blobs.rawSize,
        encoding: blobs.encoding,
        encodedSize: blobs.encodedSize,
      })
      .from(blobs)
      .where(eq(blobs.hash, args.hash))
      .limit(1);
    if (!blob) {
      return undefined;
    }
    const encoding = tryNormalizeSessionHistoryBlobEncoding(blob.encoding);
    if (encoding === undefined) {
      throw invalidResumeSessionHistoryError(
        args.hash,
        new Error(`invalid session history blob encoding: ${blob.encoding}`),
      );
    }
    if (encoding !== SESSION_HISTORY_ENCODING_IDENTITY) {
      return undefined;
    }

    let rawSize = blob.rawSize;
    let encodedSize = blob.encodedSize;
    if (rawSize <= 0 || encodedSize <= 0) {
      const objectKey = resumeSessionHistoryRawBlobKey(args.hash);
      const contentLengthResult = await settle(
        get(
          s3ObjectContentLength(
            env("R2_USER_STORAGES_BUCKET_NAME"),
            objectKey,
            RESUME_SESSION_HISTORY_MAX_BYTES,
          ),
        ),
      );
      if (!contentLengthResult.ok) {
        if (contentLengthResult.error instanceof S3ObjectSizeLimitError) {
          throw invalidResumeSessionHistoryError(
            args.hash,
            contentLengthResult.error,
          );
        }
        throw contentLengthResult.error;
      }
      const contentLength = contentLengthResult.value;
      if (contentLength === undefined || contentLength <= 0) {
        return undefined;
      }
      const [updatedBlob] = await args.db
        .update(blobs)
        .set({
          rawSize: contentLength,
          encoding: SESSION_HISTORY_ENCODING_IDENTITY,
          encodedSize: contentLength,
        })
        .where(and(eq(blobs.hash, args.hash), eq(blobs.rawSize, 0)))
        .returning({
          rawSize: blobs.rawSize,
          encodedSize: blobs.encodedSize,
        });
      rawSize = updatedBlob?.rawSize ?? contentLength;
      encodedSize = updatedBlob?.encodedSize ?? contentLength;
    }
    if (rawSize !== encodedSize) {
      throw invalidResumeSessionHistoryError(
        args.hash,
        new Error(
          `identity session history rawSize must match encodedSize: rawSize=${rawSize}, encodedSize=${encodedSize}`,
        ),
      );
    }

    return {
      encoding: SESSION_HISTORY_ENCODING_IDENTITY,
      rawSize,
      encodedSize,
      downloadSource: publicS3DownloadSource(),
    };
  },
);

async function resolveResumeSessionForClaim(args: {
  readonly resumeSession: StoredExecutionContext["resumeSession"];
  readonly timing: ClaimRouteTimingCollector;
  readonly loadIdentityRepresentation: (
    hash: string,
  ) => Promise<IdentityResumeSessionHistoryRepresentation | undefined>;
  readonly loadCompressedRepresentation: (
    hash: string,
    encoding: CompressedSessionHistoryBlobEncoding,
  ) => Promise<CompressedResumeSessionHistoryRepresentation | undefined>;
  readonly generateResumeSessionHistoryUrl: (hash: string) => Promise<string>;
  readonly generateResumeSessionHistoryObjectUrl: (
    objectKey: string,
  ) => Promise<string>;
}): Promise<ExecutionContext["resumeSession"]> {
  const resumeSession = args.resumeSession;
  if (!hasResumeSessionHistoryRef(resumeSession)) {
    return resumeSession;
  }

  return await args.timing.measure(
    "claim_route_response_resume_session",
    "nested",
    async () => {
      const { sessionId, historyRef } = resumeSession;
      const encoding = historyRef.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
      if (encoding !== SESSION_HISTORY_ENCODING_IDENTITY) {
        const compressedRepresentation =
          await args.loadCompressedRepresentation(historyRef.hash, encoding);
        if (compressedRepresentation === undefined) {
          throw invalidResumeSessionHistoryError(
            historyRef.hash,
            new Error(`${encoding} session history metadata is missing`),
          );
        }
        validateCompressedResumeSessionHistoryRepresentation(
          historyRef.hash,
          compressedRepresentation,
        );
        const url = await args.generateResumeSessionHistoryObjectUrl(
          compressedRepresentation.objectKey,
        );
        return {
          sessionId,
          historyRef: {
            kind: historyRef.kind,
            hash: historyRef.hash,
            url,
            encoding: compressedRepresentation.encoding,
            rawSize: compressedRepresentation.rawSize,
            encodedSize: compressedRepresentation.encodedSize,
            downloadSource: compressedRepresentation.downloadSource,
          },
        };
      }

      const identityRepresentation = await args.loadIdentityRepresentation(
        historyRef.hash,
      );
      if (identityRepresentation === undefined) {
        throw new ResumeSessionHistoryLoadError(
          historyRef.hash,
          RESUME_SESSION_HISTORY_LOAD_ERROR,
          new Error("identity session history metadata is missing"),
        );
      }
      const url = await args.generateResumeSessionHistoryUrl(historyRef.hash);
      return {
        sessionId,
        historyRef: {
          kind: historyRef.kind,
          hash: historyRef.hash,
          url,
          encoding: identityRepresentation.encoding,
          rawSize: identityRepresentation.rawSize,
          encodedSize: identityRepresentation.encodedSize,
          downloadSource: identityRepresentation.downloadSource,
        },
      };
    },
  );
}

async function buildClaimResponseBody(
  args: {
    readonly db: Db;
    readonly run: ClaimedRun;
    readonly reuseKey: string | null;
    readonly storedContext: StoredExecutionContext;
    readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
    readonly timing: ClaimRouteTimingCollector;
    readonly loadIdentityRepresentation: (
      hash: string,
    ) => Promise<IdentityResumeSessionHistoryRepresentation | undefined>;
    readonly loadCompressedRepresentation: (
      hash: string,
      encoding: CompressedSessionHistoryBlobEncoding,
    ) => Promise<CompressedResumeSessionHistoryRepresentation | undefined>;
    readonly generateResumeSessionHistoryUrl: (hash: string) => Promise<string>;
    readonly generateResumeSessionHistoryObjectUrl: (
      objectKey: string,
    ) => Promise<string>;
  },
  signal: AbortSignal,
): Promise<ExecutionContext> {
  const secretValues = await secretValuesForRunner(
    args.storedContext,
    args.timing,
  );
  signal.throwIfAborted();
  return await args.timing.measure(
    "claim_route_response_assembly",
    "top_level",
    async () => {
      const [resumeSessionResult, refreshedPoliciesResult] =
        await Promise.allSettled([
          resolveResumeSessionForClaim({
            resumeSession: args.storedContext.resumeSession,
            timing: args.timing,
            loadIdentityRepresentation(hash: string) {
              return args.loadIdentityRepresentation(hash);
            },
            loadCompressedRepresentation(
              hash: string,
              encoding: CompressedSessionHistoryBlobEncoding,
            ) {
              return args.loadCompressedRepresentation(hash, encoding);
            },
            generateResumeSessionHistoryUrl:
              args.generateResumeSessionHistoryUrl,
            generateResumeSessionHistoryObjectUrl:
              args.generateResumeSessionHistoryObjectUrl,
          }),
          refreshClaimNetworkPolicies({
            db: args.db,
            run: args.run,
            storedContext: args.storedContext,
            connectorPermissionBaseline: args.connectorPermissionBaseline,
            timing: args.timing,
          }),
        ]);
      if (resumeSessionResult.status === "rejected") {
        const error: unknown = resumeSessionResult.reason;
        throw error;
      }
      const resumeSession = resumeSessionResult.value;
      signal.throwIfAborted();
      const sandboxToken = generateSandboxToken(
        args.run.userId,
        args.run.id,
        args.run.orgId,
        args.storedContext.piLaunchConfig?.apiFirstTurn.schemaVersion === 2
          ? {
              ownerEpoch:
                args.storedContext.piLaunchConfig.apiFirstTurn.ownerEpoch,
              generation:
                args.storedContext.piLaunchConfig.apiFirstTurn.generation,
            }
          : undefined,
      );
      if (refreshedPoliciesResult.status === "rejected") {
        const error: unknown = refreshedPoliciesResult.reason;
        throw error;
      }
      const refreshedPolicies = refreshedPoliciesResult.value;
      signal.throwIfAborted();
      const {
        connectorPermissionBaseline: _connectorPermissionBaseline,
        secretValueEnvironmentKeys: _secretValueEnvironmentKeys,
        storageMounts: _storedStorageMounts,
        ...runnerStoredContext
      } = args.storedContext;
      return {
        ...runnerStoredContext,
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
        resumeSession,
        sandboxToken,
        secretValues,
        connectorRuntimeTargets: args.storedContext.connectorRuntimeTargets,
        networkPolicies: refreshedPolicies.networkPolicies,
        networkPolicyRefreshes: refreshedPolicies.networkPolicyRefreshes,
      };
    },
  );
}

const buildClaimResponseBodyForClaim$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly run: ClaimedRun;
      readonly reuseKey: string | null;
      readonly storedContext: StoredExecutionContext;
      readonly connectorPermissionBaseline: ConnectorPermissionBaselineRead;
      readonly timing: ClaimRouteTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<ExecutionContext> => {
    return await buildClaimResponseBody(
      {
        db: args.db,
        run: args.run,
        reuseKey: args.reuseKey,
        storedContext: args.storedContext,
        connectorPermissionBaseline: args.connectorPermissionBaseline,
        timing: args.timing,
        loadIdentityRepresentation(hash: string) {
          return set(loadIdentityResumeSessionHistoryRepresentation$, {
            db: args.db,
            hash,
          });
        },
        loadCompressedRepresentation(
          hash: string,
          encoding: CompressedSessionHistoryBlobEncoding,
        ) {
          return set(loadCompressedResumeSessionHistoryRepresentation$, {
            db: args.db,
            encoding,
            hash,
          });
        },
        generateResumeSessionHistoryUrl(hash: string) {
          return set(generateResumeSessionHistoryUrl$, hash);
        },
        generateResumeSessionHistoryObjectUrl(objectKey: string) {
          return set(generateResumeSessionHistoryObjectUrl$, objectKey);
        },
      },
      signal,
    );
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
  readonly resolution: RunnerPreferenceTelemetryResolution | undefined;
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
      resolution: undefined,
      claimState: undefined,
      targetedSelf: undefined,
    };
  }

  if (preference.kind === "noPreference") {
    return {
      resolution: runnerPreferenceTelemetryResolution(preference),
      claimState: "absent",
      targetedSelf: undefined,
    };
  }

  const claimState = args.telemetry?.runnerPreferenceClaimState;
  return {
    resolution: runnerPreferenceTelemetryResolution(preference),
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
    preferenceResolution: preferenceTelemetry.resolution,
    preferenceClaimState: preferenceTelemetry.claimState,
    preferenceTargetedSelf: preferenceTelemetry.targetedSelf,
    historyGenerationRunId: historyGenerationRunIdForStoredExecutionContext(
      args.storedContext,
    ),
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
  readonly preferenceResolution:
    | RunnerPreferenceTelemetryResolution
    | undefined;
  readonly preferenceClaimState: RunnerPreferenceTelemetryState | undefined;
  readonly preferenceTargetedSelf: boolean | undefined;
  readonly historyGenerationRunId: string | undefined;
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
  readonly preferenceResolution:
    | RunnerPreferenceTelemetryResolution
    | undefined;
  readonly preferenceClaimState: RunnerPreferenceTelemetryState | undefined;
  readonly preferenceTargetedSelf: boolean | undefined;
  readonly historyGenerationRunId: string | undefined;
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
  if (args.historyGenerationRunId) {
    dimensions.history_generation_run_id = args.historyGenerationRunId;
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
    ...(args.preferenceResolution
      ? {
          runner_preference_resolution: args.preferenceResolution,
        }
      : {}),
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
  ({ set }, args: ClaimFailedSideEffectArgs): void => {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        set(
          dispatchCompleteSideEffects$,
          {
            kind: "terminal",
            runId: args.runId,
            orgId: args.orgId,
            status: "failed",
            error: args.error,
          },
          backgroundSignal,
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

async function failClaimForResumeSessionHistoryLoad(
  args: {
    readonly db: Db;
    readonly owner: ComputeRunOwner;
    readonly runId: string;
    readonly orgId: string;
    readonly hash: string;
    readonly errorMessage: string;
    readonly cause: unknown;
    readonly scheduleFailedSideEffects: (
      args: ClaimFailedSideEffectArgs,
    ) => void;
  },
  signal: AbortSignal,
) {
  L.warn("session history R2 object could not be loaded during claim", {
    runId: args.runId,
    hash: args.hash,
    errorMessage: args.errorMessage,
    error: args.cause,
  });
  const poisonResult = await failPoisonQueuedJob(
    args.db,
    args.runId,
    args.owner,
    args.errorMessage,
    signal,
  );
  if (poisonResult.status !== "failed") {
    return poisonJobErrorResponse(poisonResult);
  }
  args.scheduleFailedSideEffects({
    runId: args.runId,
    orgId: args.orgId,
    error: args.errorMessage,
  });
  return badRequestMessage(args.errorMessage);
}

async function failClaimForInvalidStoredExecutionContext(
  args: {
    readonly db: Db;
    readonly owner: ComputeRunOwner;
    readonly runId: string;
    readonly orgId: string;
    readonly scheduleFailedSideEffects: (
      args: ClaimFailedSideEffectArgs,
    ) => void;
  },
  signal: AbortSignal,
) {
  const poisonResult = await failPoisonQueuedJob(
    args.db,
    args.runId,
    args.owner,
    INVALID_EXECUTION_CONTEXT_ERROR,
    signal,
  );
  if (poisonResult.status !== "failed") {
    return poisonJobErrorResponse(poisonResult);
  }
  args.scheduleFailedSideEffects({
    runId: args.runId,
    orgId: args.orgId,
    error: INVALID_EXECUTION_CONTEXT_ERROR,
  });
  return badRequestMessage("Job missing execution context");
}

async function claimResponseBuildErrorResponse(
  args: {
    readonly db: Db;
    readonly run: ClaimedRun;
    readonly runId: string;
    readonly error: unknown;
    readonly scheduleFailedSideEffects: (
      args: ClaimFailedSideEffectArgs,
    ) => void;
  },
  signal: AbortSignal,
) {
  if (!isResumeSessionHistoryLoadError(args.error)) {
    throw args.error;
  }
  return await failClaimForResumeSessionHistoryLoad(
    {
      db: args.db,
      runId: args.runId,
      owner: args.run,
      hash: args.error.hash,
      orgId: args.run.orgId,
      errorMessage: args.error.message,
      cause: args.error.cause,
      scheduleFailedSideEffects: args.scheduleFailedSideEffects,
    },
    signal,
  );
}

async function resolveStoredExecutionContextForClaim(
  args: {
    readonly db: Db;
    readonly owner: ComputeRunOwner;
    readonly runId: string;
    readonly orgId: string;
    readonly executionContext: unknown;
    readonly capabilities: RunnerClaimCapabilities;
    readonly timing: ClaimRouteTimingCollector;
    readonly scheduleFailedSideEffects: (
      args: ClaimFailedSideEffectArgs,
    ) => void;
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
      response: await failClaimForInvalidStoredExecutionContext(args, signal),
    };
  }
  const piModelConfigResolution = resolvePiModelConfigForClaim({
    cliAgentType: storedContextResult.data.cliAgentType,
    modelConfig: storedContextResult.data.piModelConfig,
    capabilities: args.capabilities,
    environment: storedContextResult.data.environment,
    firewalls: storedContextResult.data.firewalls,
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
      response: await failClaimForInvalidStoredExecutionContext(args, signal),
    };
  }
  return {
    compatible: true as const,
    value: decodeCompatibleStoredExecutionContext({
      ...storedContextResult.data,
      piModelConfig: piModelConfigResolution.modelConfig,
    }),
  };
}

function claimedExecutionContext(
  value: ExecutionContext,
  claimedAt: Date,
): ExecutionContext {
  const deferred = value.piLaunchConfig?.apiFirstTurn;
  if (deferred?.schemaVersion !== 2 || !value.piLaunchConfig) {
    return value;
  }
  return {
    ...value,
    piLaunchConfig: {
      ...value.piLaunchConfig,
      apiFirstTurn: {
        ...deferred,
        deadlineAt: claimedAt.getTime() + 2 * 60 * 60 * 1000,
      },
    },
  };
}

const claimAuthorizedJob$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
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
    const { db, runId, jobWithRun, claimRouteTiming } = args;
    const run = jobWithRun.run;

    const storedContextResult = await resolveStoredExecutionContextForClaim(
      {
        db,
        runId,
        owner: run,
        orgId: run.orgId,
        executionContext: jobWithRun.job.executionContext,
        capabilities: args.capabilities,
        timing: claimRouteTiming,
        scheduleFailedSideEffects(failedArgs) {
          set(scheduleClaimFailedSideEffects$, failedArgs);
        },
      },
      signal,
    );
    if (!storedContextResult.compatible) {
      return storedContextResult.response;
    }
    const { context: storedContext, connectorPermissionBaseline } =
      storedContextResult.value;

    const responseBodyResult = await settle(
      set(
        buildClaimResponseBodyForClaim$,
        {
          db,
          run,
          reuseKey: jobWithRun.job.reuseKey,
          storedContext,
          connectorPermissionBaseline,
          timing: claimRouteTiming,
        },
        signal,
      ),
      signal,
    );
    if (!responseBodyResult.ok) {
      return await claimResponseBuildErrorResponse(
        {
          db,
          run,
          runId,
          error: responseBodyResult.error,
          scheduleFailedSideEffects(failedArgs) {
            set(scheduleClaimFailedSideEffects$, failedArgs);
          },
        },
        signal,
      );
    }
    signal.throwIfAborted();

    claimRouteTiming.recordElapsed(
      "claim_route_request_to_transition_start",
      "parent",
      args.claimRequestStartedAtMs,
    );
    const claimResult = await claimRouteTiming.measure(
      "claim_route_transition_running",
      "top_level",
      async () => {
        return await transitionClaimedJobToRunning(
          db,
          {
            runId,
            owner: run,
            deferredAdmission: jobWithRun.deferredAdmission,
            deferred:
              storedContext.piLaunchConfig?.apiFirstTurn.schemaVersion === 2
                ? storedContext.piLaunchConfig.apiFirstTurn
                : undefined,
          },
          args.runnerAttribution,
          signal,
          claimRouteTiming,
        );
      },
    );
    if (signal.aborted) {
      L.debug("Runner claim request aborted after committed transition", {
        runId,
      });
    }
    signal.throwIfAborted();
    if (claimResult.status !== "claimed") {
      return claimTransitionErrorResponse(claimResult);
    }

    const response = {
      status: 200 as const,
      body: claimedExecutionContext(
        responseBodyResult.value,
        claimResult.claimedAt,
      ),
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
        }
      : undefined;

  const runId = get(pathParamsOf(runnersJobClaimContract.claim)).id;
  const db = set(writeDb$);
  claimRouteTiming.recordElapsed(
    "claim_route_request_prepare",
    "top_level",
    claimRequestStartedAtMs,
  );

  const lookupAuthorizationStartedAt = now();
  const jobWithRun = await getClaimableJob(
    db,
    runId,
    signal,
    auth.type === "official-runner" &&
      get(request$).header(PI_DEFERRED_SANDBOX_HEADER) === "1",
  );
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

  return await set(
    claimAuthorizedJob$,
    {
      db,
      runId,
      authType: auth.type,
      runnerAttribution,
      capabilities: body.data.capabilities,
      jobWithRun,
      telemetry: body.data.telemetry,
      claimRequestStartedAtMs,
      claimRouteTiming,
    },
    signal,
  );
});

const modelProviderFailureInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const receivedAt = nowDate();
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }
    if (auth.type !== "official-runner") {
      return forbidden(
        "Only official runners can report model provider failures",
      );
    }

    const body = await get(modelProviderFailureBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const runId = get(
      pathParamsOf(runnersModelProviderFailuresContract.report),
    ).runId;
    const db = set(writeDb$);
    const transition = await reportBuiltInModelProviderFailure(db, {
      runId,
      receivedAt,
      ...body.data,
    });
    signal.throwIfAborted();
    if (transition.outcome === "recorded" && transition.cooldown) {
      const logLevels = {
        authentication: "warn",
        billing: "warn",
        rate_limit: "info",
        provider_unavailable: "info",
        timeout: "info",
        connection: "info",
      } as const satisfies Record<
        typeof transition.cooldown.failureKind,
        "info" | "warn"
      >;
      L[logLevels[transition.cooldown.failureKind]](
        "Built-in model provider failure report recorded",
        {
          type: "built_in_model_provider_cooldown",
          runId,
          ...transition.cooldown,
          unavailableUntil: transition.cooldown.unavailableUntil.toISOString(),
        },
      );
    }
    return { status: 200 as const, body: { outcome: transition.outcome } };
  },
);

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
    const db = set(writeDb$);
    const run = await getRunNetworkPolicyScope(db, runId, signal);
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

    const results = await resolveConnectorRuntimeTargets({
      db,
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

    const catalog = await loadConnectorRunnerFirewallCatalog(() => {
      return get(db$);
    });
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

const activeInputReserveBody$ = bodyResultOf(
  runnersActiveInputsContract.reserve,
);
const activeInputReceiptBody$ = bodyResultOf(
  runnersActiveInputsContract.receipt,
);

const reserveActiveInputsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { runId } = get(pathParamsOf(runnersActiveInputsContract.reserve));
    if (auth.tokenType !== "sandbox" || auth.runId !== runId) {
      return forbidden("Active input delivery is not available");
    }
    const body = await get(activeInputReserveBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await reserveActiveInputDelivery(
      set(writeDb$),
      {
        runId,
        userId: auth.userId,
        orgId: auth.orgId,
      },
      signal,
    );
    if (result.outcome === "forbidden") {
      return forbidden("Active input delivery is not available");
    }
    if (result.outcome === "reserved") {
      return {
        status: 200 as const,
        body: {
          outcome: result.outcome,
          deliveryId: result.deliveryId,
          eventIds: [result.sourceEventId],
          prompt: result.prompt,
        },
      };
    }
    if (result.outcome === "held") {
      return {
        status: 200 as const,
        body: {
          outcome: result.outcome,
          deliveryId: result.deliveryId,
          eventIds: [result.sourceEventId],
        },
      };
    }
    return { status: 200 as const, body: result };
  },
);

const recordActiveInputDeliveryReceiptInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { runId, deliveryId } = get(
      pathParamsOf(runnersActiveInputsContract.receipt),
    );
    if (auth.tokenType !== "sandbox" || auth.runId !== runId) {
      return forbidden("Active input delivery is not available");
    }
    const body = await get(activeInputReceiptBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await recordActiveInputDeliveryReceipt(
      set(writeDb$),
      {
        runId,
        deliveryId,
        userId: auth.userId,
        orgId: auth.orgId,
      },
      signal,
    );
    if (result.outcome === "forbidden") {
      return forbidden("Active input delivery is not available");
    }
    if (result.replacementsAppended) {
      await publishChatThreadMessageCreatedSafely({
        userId: auth.userId,
        orgId: auth.orgId,
        threadId: result.chatThreadId,
      });
      signal.throwIfAborted();
      await notifyRunningChatRunOfPendingInput(
        set(writeDb$),
        result.chatThreadId,
      );
      signal.throwIfAborted();
    }
    return { status: 200 as const, body: { outcome: result.outcome } };
  },
);

const deferredHandoffInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { id, offset } = get(pathParamsOf(runnersJobClaimContract.handoff));
    const auth = getSandboxAuthForRun(id, get(authorization$));
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }
    const body = await readDeferredPiHandoffChunk(
      set(writeDb$),
      auth,
      Number(offset),
    );
    signal.throwIfAborted();
    return body
      ? { status: 200 as const, body }
      : notFound("Deferred Pi continuation is unavailable");
  },
);

const deferredReleaseBody$ = bodyResultOf(runnersJobClaimContract.release);
const deferredReleaseInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return unauthorizedAuthenticationRequired;
    }
    if (auth.type !== "official-runner") {
      return forbidden("Only official Runners can prove Sandbox destruction");
    }
    const body = await get(deferredReleaseBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const { id } = get(pathParamsOf(runnersJobClaimContract.release));
    const released = await releaseDeferredPiSandbox(set(writeDb$), {
      ...body.data,
      runId: id,
    });
    signal.throwIfAborted();
    if (released) {
      await set(settleDeferredPiTerminal$, id, signal);
    }
    return { status: 200 as const, body: { released } };
  },
);

export const runnersRoutes: readonly RouteEntry[] = [
  { route: runnersJobClaimContract.handoff, handler: deferredHandoffInner$ },
  { route: runnersJobClaimContract.release, handler: deferredReleaseInner$ },
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
  },
  {
    route: runnersModelProviderFailuresContract.report,
    handler: modelProviderFailureInner$,
  },
  {
    route: runnersActiveInputsContract.reserve,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      reserveActiveInputsInner$,
    ),
  },
  {
    route: runnersActiveInputsContract.receipt,
    handler: authRoute(
      { accept: ["sandbox"], acceptAnySandboxCapability: true },
      recordActiveInputDeliveryReceiptInner$,
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
