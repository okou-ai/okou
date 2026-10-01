/**
 * Atomic run launch persistence shared by execution owners: the pending
 * run/session/callback/runner-job rows, captured subscription validation and
 * the committed launch response. Moved verbatim out of the legacy execution
 * graph; owners (Thread, Pi maintenance) assemble their payloads privately.
 */
import { safeSync } from "../utils";
import { conflict } from "../../lib/error";
import type { OfficialWorkflowRunObservation } from "./official-workflow-run.service";
import { now, nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import {
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  type PiModelConfig,
  type PiLaunchConfig,
  type StoredExecutionContext,
  type StorageMountEntry,
  type SecretConnectorMetadata,
  type PiModelConfigLegacy,
  type StoredConnectorPermissionBaseline,
  type ConnectorRuntimeTargetRegistration,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
} from "@okouai/api-contracts/contracts/runners";
import {
  sql,
  and,
  eq,
  type WithSubquery,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type {
  AgentRunFullLaunchSnapshot,
  AgentRunLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import type {
  ModelProviderType,
  ModelProviderCodexRuntimeConfig,
  ModelProviderCredentialScope,
} from "@okouai/api-contracts/contracts/model-providers";
import type {
  AgentExecutionConfig as agentRunCreateAgentExecutionConfig,
  AgentExecutionDefinition,
} from "./agent-execution-config";
import type { SessionExecutionIdentity } from "./session-compatibility";
import { z } from "zod";
import {
  unifiedRunRequestSchema,
  type CreateRunResponse,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";
import type {
  ExpandedFirewallConfig,
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import type { ModelCatalog } from "./model-catalog.service";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  PiStableContextPromptProjection,
  PiStableContextOwner,
  PiStableContextSemanticInput,
  PiStableContextSourceVector,
} from "@okouai/db/jsonb-contracts/pi-stable-context";
import {
  type CapturedPersonalSubscriptionAccount,
  isPersonalSubscriptionProviderType,
  validatePersonalSubscriptionAdmission,
} from "./model-provider-account.service";
import type {
  RunCallback,
  DispatchFailedRunCallbacks,
  PersistProducerRunBinding,
  AgentRunModelPin,
} from "./agent-run-contracts";
import type {
  ChatThreadSessionResolution,
  ChatThreadSessionResolutionAction,
} from "./chat-session-continuity.service";
import type { RunWorkflowRef } from "./workflow-data.service";
import type {
  QueueFirstRunAssociation,
  QueueFirstRunClaimResult,
} from "./chat-queued-event.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { RunContextAxiomSnapshot } from "./run-context-snapshot.service";
import { isPiLangfuseDebugRunEnvironment } from "../../lib/pi-langfuse-debug";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  type RunMetadataValues,
  normalizeRunMetadata,
} from "./agent-run-metadata-write.service";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import type { Tx } from "../../lib/db-types";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { ingestToAxiom, getDatasetName } from "../external/axiom";

export type StorageManifestSource =
  | "system_skill"
  | "connector_skill"
  | "custom_connector_skill"
  | "official_workflow"
  | "workflow_skill"
  | "request_additional_volume"
  | "compose_additional_volume"
  | "compose_volume"
  | "artifact"
  | "unknown";

export type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;

export type CreateRunBody = Omit<
  z.infer<typeof unifiedRunRequestSchema>,
  "triggerSource"
> & {
  readonly triggerSource: TriggerSource;
};

export type DbTransaction = Tx;

export interface AgentRunCreateContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

export interface AgentRunCreateAdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly baselineCandidate?: true;
  readonly expectedStorageId?: string;
}

export type AdditionalVolumeSources =
  | readonly StorageManifestSource[]
  | undefined;

interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export interface ResolvedAgentExecution {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly orgId: string;
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly vars?: Record<string, string>;
  readonly volumeVersions?: Record<string, string>;
  readonly additionalVolumes?: readonly AgentRunCreateAdditionalVolume[];
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
  readonly previousRunStorageMounts?: readonly PersistedStorageMount[];
  readonly agentSessionId?: string;
  readonly continuedFromAgentSessionId?: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
  readonly resumeSessionIdentity?: SessionExecutionIdentity;
}

interface ResolvedUnboundExecution extends Omit<
  ResolvedAgentExecution,
  "agentId"
> {
  readonly agentId: null;
}

export type ResolvedRunExecution =
  | ResolvedAgentExecution
  | ResolvedUnboundExecution;

export interface ProductAgentExecutionPlan {
  readonly identity: "agent" | "no-agent";
  readonly content: agentRunCreateAgentExecutionConfig;
}

export interface AgentExecutionRequestObservation {
  readonly requestUserId: string;
  readonly requestOrgId: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly agentOrgId: string;
}

export type TestOnlyDirectRunResolver = (args: {
  readonly db: ReadonlyDb;
  readonly body: CreateRunBody;
  readonly userId: string;
  readonly orgId: string;
  readonly timing?: ApiDispatchTimingCollector;
}) => Promise<ResolvedAgentExecution | CreateRunErrorResult>;

export type ConnectorScopeSource = "explicit" | "stored_agent" | "empty";

export interface EffectiveConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants:
    | readonly AgentCustomConnectorGrant[]
    | undefined;
  readonly source: ConnectorScopeSource;
}

interface ExplicitConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants?: readonly AgentCustomConnectorGrant[];
  readonly source?: Exclude<ConnectorScopeSource, "empty">;
}

// Session naming in this service:
// - agentSessionId is the Okou application session (`agent_sessions.id`) used
//   for product-level continuation and future correctness checks.
// - cliAgentSessionId is the Claude/Codex/Pi agent session stored on
//   `conversations.cli_agent_session_id`.
// Existing API/runner wire fields named `sessionId` are preserved for
// compatibility and normalized to these semantic names at the boundary.

export function runnerReuseKey(
  chatThreadId: string | undefined,
): string | null {
  return chatThreadId ? `thread:${chatThreadId}` : null;
}

export interface RunnerJobPayload {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly executionContext: StoredExecutionContext;
}

export function runnerJobPayload(args: {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly executionContext: StoredExecutionContext;
}): RunnerJobPayload {
  return {
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    cliAgentSessionId: args.cliAgentSessionId,
    reuseKey: args.reuseKey,
    historyGenerationRunId: historyGenerationRunIdForStoredExecutionContext(
      args.executionContext,
    ),
    executionContext: args.executionContext,
  };
}

export interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
  readonly status: "pending";
}

export interface LaunchRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
}

type LaunchRunStatus = "pending" | "failed";

type ThreadSessionBindingAction = ChatThreadSessionResolutionAction;

export interface ThreadSessionBindingWrite {
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly action: ThreadSessionBindingAction;
}

export interface PersistedAtomicLaunchRows {
  readonly kind: "pending";
  readonly run: RunRecord;
  readonly runnerJobCreatedAt: Date;
  readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
}

export interface PreparedRunnerLaunch {
  readonly runnerJobPayload: RunnerJobPayload;
  readonly runContextSnapshot: RunContextAxiomSnapshot;
  readonly runStorageMounts: readonly PersistedStorageMount[];
  readonly sessionStorageMounts: readonly PersistedStorageMount[];
}

export type AgentRunCallbackInsert = typeof agentRunCallbacks.$inferInsert;

export type QueueFirstRunClaimed = Extract<
  QueueFirstRunClaimResult,
  { readonly kind: "claimed" }
>;

export interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

export const validatedThreadSessionTransaction = Symbol(
  "validatedThreadSessionTransaction",
);

export interface ValidatedThreadSessionSnapshot {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
  readonly [validatedThreadSessionTransaction]: DbTransaction;
}

export type AtomicLaunchCommitResult =
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly runnerJobPayload: RunnerJobPayload;
      readonly runnerJobCreatedAt: Date;
      readonly runContextSnapshot: RunContextAxiomSnapshot;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | QueueFirstRunClaimLost;

type CommittedAtomicLaunchResult = Exclude<
  AtomicLaunchCommitResult,
  QueueFirstRunClaimLost
>;

export type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
};

export type PendingThreadSessionResolution = Pick<
  ChatThreadSessionResolution,
  "action" | "resetNativeSession" | "expected"
>;
/** Explicit facts the atomic launch persists; owners assemble them privately. */
export interface PendingRunArguments {
  readonly userId: string;
  readonly orgId: string;
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  readonly chatThreadId?: string;
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly agentRunModelPin?: AgentRunModelPin;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
  readonly persistProducerRunBinding?: PersistProducerRunBinding;
  readonly threadSessionResolution?: PendingThreadSessionResolution;
}

/** Explicit run facts persisted with the launch rows. */
export interface PendingRunContext {
  readonly body: CreateRunBody;
  readonly selectedImageModel: ImageModel;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly resolved: {
    readonly agentId: string | null;
    readonly continuedFromAgentSessionId?: string;
  };
  readonly modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    | "credentialOwner"
    | "id"
    | "type"
    | "selectedModel"
    | "builtInModelRuntimeRoute"
  > | null;
}

export interface CommitPreparedLaunchArgs {
  readonly db: Db;
  readonly createArgs: PendingRunArguments;
  readonly enforceBuiltInCredits: boolean;
  readonly context: PendingRunContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
}

export interface ResolvedModelProviderEnvironment {
  readonly credentialOwner: PiModelConfigV4["credentialOwner"];
  readonly authMethod?: string | null;
  readonly piModelConfig?: PiModelConfig;
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly concreteType?: ModelProviderType;
  readonly environment: Record<string, string>;
  readonly secrets: Record<string, string>;
  readonly selectedModel: string | null;
  readonly firewall?: ExpandedFirewallConfig;
  readonly inlineFirewall?: boolean;
  readonly secretConnectorMap?: Record<string, string>;
  readonly secretConnectorMetadataMap?: Record<string, SecretConnectorMetadata>;
  readonly codexRuntimeConfig?: ModelProviderCodexRuntimeConfig;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Catalog route `upstream_model` placed into the provider environment. */
  readonly upstreamModel?: string;
  readonly credentialHeader?: NonNullable<
    PiModelConfigLegacy["credentialHeader"]
  >;
}

export type BuiltinRuntimeTargetRegistration = Extract<
  ConnectorRuntimeTargetRegistration,
  { readonly kind: "builtin" }
>;

export interface PermissionManifest {
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly builtinRuntimeTargets?: readonly BuiltinRuntimeTargetRegistration[];
  readonly connectorPermissionBaseline?: StoredConnectorPermissionBaseline;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly billableFirewalls: readonly string[];
}

export type ApiErrorResponse<Status extends number, Code extends string> = {
  readonly status: Status;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: Code;
    };
  };
};

export type CreateRunRouteResult =
  | CreateRunSuccessResult
  | ApiErrorResponse<400, "BAD_REQUEST">
  | ApiErrorResponse<403, "FORBIDDEN">
  | ApiErrorResponse<404, "NOT_FOUND">
  | (ApiErrorResponse<409, "CONFLICT"> & {
      /** Producer-facing classification; the HTTP response body is unchanged. */
      readonly admissionFailure?: "subscription_account_disconnected";
    })
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<402, "PRO_REQUIRED">
  | ApiErrorResponse<503, "PROVIDER_UNAVAILABLE">;

export type CreateRunErrorResult = Exclude<
  CreateRunRouteResult,
  { readonly status: 201 }
>;

interface PiStableContextCacheIdentity {
  readonly owner: PiStableContextOwner;
  readonly variantDigest: string;
  readonly semantic: PiStableContextSemanticInput;
  readonly source: Omit<
    PiStableContextSourceVector,
    "agentGeneration" | "userGeneration" | "extractorVersion"
  >;
}

export interface CreateAgentRunArgs {
  /**
   * The run's model catalog snapshot. The entry point (or the queue pick,
   * against the current catalog) loads it once; every model decision of this
   * run reads it.
   */
  readonly catalog: ModelCatalog;
  readonly retainedRunId?: string;
  readonly userId: string;
  readonly orgId: string;
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  /** Stable, nonsecret source bindings captured by the product entry point. */
  readonly piStableContext?: {
    /** Built only for a miss/dynamic path; ready artifacts supply this text. */
    readonly buildPrompt: () => PiStableContextPromptProjection;
    /** Built only by the durable stable-context consumer from captured input. */
    readonly buildCacheIdentity: () => PiStableContextCacheIdentity;
    /** Dynamic profile/channel text and explicit caller appendage, bound later. */
    readonly dynamicAppendSystemPrompt: string;
  };
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  /** Captured by the product entry point for this request only. This skips
   * an identity lookup, never the fresh environment or admission checks. */
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly callbacks?: readonly RunCallback[];
  readonly chatThreadId?: string;
  /** Exact connector that delivered this run's durable integration input. */
  readonly connectorSourceId?: string;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly includeOkouTokenSecret?: boolean;
  readonly productAgentExecutionPlan?: ProductAgentExecutionPlan;
  /**
   * Request-scoped Agent identity facts from an already authorized product
   * entry point. This can replace the equivalent preparation lookup only.
   */
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  /**
   * Retired direct-run test support. Production callers must supply a canonical
   * productAgentExecutionPlan; keeping legacy reads in the test fixture
   * preserves historical runner coverage without restoring a runtime dual-read.
   */
  readonly testOnlyResolveDirectRun?: TestOnlyDirectRunResolver;
  readonly okouTokenComputerUseHostId?: string;
  readonly okouTokenCloudBrowserEnabled?: boolean;
  readonly platformEnvironment?: Record<string, string>;
  // When set, system + workflow skill volumes are built and prepended in
  // prepareRunContext using the run's resolved (model-provider) framework.
  readonly injectSkillVolumes?: {
    // Each workflow's volume is keyed by its id (storage name), while the skill
    // mounts at its slug. Slugs are not unique, so the id is required.
    readonly workflows: readonly RunWorkflowRef[];
  };
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly connectorScope: ExplicitConnectorScope;
  readonly validateEnvironmentReferences?: boolean;
  readonly agentRunMetadata?: AgentRunMetadata;
  /** Require initial Built-in credits; this does not grant deficit continuation. */
  readonly enforceBuiltInCredits?: boolean;
  readonly dispatchFailedCallbacks?: DispatchFailedRunCallbacks;
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
  readonly persistProducerRunBinding?: PersistProducerRunBinding;
  readonly agentRunModelPin?: AgentRunModelPin;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  /** Producer-supplied runtime options, independent of the thread context. */
  readonly piLaunchConfig?: Omit<
    PiLaunchConfig,
    "schemaVersion" | "memoryRecall"
  >;
  /** Override the missing-root policy for this producer's artifact mounts. */
  readonly artifactMissingRootPolicy?: ArtifactMissingRootPolicy;
  /** Internal producer pin for the auto-injected memory mount baseline. */
  readonly pinnedMemoryVersionId?: string;
  readonly timing?: ApiDispatchTimingCollector;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
}

export function timingDimensionsForCreateArgs(
  args: Pick<CreateAgentRunArgs, "timingDimensions">,
): ApiDispatchTimingDimensions {
  return {
    api_start_source: "request",
    run_preparation_retry_count: "0",
    ...args.timingDimensions,
  };
}

export interface BuiltinConnectorRuntimeContext {
  readonly secrets: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly mcpConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorSourceIdBySlug: Readonly<Record<string, string>>;
  readonly storedEnvironment: Record<string, string> | undefined;
}

export function firstAgent(
  content: agentRunCreateAgentExecutionConfig,
): AgentExecutionDefinition | undefined {
  if (content.agent) {
    return content.agent;
  }
  if (!content.agents) {
    return undefined;
  }
  const firstKey = Object.keys(content.agents)[0];
  return firstKey ? content.agents[firstKey] : undefined;
}

export function runnerGroup(
  content: agentRunCreateAgentExecutionConfig,
): string | null {
  return firstAgent(content)?.experimental_runner?.group ?? null;
}

function agentRunModelProviderValues(
  modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    "type" | "id" | "selectedModel"
  > | null,
): Pick<
  RunMetadataValues,
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "selectedModel"
> {
  if (!modelProvider) {
    return {
      modelProvider: null,
      modelProviderId: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }
  return {
    modelProvider: modelProvider.type,
    modelProviderId: modelProvider.id,
    modelProviderCredentialScope: null,
    selectedModel: modelProvider.selectedModel,
  };
}

function runRecordFromLaunchIdentity(
  identity: LaunchRunIdentity,
  status: RunRecord["status"],
  createdAt: Date,
): RunRecord {
  return {
    id: identity.runId,
    createdAt,
    sessionId: identity.sessionId,
    shouldCreateSession: identity.shouldCreateSession,
    status,
  };
}

export interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly status: LaunchRunStatus;
  readonly capturedRuntimeRoute?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly validatedAccountIdentity?: string | null;
  readonly resolved: Pick<
    ResolvedRunExecution,
    "agentId" | "continuedFromAgentSessionId"
  >;
  readonly body: CreateRunBody;
  readonly runStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly sessionStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    | "credentialOwner"
    | "id"
    | "type"
    | "selectedModel"
    | "builtInModelRuntimeRoute"
  > | null;
  readonly agentRunModelPin: AgentRunModelPin | undefined;
  readonly selectedImageModel: ImageModel;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly chatThreadId: string | undefined;
  readonly agentRunMetadata: AgentRunMetadata | undefined;
  readonly apiStartTime: number;
  readonly runnerGroup: string | undefined;
  readonly launchSnapshot: AgentRunLaunchSnapshot;
  readonly langfuseTraceEnabled: boolean;
  readonly officialWorkflowProvenance:
    | AgentRunOfficialWorkflowProvenance
    | undefined;
  readonly error: string | undefined;
  readonly creditAdmitted: boolean;
}

interface LaunchSessionValues {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string | null;
  readonly storageMounts: PersistedStorageMount[] | null;
  readonly conversationId: null;
}

export function launchSessionValues(
  args: LaunchRunRowsArgs,
): LaunchSessionValues {
  return {
    id: args.identity.sessionId,
    userId: args.userId,
    orgId: args.orgId,
    agentId: args.resolved.agentId,
    storageMounts: args.sessionStorageMounts
      ? [...args.sessionStorageMounts]
      : null,
    conversationId: null,
  };
}

export function launchRunValues(
  args: LaunchRunRowsArgs,
  createdAt: Date,
  metadata: RunMetadataValues,
): typeof agentRuns.$inferInsert {
  return {
    id: args.identity.runId,
    createdAt,
    userId: args.userId,
    orgId: args.orgId,
    status: args.status,
    creditAdmitted: args.creditAdmitted,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    vars: args.body.vars ?? null,
    secretNames: args.body.secrets ? Object.keys(args.body.secrets) : null,
    storageMounts: args.runStorageMounts ? [...args.runStorageMounts] : null,
    continuedFromSessionId: args.resolved.continuedFromAgentSessionId ?? null,
    sessionId: args.identity.sessionId,
    runnerGroup: args.runnerGroup ?? null,
    launchSnapshot: args.launchSnapshot,
    langfuseTraceEnabled: args.langfuseTraceEnabled,
    officialWorkflowProvenance: args.officialWorkflowProvenance ?? null,
    completedAt: args.status === "failed" ? createdAt : null,
    error: args.error ?? null,
    ...metadata,
    ...(args.validatedAccountIdentity === undefined
      ? {}
      : {
          modelProviderAccountIdentity: args.validatedAccountIdentity,
        }),
  };
}

type BuiltInModelLaunchMetadataValues = Pick<
  RunMetadataValues,
  "modelRuntimeProvider" | "modelRuntimeModel" | "builtInModelKeyId"
>;

function builtInModelLaunchMetadataValues(
  modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    "builtInModelRuntimeRoute"
  > | null,
): BuiltInModelLaunchMetadataValues {
  const runtimeRoute = modelProvider?.builtInModelRuntimeRoute;
  if (!runtimeRoute) {
    return {
      modelRuntimeProvider: null,
      modelRuntimeModel: null,
      builtInModelKeyId: null,
    };
  }
  return {
    modelRuntimeProvider: runtimeRoute.providerType,
    modelRuntimeModel: runtimeRoute.upstreamModel,
    builtInModelKeyId: runtimeRoute.modelKeyId,
  };
}

function agentRunLaunchMetadataInput(metadata: AgentRunMetadata): {
  readonly autonomyBudget: number | undefined;
  readonly workflowAutomationId: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly triggerBrief: string | null;
} {
  return {
    autonomyBudget: metadata.autonomyBudget,
    workflowAutomationId: metadata.workflowAutomationId ?? null,
    codexServiceTier: metadata.codexServiceTier ?? null,
    reasoningEffort: metadata.reasoningEffort ?? null,
    triggerBrief: metadata.triggerBrief ?? null,
  };
}

export function launchRunMetadataValues(
  args: LaunchRunRowsArgs,
): RunMetadataValues {
  const metadata: AgentRunMetadata = args.agentRunMetadata ?? {};
  const modelPin =
    args.agentRunModelPin ?? agentRunModelProviderValues(args.modelProvider);
  const exactSubscriptionId =
    args.modelProvider &&
    isPersonalSubscriptionProviderType(args.modelProvider.type)
      ? args.modelProvider.id
      : undefined;
  return normalizeRunMetadata({
    triggerSource: args.body.triggerSource,
    ...agentRunLaunchMetadataInput(metadata),
    modelProvider: modelPin.modelProvider,
    modelProviderId: exactSubscriptionId ?? modelPin.modelProviderId,
    modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
    selectedModel: modelPin.selectedModel,
    ...builtInModelLaunchMetadataValues(args.modelProvider),
    ...(args.capturedRuntimeRoute
      ? {
          modelRuntimeProvider: args.capturedRuntimeRoute.provider,
          modelRuntimeModel: args.capturedRuntimeRoute.model,
        }
      : {}),
    selectedImageModel: args.selectedImageModel,
    chatThreadId: args.chatThreadId ?? null,
    apiStartedAt: new Date(args.apiStartTime),
    firstAssistantEventAcknowledgedAt: null,
    summary: null,
  });
}

// Telemetry ingestion is best effort: no caller branches on the outcome and a
// failed ingest carries no operator action.
function bestEffortTelemetry(record: () => unknown): void {
  safeSync(record);
}

function ingestRunContextSnapshot(snapshot: RunContextAxiomSnapshot): void {
  bestEffortTelemetry(() => {
    return ingestToAxiom(getDatasetName("run-context"), [snapshot]);
  });
}

function recordThreadSessionBindingTelemetry(args: {
  readonly binding: ThreadSessionBindingWrite;
  readonly runStatus: "pending";
}): void {
  bestEffortTelemetry(() => {
    recordSandboxOperation({
      sandboxType: "chat",
      actionType: "chat_thread_session_binding_persisted",
      durationMs: 0,
      success: true,
      runId: args.binding.agentSessionRunId,
      dimensions: {
        chat_thread_id: args.binding.chatThreadId,
        agent_session_id: args.binding.agentSessionId,
        agent_session_run_id: args.binding.agentSessionRunId,
        binding_action: args.binding.action,
        run_status: args.runStatus,
      },
    });
  });
}

function preparedLaunchRowsArgs(args: {
  readonly commit: Omit<CommitPreparedLaunchArgs, "db">;
  readonly runnerGroup: string;
}): LaunchRunRowsArgs {
  return {
    userId: args.commit.createArgs.userId,
    orgId: args.commit.createArgs.orgId,
    identity: args.commit.identity,
    status: "pending",
    resolved: args.commit.context.resolved,
    body: args.commit.context.body,
    runStorageMounts: args.commit.launch.runStorageMounts,
    sessionStorageMounts: args.commit.launch.sessionStorageMounts,
    modelProvider: args.commit.context.modelProvider,
    agentRunModelPin: args.commit.createArgs.agentRunModelPin,
    selectedImageModel: args.commit.context.selectedImageModel,
    callbackRows: args.commit.callbackRows,
    chatThreadId: args.commit.createArgs.chatThreadId,
    agentRunMetadata: args.commit.createArgs.agentRunMetadata,
    apiStartTime: args.commit.createArgs.apiStartTime,
    runnerGroup: args.runnerGroup,
    launchSnapshot: args.commit.context.launchSnapshot,
    langfuseTraceEnabled: isPiLangfuseDebugRunEnvironment(
      args.commit.launch.runnerJobPayload.executionContext.platformEnvironment,
    ),
    officialWorkflowProvenance:
      args.commit.context.officialWorkflowRun?.provenance,
    error: undefined,
    creditAdmitted: false,
  };
}

interface PreparedAtomicLaunchRows {
  readonly rowsArgs: LaunchRunRowsArgs;
  readonly metadata: RunMetadataValues;
}

interface PreparedAtomicLaunchPersistence {
  readonly payload: RunnerJobPayload;
  readonly rows: PreparedAtomicLaunchRows;
  readonly diagnosticRegistrationPayload: z.infer<
    typeof agentRunConnectorDiagnosticRegistrationPayloadSchema
  >;
}

export interface PreparedCommitPreparedLaunchArgs extends CommitPreparedLaunchArgs {
  readonly persistence: PreparedAtomicLaunchPersistence;
  readonly admissionTiming: AdmissionAttemptTiming;
}

export function prepareAtomicLaunchPersistence(
  commit: Omit<CommitPreparedLaunchArgs, "db">,
): PreparedAtomicLaunchPersistence {
  const payload = runnerJobPayload({
    ...commit.launch.runnerJobPayload,
    reuseKey: runnerReuseKey(commit.createArgs.chatThreadId),
  });
  const rowsArgs = preparedLaunchRowsArgs({
    commit,
    runnerGroup: payload.runnerGroup,
  });
  return {
    payload,
    rows: { rowsArgs, metadata: launchRunMetadataValues(rowsArgs) },
    diagnosticRegistrationPayload:
      agentRunConnectorDiagnosticRegistrationPayloadSchema.parse({
        version: 1,
        targets: payload.executionContext.connectorRuntimeTargets,
      }),
  };
}

export interface ValidatedPreparedLaunchAdmission {
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
  readonly validatedAccountIdentity: string | null;
}

export interface PersistAtomicLaunchRowsArgs extends ValidatedPreparedLaunchAdmission {
  readonly tx: DbTransaction;
  readonly commit: PreparedCommitPreparedLaunchArgs;
  readonly payload: RunnerJobPayload;
}

type ReturnedIdCte = WithSubquery & { readonly id: SQLWrapper };

function returnedCteId(cte: ReturnedIdCte): SQL {
  // Child mutations read the returned key so their dependency is explicit;
  // data-modifying CTE declaration order alone does not order execution.
  return sql`(SELECT ${cte.id} FROM ${cte})`;
}

function nullableReturnedCteId(cte: ReturnedIdCte | undefined): SQL {
  return cte ? sql`(SELECT ${cte.id} FROM ${cte})` : sql`NULL`;
}

function appendLaunchCallbackCte(args: {
  readonly tx: DbTransaction;
  readonly ctes: WithSubquery[];
  readonly callbacks: readonly AgentRunCallbackInsert[];
  readonly insertedRun: ReturnedIdCte;
}): void {
  if (args.callbacks.length === 0) {
    return;
  }
  const insertedCallbacks = args.tx.$with("inserted_launch_callbacks").as(
    args.tx.insert(agentRunCallbacks).values(
      args.callbacks.map((callback) => {
        return { ...callback, runId: returnedCteId(args.insertedRun) };
      }),
    ),
  );
  args.ctes.push(insertedCallbacks);
}

function launchThreadBindingCte(args: {
  readonly tx: DbTransaction;
  readonly chatThreadId: string | undefined;
  readonly identity: LaunchRunIdentity;
  readonly insertedRun: ReturnedIdCte;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
}) {
  if (!args.chatThreadId || !args.validatedThreadSession) {
    return undefined;
  }
  if (args.validatedThreadSession.chatThreadId !== args.chatThreadId) {
    throw new Error("Validated chat thread does not match binding target");
  }
  return args.tx.$with("updated_launch_thread_binding").as(
    args.tx
      .update(chatThreads)
      .set({
        agentSessionId: args.identity.sessionId,
        agentSessionRunId: returnedCteId(args.insertedRun),
      })
      // Compare-and-set: another launch that rebound the thread since the
      // snapshot makes this launch lose its claim.
      .where(
        and(
          eq(chatThreads.id, args.chatThreadId),
          sql`${chatThreads.agentSessionRunId} IS NOT DISTINCT FROM ${args.validatedThreadSession.agentSessionRunId}::uuid`,
        ),
      )
      .returning({ id: chatThreads.id }),
  );
}

export function buildAtomicLaunchCteContext(
  args: PersistAtomicLaunchRowsArgs,
  creditAdmitted: boolean,
) {
  const { rowsArgs, metadata } = args.commit.persistence.rows;
  const createdAt = nowDate();
  const ctes: WithSubquery[] = [];
  const insertedSession = rowsArgs.identity.shouldCreateSession
    ? args.tx
        .$with("inserted_launch_session")
        .as(
          args.tx
            .insert(agentSessions)
            .values(launchSessionValues(rowsArgs))
            .returning({ id: agentSessions.id }),
        )
    : undefined;
  if (insertedSession) {
    ctes.push(insertedSession);
  }

  const insertedRun = args.tx.$with("inserted_launch_run").as(
    args.tx
      .insert(agentRuns)
      .values({
        ...launchRunValues(rowsArgs, createdAt, metadata),
        creditAdmitted,
        modelProviderAccountIdentity: args.validatedAccountIdentity,
        sessionId: insertedSession
          ? returnedCteId(insertedSession)
          : rowsArgs.identity.sessionId,
      })
      .returning({ id: agentRuns.id, createdAt: agentRuns.createdAt }),
  );
  ctes.push(insertedRun);

  const insertedDiagnosticRegistration = args.tx
    .$with("inserted_launch_connector_diagnostic_registration")
    .as(
      args.tx.insert(agentRunConnectorDiagnosticRegistrations).values({
        runId: returnedCteId(insertedRun),
        payload: args.commit.persistence.diagnosticRegistrationPayload,
        createdAt,
      }),
    );
  // The insert executes with the statement and depends on insertedRun's ID.
  // Its returned row need not participate in the final result join.
  ctes.push(insertedDiagnosticRegistration);

  appendLaunchCallbackCte({
    tx: args.tx,
    ctes,
    callbacks: rowsArgs.callbackRows,
    insertedRun,
  });
  const chatThreadId = args.commit.createArgs.chatThreadId;
  const updatedThread = launchThreadBindingCte({
    tx: args.tx,
    chatThreadId,
    identity: rowsArgs.identity,
    insertedRun,
    validatedThreadSession: args.validatedThreadSession,
  });
  return {
    rowsArgs,
    createdAt,
    ctes,
    insertedRun,
    updatedThread,
  };
}

type AtomicLaunchCteContext = ReturnType<typeof buildAtomicLaunchCteContext>;

function atomicThreadSessionBinding(args: {
  readonly context: AtomicLaunchCteContext;
  readonly commit: CommitPreparedLaunchArgs;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
  readonly boundThreadId: string | null;
  readonly runId: string;
}): ThreadSessionBindingWrite | undefined {
  if (!args.boundThreadId) {
    return undefined;
  }
  if (!args.validatedThreadSession) {
    throw new Error("Atomic thread binding requires a validated snapshot");
  }
  return {
    chatThreadId: args.boundThreadId,
    agentSessionId: args.context.rowsArgs.identity.sessionId,
    agentSessionRunId: args.runId,
    action: threadSessionBindingAction({
      identity: args.context.rowsArgs.identity,
      previousAgentSessionId: args.validatedThreadSession.agentSessionId,
      resolution: args.commit.createArgs.threadSessionResolution,
    }),
  };
}

export async function persistPendingAtomicLaunch(
  args: PersistAtomicLaunchRowsArgs,
  context: AtomicLaunchCteContext,
): Promise<PersistedAtomicLaunchRows> {
  const timestamps = runnerJobQueueTimestamps();
  const insertedQueue = args.tx.$with("inserted_launch_runner_job").as(
    args.tx
      .insert(runnerJobQueue)
      .values({
        runId: returnedCteId(context.insertedRun),
        runnerGroup: args.payload.runnerGroup,
        profile: args.payload.profile,
        cliAgentSessionId: args.payload.cliAgentSessionId,
        reuseKey: args.payload.reuseKey,
        executionContext: args.payload.executionContext,
        ...timestamps,
      })
      .returning({
        runId: runnerJobQueue.runId,
        createdAt: runnerJobQueue.createdAt,
      }),
  );
  const ctes = [...context.ctes, insertedQueue];
  if (context.updatedThread) {
    ctes.push(context.updatedThread);
  }
  const [row] = await args.tx
    .with(...ctes)
    .select({
      runId: context.insertedRun.id,
      createdAt: context.insertedRun.createdAt,
      runnerJobCreatedAt: insertedQueue.createdAt,
      boundThreadId: nullableReturnedCteId(context.updatedThread).mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
    })
    .from(context.insertedRun)
    .innerJoin(insertedQueue, eq(insertedQueue.runId, context.insertedRun.id));
  if (row && context.updatedThread && !row.boundThreadId) {
    throw new ChatThreadBindingChanged();
  }
  if (!row) {
    throw new Error("Atomic pending launch persistence returned no row");
  }
  return {
    kind: "pending",
    run: runRecordFromLaunchIdentity(
      context.rowsArgs.identity,
      "pending",
      row.createdAt,
    ),
    runnerJobCreatedAt: row.runnerJobCreatedAt,
    threadSessionBinding: atomicThreadSessionBinding({
      context,
      commit: args.commit,
      validatedThreadSession: args.validatedThreadSession,
      boundThreadId: row.boundThreadId,
      runId: row.runId,
    }),
  };
}

export function threadSessionBindingAction(args: {
  readonly identity: LaunchRunIdentity;
  readonly previousAgentSessionId: string | null;
  readonly resolution: PendingThreadSessionResolution | undefined;
}): ThreadSessionBindingAction {
  return (
    args.resolution?.action ??
    (args.previousAgentSessionId === null
      ? "initialized"
      : args.previousAgentSessionId === args.identity.sessionId
        ? "reused"
        : "rotated")
  );
}

export async function validateCapturedSubscriptionAccount(
  tx: Tx,
  args: PreparedCommitPreparedLaunchArgs,
): Promise<
  CreateRunErrorResult | { readonly identity: string | null } | undefined
> {
  const provider = args.context.modelProvider;
  if (
    provider &&
    isPersonalSubscriptionProviderType(provider.type) &&
    provider.credentialOwner === "member"
  ) {
    const type = provider.type;
    return await args.admissionTiming.measureLeaf("subscription", async () => {
      const account = await args.timing.measure(
        "api_dispatch_subscription_validate_admission",
        "nested",
        async () => {
          return await validatePersonalSubscriptionAdmission({
            db: tx,
            orgId: args.createArgs.orgId,
            userId: args.createArgs.userId,
            type,
            sourceId: provider.id ?? undefined,
          });
        },
        { subscription_provider_type: type },
      );
      if (!account) {
        return {
          ...conflict(
            "The selected subscription account was disconnected. Reconnect it before starting another run.",
          ),
          admissionFailure: "subscription_account_disconnected" as const,
        };
      }
      return { identity: personalSubscriptionAccountIdentity(account) };
    });
  }
  return undefined;
}

/** The thread's session binding changed after the launch read its snapshot. */
class ChatThreadBindingChanged extends Error {
  constructor() {
    super("Chat thread session binding changed during launch");
    this.name = "ChatThreadBindingChanged";
  }
}

function createdRunResponse(
  run: RunRecord,
  dispatchResult: { readonly status: RunStatus },
): Extract<CreateRunRouteResult, { readonly status: 201 }> {
  return {
    status: 201,
    body: {
      runId: run.id,
      status: dispatchResult.status,
      sessionId: run.sessionId,
      createdAt: run.createdAt.toISOString(),
    },
  };
}

export function committedAtomicLaunchResponse(args: {
  readonly createArgs: PendingRunArguments;
  readonly committed: CommittedAtomicLaunchResult;
  readonly transactionReturnedAt: number;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}): Extract<CreateRunRouteResult, { readonly status: 201 }> {
  if (args.committed.threadSessionBinding) {
    recordThreadSessionBindingTelemetry({
      binding: args.committed.threadSessionBinding,
      runStatus: args.committed.kind,
    });
  }
  args.phaseTiming.checkpoint(
    "api_dispatch_phase_queue_insert",
    args.committed.runnerJobCreatedAt.getTime(),
  );
  args.phaseTiming.checkpoint(
    "api_dispatch_phase_commit",
    args.transactionReturnedAt,
  );
  args.phaseTiming.appendTo(args.timing);
  ingestRunContextSnapshot(args.committed.runContextSnapshot);
  const runContextRegisteredAt = now();
  const dispatchedProfile = args.committed.runnerJobPayload.profile;
  args.timing.flush({
    runId: args.committed.run.id,
    runnerGroup: args.committed.runnerJobPayload.runnerGroup,
    profile: dispatchedProfile,
    dispatchPath: "direct",
    dimensions: timingDimensionsForCreateArgs(args.createArgs),
    ...(args.createArgs.body.triggerSource
      ? { triggerSource: args.createArgs.body.triggerSource }
      : {}),
  });
  const dispatchTimingsRegisteredAt = now();
  const pendingActivation: PendingRunActivation = {
    apiStartTime: args.createArgs.apiStartTime,
    chatThreadId: args.createArgs.chatThreadId,
    runnerNotification: {
      runnerGroup: args.committed.runnerJobPayload.runnerGroup,
      runId: args.committed.run.id,
      profile: dispatchedProfile,
      reuseKey: args.committed.runnerJobPayload.reuseKey,
      cliAgentSessionId: args.committed.runnerJobPayload.cliAgentSessionId,
      historyGenerationRunId:
        args.committed.runnerJobPayload.historyGenerationRunId,
      createdAt: args.committed.runnerJobCreatedAt,
    },
    timing: {
      activationOrigin: "direct",
      commitReturnedAt: args.transactionReturnedAt,
      runContextRegisteredAt,
      dispatchTimingsRegisteredAt,
    },
  };
  const response = createdRunResponse(args.committed.run, {
    status: "pending",
  });
  return args.committed.queueFirstClaim
    ? {
        ...response,
        queueFirstClaim: args.committed.queueFirstClaim,
        pendingActivation,
      }
    : { ...response, pendingActivation };
}
