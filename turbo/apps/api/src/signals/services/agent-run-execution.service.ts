import { resolveModelProviderCodexRuntimeConfig } from "./model-provider-codex-runtime";
import { state, computed, command, type State, type Computed } from "ccstate";
import { settle, onRejection, tapError } from "../utils";
import {
  conflict,
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import {
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
  acquireOfficialWorkflowRunCatalogAdmissionLock,
  validateOfficialWorkflowRunForInsert,
  createOfficialWorkflowRunObjects,
  OfficialWorkflowRunAdmissionError,
} from "./official-workflow-run.service";
import { now, nowDate } from "../../lib/time";
import { db$, type Db, writeDb$, type ReadonlyDb } from "../external/db";
import {
  measureApiDispatchTiming,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
  measureApiDispatchTimingSync,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { SupportedFramework } from "@okouai/core/frameworks";
import {
  type StorageManifestCacheBranch,
  materializeRunStoragePresignedUrls$,
  createStorageManifestPresignedUrlCacheRows,
  type ReadOnlyStoragePresignedUrlRequest,
  type StorageManifestPresignedUrlCacheSnapshot,
  type SystemStoragePresignedUrlRequest,
  type WorkflowSkillStoragePresignedUrlRequest,
  type StorageManifestCacheObservationContext,
  type StoragePresignedUrlResult,
  systemStoragePresignedUrlCacheKey,
  SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  workflowSkillStoragePresignedUrlCacheKey,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  readOnlyStoragePresignedUrlCacheKey,
  READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  type ReadOnlyStoragePresignedUrlCacheStatus,
} from "./system-storage-presigned-url-cache.service";
import { env } from "../../lib/env";
import { SYSTEM_ORG_ID } from "@okouai/core/storage-names";
import {
  type PiMemoryRecallSelection,
  type SecretConnectorMetadata,
  piMemoryRecallSelectionSchema,
} from "@okouai/api-contracts/contracts/runners";

import {
  sql,
  and,
  eq,
  isNull,
  inArray,
  or,
  asc,
  isNotNull,
  ne,
} from "drizzle-orm";

import { alias, unionAll } from "drizzle-orm/pg-core";
import {
  createMemorySummaryProjectionObjects,
  type MemorySummaryProjectionReadInput,
} from "./memory-summary-projection.service";
import {
  type ModelProviderType,
  isBuiltInModelProviderType,
  getFrameworkForType,
  MODEL_PROVIDER_TYPES,
  getModelProviderFirewall,
  getModelProviderEnvBindings,
  getDefaultModel,
  type ModelProviderEnvBindings,
  hasAuthMethods,
  getSecretsForAuthMethod,
  normalizeRunModelId,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  type AgentExecutionConfig as agentRunCreateAgentExecutionConfig,
  buildAgentExecutionConfig,
  agentEnvironmentSecretNames,
} from "./agent-execution-config";
import { z } from "zod";
import {
  type BuiltInModelRuntimeRoute,
  isBuiltInModelRuntimeRoutePermitted,
  resolveBuiltInModelRuntimeRouteFromCatalog,
  unpricedBuiltInModelMessage,
} from "./built-in-model-runtime-route.service";
import {
  catalogHasProviderRoute,
  loadModelCatalog,
  catalogProviderUpstreamModel,
  type ModelCatalog,
} from "./model-catalog.service";
import { loadBuiltInRoutePricing } from "./built-in-route-pricing";
import {
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { isCatalogUltrafastServiceTierSupported } from "./model-route-capabilities.service";
import { resolveRunSelectionModel } from "./model-selection.service";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  type CapturedPersonalSubscriptionAccount,
  isPersonalSubscriptionProviderType,
  personalModelProviderAccountById,
  readPersonalSubscriptionAccount,
  activePersonalModelProviderAccount,
  type MemberModelAccountSnapshot,
} from "./model-provider-account.service";
import type { RunCallback } from "./agent-run-contracts";
import {
  type ChatThreadSessionResolution,
  type ChatThreadExecutionSnapshot,
  chatThreadSessionSelection,
  chatThreadConversationRun,
  resolveChatThreadSessionSnapshot,
} from "./chat-session-continuity.service";
import {
  type RunWorkflowSourceRow,
  workflowsForRunFromRows,
} from "./workflow-data.service";
import {
  type QueueFirstRunClaimResult,
  type QueueFirstRunSessionSnapshotState,
  type QueueFirstRunAdmission,
  resolveQueueFirstRunAdmission,
  claimQueueFirstRunAssociation,
} from "./chat-queued-event.service";
import {
  encryptPersistentSecretsMap,
  encryptPersistentSecretValue,
  decryptStoredSecretValue,
} from "./crypto.utils";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import { piPreparationObserver } from "./pi-preparation-timing.service";
import {
  startPiPreparationObservation,
  measurePiPreparation,
  measurePiPreparationSync,
} from "@okouai/pi-agent-runtime/api";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { randomUUID } from "node:crypto";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  isFreePlanForCreditAdmission,
  createRunAdmissionObjects,
  type RunAdmissionInput,
} from "./run-admission.service";
import { observePreparedLaunchPersistenceForTest } from "./prepared-launch-persistence-observer.service";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
  pgNullDecoder,
  pgInt8ToBigIntDecoder,
  zodDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { activateUsageAllowanceWindowsForRun } from "./usage-allowance.service";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import {
  createConnectorRuntimeSelectionObjects,
  getConnectorRuntimeConnector,
} from "./connector-catalog-runtime.service";
import { systemSkillStorageResolution$ } from "../context/system-skill-storage-resolution";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  userFeatureSwitchOverridesFromRows,
  ORG_SENTINEL_USER_ID,
  type UserFeatureSwitchOverrideRow,
} from "./feature-switch-scope";
import { agents } from "@okouai/db/schema/agent";
import { conversations } from "@okouai/db/schema/conversation";
import { blobs } from "@okouai/db/schema/blob";
import { variables } from "@okouai/db/schema/variable";
import { secrets as secretsTable } from "@okouai/db/schema/secret";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import {
  observeRunContextParallelStage,
  observeRunConnectorAccountsRead,
  observeAgentRunPreCreateParallelStage,
  observeAgentRunPiExecutionSnapshot,
} from "./agent-run-preparation-hooks";
import {
  modelProviderSurfaces,
  modelProviderConnections,
} from "@okouai/db/schema/model-provider-gateway";
import { modelProviderSurfaceProtocolSchema } from "@okouai/api-contracts/contracts/model-provider-gateways";
import {
  compileModelProviderGatewayRuntime,
  GATEWAY_RUNTIME_SECRET_NAME,
} from "./model-provider-gateway-runtime";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import { piCatalogModel } from "@okouai/core/pi-execution";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { normaliseCustomConnectorRow } from "./custom-connector.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorAccountSelection } from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import {
  customConnectorPermissionBundleDependencySlug,
  type CustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import { builtinConnectorCredentialSecretReadCondition } from "./builtin-connector-credential-access.service";
import type { CustomConnectorRuntimeStorageRow } from "./custom-connector-credential-access.service";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { previewAutomationBypass$ } from "../context/hono";
import { VERCEL_AUTOMATION_BYPASS_ENV } from "../../lib/preview-automation-bypass";
import {
  type WebChatSessionPromptInput,
  createWebChatSessionPromptObjects,
} from "./web-chat-session-prompt.service";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { activeUserPermissionGrantCondition } from "./user-permission-grants.service";
import {
  type FirewallPermissionGrant,
  permissionGrantsToFirewallPolicies,
} from "@okouai/connectors/firewall-metadata/policy";
import { userPermissionGrantActionSchema } from "@okouai/api-contracts/contracts/user-permission-grants";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { workflows } from "@okouai/db/schema/workflow";
import {
  type AgentConnectorSlugRow,
  type AgentCustomConnectorRow,
  agentConnectorScopeFromRows,
} from "./agent-connector-scope.service";
import {
  type CustomConnectorRuntimeContext,
  resolveCustomConnectorBaseUrlVars,
  loadEffectiveCustomConnectorPermissionBundle,
} from "./connector-runtime-preparation.service";
import {
  AgentRunCallbackInsert,
  AtomicLaunchCommitResult,
  CommitPreparedLaunchArgs,
  CreateAgentRunArgs,
  CreateRunBody,
  CreateRunErrorResult,
  CreateRunSuccessResult,
  DbTransaction,
  EffectiveConnectorScope,
  LaunchRunIdentity,
  LaunchRunRowsArgs,
  PendingRunArguments,
  PersistAtomicLaunchRowsArgs,
  PersistedAtomicLaunchRows,
  PreparedCommitPreparedLaunchArgs,
  PreparedRunContext,
  PreparedRunnerLaunch,
  QueueFirstRunClaimLost,
  QueueFirstRunClaimed,
  ResolvedModelProviderEnvironment,
  ResolvedRunExecution,
  RunRecord,
  RunnerJobPayload,
  ValidatedPreparedLaunchAdmission,
  buildAtomicLaunchCteContext,
  committedAtomicLaunchResponse,
  launchRunMetadataValues,
  launchRunValues,
  launchSessionValues,
  persistPendingAtomicLaunch,
  prepareAtomicLaunchPersistence,
  timingDimensionsForCreateArgs,
  validateCapturedSubscriptionAccount,
} from "./execution-launch-persistence.service";
import {
  AgentRunRecord,
  AgentRunStorageInput,
  AgentRunStoragePlan,
  AgentRunStorageSelection,
  BuildStorageManifestEntriesArgs,
  ContextArtifact,
  MaterializedAgentRunStorage,
  OfficialWorkflowArtifactResolutionError,
  PreparedReadOnlyStorageEntry,
  PreparedStorageEntries,
  PreparedWritebackStorageEntry,
  ResolvedManifestArtifactInput,
  ResolvedManifestStoragePlan,
  ResolvedStorageEntries,
  ResolvedStorageManifestEntryPlans,
  StorageIndex,
  StorageManifestBuildStats,
  StorageManifestEntryKind,
  StorageManifestEntryPhaseTimings,
  StorageRequest,
  StorageResolution,
  assertUniquePersistedMountPaths,
  canonicalPiMemoryMount,
  combinePreparedStorageEntries,
  countBucket,
  finalizePreparedStorage,
  mergeStorageEntries,
  persistedStorageMountRequests,
  prepareRequestStorageResolution,
  readOnlyStorageEntryMetadata,
  resolveSessionStorageOverlay,
  resolveSessionWritebackStorageMounts,
  resolveStorageEntries,
  resolveStorageManifestInputs,
  resolveValidatedPersistedStorageMounts,
  selectedRunStorageExecution,
  skillsRootForRun,
  storageEntriesMetadata,
  storageIndexKey,
  storageManifestCountBucket,
  writebackStorageEntryMetadata,
  loadStorageBaseIndex,
  withStoragePrefixVersions,
} from "./execution-storage-manifest.service";
import {
  PreparedConnectorContext,
  RunConnectorCatalogSelection,
  RunConnectorContextSnapshot,
  RunConnectorPreparation,
  RunConnectorReadInput,
  RunConnectorSelection,
  RunPreparedConnectorInputs,
  StoredConnectorEncryptedSecretRow,
  StoredConnectorMaterializationSnapshot,
  StoredConnectorMaterializationSnapshotRow,
  ThreadConnectorSelectionIds,
  allowedStoredConnectorRows,
  buildNewRunCustomConnectorRuntimeContext,
  connectorScopeForRuntimeSnapshot,
  connectorScopeFromCreateArgs,
  customConnectorCandidateRuntimeRows,
  customConnectorNewRunRowIsAdmissible,
  decryptStoredConnectorSecretRows,
  eagerStoredConnectorSecretInputs,
  eagerStoredConnectorSecretNames,
  emptyCustomConnectorRuntimeContext,
  isEmptyRunConnectorScope,
  materializeStoredConnectorSnapshotRows,
  mergeRecords,
  resolveStoredConnectorSecrets,
  runConnectorAccountCandidatesFromRows,
  runConnectorAccountRequests,
  runConnectorTargetFromRow,
  runConnectorTargetIsAuthorized,
  runThreadConnectorCandidates,
  storedConnectorContextFromSnapshot,
  storedConnectorCredentialReadGroups,
  storedConnectorExecutionContextFromSnapshot,
  storedConnectorTimingDimensions,
} from "./run-connector-context.service";
import {
  AgentRunCreateBody,
  AgentRunIdentityCommand,
  AgentRunSelectionInput,
  AnyCreateAgentRunCommandArgs,
  CreateAgentRunCommandArgs,
  NewRunRoutePricingRequest,
  ResolveModelProviderEnvironmentArgs,
  RunModelProviderArgs,
  RunModelProviderReadInput,
  UserInfo,
  builtInModelProviderEnvironmentFromSnapshot,
  frameworkApiKeyEnv,
  frameworkForProviderSelection,
  hasExplicitFrameworkApiKey,
  isModelProviderType,
  loadRunRoutePricing,
  materializePreparedPiProvider,
  modelProviderEnvironmentSecretValue,
  modelProviderFramework,
  personalSubscriptionAccountCandidates,
  piConfigurationRouteError,
  prepareModelUsageContext,
  resolveModelProviderModel,
  resolvePreparedPiModelConfig,
  selectedRunModelProviderArgs,
  selectedRunPiExecution,
} from "./run-model-provider-environment.service";
import {
  PreparePiLaunchResourcesArgs,
  PreparedPiLaunchResources,
  assemblePiLaunchResources,
  bindStableAppendSystemPrompt,
  noContentPiMemoryRecall,
  priorPiMemoryRecall,
} from "./pi-launch-resources.service";
import {
  AtomicLaunchRunInput,
  BuildRunnerJobPayloadInput,
  BuiltStoredExecutionContextDraft,
  MaterializedRunnerStorage,
  StorageMaterializationInput,
  atomicLaunchPayloadInput,
  buildPreparedPermissionManifest,
  buildStoredExecutionContextDraft,
  buildStoredExecutionSecrets,
  finalizedMaterializedLaunch,
  overriddenRuntimeSecretAliases,
  pendingOkouTokenSecrets,
  prepareRunnerStorageInput,
  preparedRunnerJobBody,
  runnerCheckpointArtifacts,
  withPaidToolPlatformEnvironment,
  withoutLegacyAgentRunEnvironmentEntries,
} from "./execution-runner-payload.service";
import {
  AtomicLaunchCommitCompletion,
  admissionAttemptOutcome,
  flushQueueFirstClaimLostTiming,
  persistThreadSessionBinding,
  validateThreadSessionSnapshot,
} from "./execution-launch-admission.service";
import {
  AgentRunAfterPreCreate,
  AgentRunGraphInput,
  AgentRunIdentityInput,
  BootstrapMetadataQueryRow,
  L,
  PersistedRunEnvironmentSecret,
  PersistedRunEnvironmentSnapshot,
  PersistedRunEnvironmentVariable,
  ResolveAgentExecutionOptions,
  RunAgentObservation,
  RunBodyEnvironment,
  RunBootstrapContext,
  agentRunsCreateForbidden,
  bootstrapMetadataRowKindSchema,
  buildCreateAgentRunArgs,
  buildMergedVariables,
  buildResolvedRunBody,
  enforceCaptureNetworkBodiesGate,
  initialRunBody,
  insufficientCredits,
  isRouteError,
  matchingAuthorizedRequestObservation,
  measureAgentRunPreCreate,
  permissionValidityHorizon,
  requireResolvedAgentIdMatch,
  resolveProductAgentExecution,
  resolveRunBodyEnvironment,
  selectedAgentRunVariables,
  validateCompose,
} from "./run-execution-body.service";
import {
  PrepareRunContextInput,
  PreparedAgentRun,
  PreparedOfficialWorkflow,
  PreparedRunBodyContext,
  PreparedRuntimeContext,
  RunWorkflowModelState,
  RunWorkflowReadInput,
  composePreparedRunContext,
  finalizePreparedRunContext,
  officialWorkflowRunCandidates,
  prepareRunOutputMetadata,
} from "./run-execution-context.service";

function storageManifestCacheObservation(args: {
  readonly timing?: ApiDispatchTimingCollector;
  readonly branch: StorageManifestCacheBranch;
  readonly entryKind: StorageManifestEntryKind;
}): StorageManifestCacheObservationContext | undefined {
  if (!args.timing) {
    return undefined;
  }
  return {
    timing: args.timing,
    branch: args.branch,
    entryKind: args.entryKind,
  };
}

function storageManifestMaterializationDimensions(args: {
  readonly branch: StorageManifestCacheBranch;
  readonly entryKind: StorageManifestEntryKind;
  readonly entryCount: number;
}): ApiDispatchTimingDimensions {
  return {
    storage_manifest_branch: args.branch,
    storage_manifest_entry_kind: args.entryKind,
    storage_manifest_entry_count_bucket: storageManifestCountBucket(
      args.entryCount,
    ),
  };
}

export interface StorageIndexInput {
  readonly db: ReadonlyDb;
  readonly requests: readonly StorageRequest[];
  readonly timing: ApiDispatchTimingCollector | undefined;
}

function createStorageIndexObject(
  input$: Computed<Promise<StorageIndexInput>>,
): Computed<Promise<StorageIndex>> {
  return computed(async (get) => {
    const input = await get(input$);
    const index = await loadStorageBaseIndex(
      input.db,
      input.requests,
      input.timing,
    );
    return await withStoragePrefixVersions(input.db, input.requests, index);
  });
}

function storageArchiveKey(resolved: StorageResolution): string {
  return `${resolved.s3Key}/archive.tar.gz`;
}

function isSystemOwnedStoragePlan(plan: ResolvedManifestStoragePlan): boolean {
  return plan.resolved.resolvedOrgId === SYSTEM_ORG_ID;
}

function isWorkflowSkillStoragePlan(
  plan: ResolvedManifestStoragePlan,
): boolean {
  return plan.source === "workflow_skill";
}

function systemStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
}): SystemStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.plan.resolved),
    storageVersionId: args.plan.resolved.versionId,
    publicEndpoint: true,
  };
}

function workflowSkillStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
}): WorkflowSkillStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.plan.resolved),
    storageVersionId: args.plan.resolved.versionId,
    resolvedOrgId: args.plan.resolved.resolvedOrgId,
    publicEndpoint: true,
  };
}

export function readOnlyStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly resolved: StorageResolution;
}): ReadOnlyStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.resolved),
    storageVersionId: args.resolved.versionId,
    resolvedOrgId: args.resolved.resolvedOrgId,
    publicEndpoint: true,
  };
}

interface StorageManifestPresignedUrlRequests {
  readonly systemRequests: readonly SystemStoragePresignedUrlRequest[];
  readonly workflowSkillRequests: readonly WorkflowSkillStoragePresignedUrlRequest[];
  readonly readOnlyRequests: readonly ReadOnlyStoragePresignedUrlRequest[];
}

export function storageManifestPresignedUrlRequests(args: {
  readonly bucket: string;
  readonly plans: readonly ResolvedManifestStoragePlan[];
}): StorageManifestPresignedUrlRequests {
  return {
    systemRequests: args.plans.filter(isSystemOwnedStoragePlan).map((plan) => {
      return systemStoragePresignedUrlRequest({
        bucket: args.bucket,
        plan,
      });
    }),
    workflowSkillRequests: args.plans
      .filter((plan) => {
        return (
          !isSystemOwnedStoragePlan(plan) && isWorkflowSkillStoragePlan(plan)
        );
      })
      .map((plan) => {
        return workflowSkillStoragePresignedUrlRequest({
          bucket: args.bucket,
          plan,
        });
      }),
    readOnlyRequests: args.plans
      .filter((plan) => {
        return (
          !isSystemOwnedStoragePlan(plan) && !isWorkflowSkillStoragePlan(plan)
        );
      })
      .map((plan) => {
        return readOnlyStoragePresignedUrlRequest({
          bucket: args.bucket,
          resolved: plan.resolved,
        });
      }),
  };
}

function buildPreparedReadOnlyStorageEntry(args: {
  readonly plan: ResolvedManifestStoragePlan;
  readonly archiveUrl: string;
}): PreparedReadOnlyStorageEntry {
  const metadata = readOnlyStorageEntryMetadata(args);
  return {
    ...metadata,
    storedMount: { ...metadata.storedMount, archiveUrl: args.archiveUrl },
  };
}

function buildWorkflowSkillStorageEntry(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats?: StorageManifestBuildStats;
}): PreparedReadOnlyStorageEntry {
  const request = workflowSkillStoragePresignedUrlRequest({
    bucket: args.bucket,
    plan: args.plan,
  });
  const result = args.urlsByCacheKey.get(
    workflowSkillStoragePresignedUrlCacheKey(request),
  );
  if (!result) {
    throw new Error(
      "Missing workflow skill storage presigned URL cache result",
    );
  }
  args.stats?.recordWorkflowSkillPresignCacheResult(result.status);
  if (result.status === "miss") {
    args.stats?.recordPresignCandidate(args.plan.entryKind, args.plan.source, {
      bucket: args.bucket,
      key: storageArchiveKey(args.plan.resolved),
      expiresIn: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
    args.stats?.recordNonSystemPresign(args.plan.entryKind, args.plan.source);
  }
  return buildPreparedReadOnlyStorageEntry({
    plan: args.plan,
    archiveUrl: result.url,
  });
}

function buildReadOnlyStorageEntry(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats?: StorageManifestBuildStats;
}): PreparedReadOnlyStorageEntry {
  const request = readOnlyStoragePresignedUrlRequest({
    bucket: args.bucket,
    resolved: args.plan.resolved,
  });
  const result = args.urlsByCacheKey.get(
    readOnlyStoragePresignedUrlCacheKey(request),
  );
  if (!result) {
    throw new Error("Missing readonly storage presigned URL cache result");
  }
  if (result.status === "miss") {
    args.stats?.recordPresignCandidate(args.plan.entryKind, args.plan.source, {
      bucket: args.bucket,
      key: storageArchiveKey(args.plan.resolved),
      expiresIn: READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
    args.stats?.recordNonSystemPresign(args.plan.entryKind, args.plan.source);
  }
  return buildPreparedReadOnlyStorageEntry({
    plan: args.plan,
    archiveUrl: result.url,
  });
}

function buildSystemStorageEntry(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats?: StorageManifestBuildStats;
}): PreparedReadOnlyStorageEntry {
  const request = systemStoragePresignedUrlRequest({
    bucket: args.bucket,
    plan: args.plan,
  });
  const result = args.urlsByCacheKey.get(
    systemStoragePresignedUrlCacheKey(request),
  );
  if (!result) {
    throw new Error("Missing system storage presigned URL cache result");
  }
  args.stats?.recordSystemPresignCacheResult(result.status);
  if (result.status === "miss") {
    args.stats?.recordPresignCandidate(args.plan.entryKind, args.plan.source, {
      bucket: args.bucket,
      key: storageArchiveKey(args.plan.resolved),
      expiresIn: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
  }
  return buildPreparedReadOnlyStorageEntry({
    plan: args.plan,
    archiveUrl: result.url,
  });
}

const buildStorageEntriesFromPlans$ = command(
  async (
    { set },
    args: {
      readonly db: ReadonlyDb;
      readonly bucket: string;
      readonly plans: readonly ResolvedManifestStoragePlan[];
      readonly requests: StorageManifestPresignedUrlRequests;
      readonly prefetchedRows: StorageManifestPresignedUrlCacheSnapshot;
      readonly timing?: ApiDispatchTimingCollector;
      readonly branch: StorageManifestCacheBranch;
      readonly entryKind: Extract<
        StorageManifestEntryKind,
        "compose" | "additional"
      >;
      readonly stats?: StorageManifestBuildStats;
    },
    signal: AbortSignal,
  ): Promise<readonly PreparedReadOnlyStorageEntry[]> => {
    const systemPlans = args.plans.filter(isSystemOwnedStoragePlan);
    args.stats?.recordSystemResolvedStorage(systemPlans.length);
    const observation = storageManifestCacheObservation(args);
    const dimensions = storageManifestMaterializationDimensions({
      branch: args.branch,
      entryKind: args.entryKind,
      entryCount: args.plans.length,
    });

    const systemUrlsByCacheKeyPromise = set(
      materializeRunStoragePresignedUrls$,
      {
        db: args.db,
        observation,
        requests: { kind: "system", values: args.requests.systemRequests },
        prefetchedRows: args.prefetchedRows,
      },
      signal,
    );
    const workflowSkillUrlsByCacheKeyPromise = set(
      materializeRunStoragePresignedUrls$,
      {
        db: args.db,
        observation,
        requests: {
          kind: "workflow",
          values: args.requests.workflowSkillRequests,
        },
        prefetchedRows: args.prefetchedRows,
      },
      signal,
    );
    const readOnlyUrlsByCacheKeyPromise = set(
      materializeRunStoragePresignedUrls$,
      {
        db: args.db,
        observation,
        requests: { kind: "readonly", values: args.requests.readOnlyRequests },
        prefetchedRows: args.prefetchedRows,
      },
      signal,
    );

    const joinResults = async () => {
      return await Promise.all([
        systemUrlsByCacheKeyPromise,
        workflowSkillUrlsByCacheKeyPromise,
        readOnlyUrlsByCacheKeyPromise,
      ]);
    };
    const [systemUrls, workflowUrls, readOnlyUrls] =
      args.plans.length === 0
        ? await joinResults()
        : await measureApiDispatchTiming(
            args.timing,
            "api_dispatch_prepare_storage_manifest_cache_join_results",
            "nested",
            joinResults,
            dimensions,
          );
    const constructEntries = () => {
      return args.plans.map((plan) => {
        if (isSystemOwnedStoragePlan(plan)) {
          return buildSystemStorageEntry({
            bucket: args.bucket,
            plan,
            urlsByCacheKey: systemUrls,
            stats: args.stats,
          });
        }
        if (isWorkflowSkillStoragePlan(plan)) {
          return buildWorkflowSkillStorageEntry({
            bucket: args.bucket,
            plan,
            urlsByCacheKey: workflowUrls,
            stats: args.stats,
          });
        }
        return buildReadOnlyStorageEntry({
          bucket: args.bucket,
          plan,
          urlsByCacheKey: readOnlyUrls,
          stats: args.stats,
        });
      });
    };
    return args.plans.length === 0
      ? constructEntries()
      : measureApiDispatchTimingSync(
          args.timing,
          "api_dispatch_prepare_storage_manifest_construct_entries",
          "nested",
          constructEntries,
          dimensions,
        );
  },
);

function buildPreparedWritebackStorageEntry(args: {
  readonly bucket: string;
  readonly input: ResolvedManifestArtifactInput;
  readonly archiveUrl: string | undefined;
  readonly cacheStatus: ReadOnlyStoragePresignedUrlCacheStatus | undefined;
  readonly stats?: StorageManifestBuildStats;
}): PreparedWritebackStorageEntry {
  const metadata = writebackStorageEntryMetadata(args.input);
  if (metadata.storedMount.empty) {
    return metadata;
  }
  const archiveKey = storageArchiveKey(args.input.resolved);
  if (args.archiveUrl === undefined || args.cacheStatus === undefined) {
    throw new Error("Missing writeback storage presigned URL cache result");
  }
  if (args.cacheStatus === "miss") {
    args.stats?.recordPresignCandidate("artifact", args.input.source, {
      bucket: args.bucket,
      key: archiveKey,
      expiresIn: READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
    args.stats?.recordNonSystemPresign("artifact", args.input.source);
  }

  return {
    ...metadata,
    storedMount: {
      ...metadata.storedMount,
      archiveUrl: args.archiveUrl,
    },
  };
}

interface PrefetchedStorageManifestPresignedUrls {
  readonly composeRequests: StorageManifestPresignedUrlRequests;
  readonly additionalRequests: StorageManifestPresignedUrlRequests;
  readonly artifactRequests: readonly ReadOnlyStoragePresignedUrlRequest[];
  readonly prefetchedRows: StorageManifestPresignedUrlCacheSnapshot;
}

export function finalStorageManifestPlans(
  resolved: ResolvedStorageManifestEntryPlans,
): {
  readonly composePlans: readonly ResolvedManifestStoragePlan[];
  readonly additionalPlans: readonly ResolvedManifestStoragePlan[];
} {
  const plans = mergeStorageEntries({
    composeEntries: resolved.composePlans,
    additionalEntries: resolved.additionalPlans,
    mountPath(plan) {
      return plan.mountPath;
    },
  });
  return {
    composePlans: plans.filter((plan) => {
      return plan.entryKind === "compose";
    }),
    additionalPlans: plans.filter((plan) => {
      return plan.entryKind === "additional";
    }),
  };
}

function createStoragePresignedUrlObjects(
  entries$: Computed<Promise<ResolvedStorageEntries | undefined>>,
) {
  const storageRequests$ = computed(async (get) => {
    const entries = await get(entries$);
    if (!entries) {
      return undefined;
    }
    const { composePlans, additionalPlans } = finalStorageManifestPlans(
      entries.resolved,
    );
    const composeRequests = storageManifestPresignedUrlRequests({
      bucket: entries.input.bucket,
      plans: composePlans,
    });
    const additionalRequests = storageManifestPresignedUrlRequests({
      bucket: entries.input.bucket,
      plans: additionalPlans,
    });
    const artifactRequests = entries.resolved.artifactInputs.flatMap(
      (input) => {
        return input.resolved.fileCount === 0
          ? []
          : [
              readOnlyStoragePresignedUrlRequest({
                bucket: entries.input.bucket,
                resolved: input.resolved,
              }),
            ];
      },
    );
    return { composeRequests, additionalRequests, artifactRequests };
  });
  const presignedCacheInput$ = computed(async (get) => {
    const [entries, requests] = await Promise.all([
      get(entries$),
      get(storageRequests$),
    ]);
    if (!entries || !requests) {
      return undefined;
    }
    const { composeRequests, additionalRequests, artifactRequests } = requests;
    const groups = [
      { kind: "system" as const, values: composeRequests.systemRequests },
      {
        kind: "workflow" as const,
        values: composeRequests.workflowSkillRequests,
      },
      { kind: "readonly" as const, values: composeRequests.readOnlyRequests },
      { kind: "system" as const, values: additionalRequests.systemRequests },
      {
        kind: "workflow" as const,
        values: additionalRequests.workflowSkillRequests,
      },
      {
        kind: "readonly" as const,
        values: additionalRequests.readOnlyRequests,
      },
      { kind: "readonly" as const, values: artifactRequests },
    ].filter((group) => {
      return group.values.length > 0;
    });
    return {
      db: entries.input.db,
      input: {
        systemRequests: [
          ...composeRequests.systemRequests,
          ...additionalRequests.systemRequests,
        ],
        workflowSkillRequests: [
          ...composeRequests.workflowSkillRequests,
          ...additionalRequests.workflowSkillRequests,
        ],
        readOnlyRequests: [
          ...composeRequests.readOnlyRequests,
          ...additionalRequests.readOnlyRequests,
          ...artifactRequests,
        ],
        logicalLookupCount: groups.length,
      },
      groups,
      observation: entries.input.timing
        ? { timing: entries.input.timing, branch: entries.branch }
        : undefined,
    };
  });
  const presignedCacheRows$ =
    createStorageManifestPresignedUrlCacheRows(presignedCacheInput$);
  return { storageRequests$, presignedCacheRows$ };
}

function preparedWritebackStorageEntries(args: {
  readonly bucket: string;
  readonly inputs: readonly ResolvedManifestArtifactInput[];
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats: StorageManifestBuildStats | undefined;
}): readonly PreparedWritebackStorageEntry[] {
  return args.inputs.map((input) => {
    const request = readOnlyStoragePresignedUrlRequest({
      bucket: args.bucket,
      resolved: input.resolved,
    });
    const result =
      input.resolved.fileCount === 0
        ? undefined
        : args.urlsByCacheKey.get(readOnlyStoragePresignedUrlCacheKey(request));
    return buildPreparedWritebackStorageEntry({
      bucket: args.bucket,
      input,
      archiveUrl: result?.url,
      cacheStatus: result?.status,
      stats: args.stats,
    });
  });
}

const generatePreparedStorageEntriesFromPlans$ = command(
  async (
    { set },
    args: {
      readonly input: BuildStorageManifestEntriesArgs;
      readonly branch: StorageManifestCacheBranch;
      readonly phaseTimings: StorageManifestEntryPhaseTimings;
      readonly resolved: ResolvedStorageManifestEntryPlans;
      readonly presigned: PrefetchedStorageManifestPresignedUrls;
    },
    signal: AbortSignal,
  ): Promise<PreparedStorageEntries> => {
    const {
      composePlans: finalComposePlans,
      additionalPlans: finalAdditionalPlans,
    } = finalStorageManifestPlans(args.resolved);
    const {
      composeRequests,
      additionalRequests,
      artifactRequests,
      prefetchedRows,
    } = args.presigned;
    signal.throwIfAborted();

    const [composeEntries, additionalEntries, writebackEntries] =
      await Promise.all([
        args.phaseTimings.compose.measureGenerate(() => {
          return set(
            buildStorageEntriesFromPlans$,
            {
              db: args.input.db,
              bucket: args.input.bucket,
              plans: finalComposePlans,
              requests: composeRequests,
              prefetchedRows,
              timing: args.input.timing,
              branch: args.branch,
              entryKind: "compose",
              stats: args.input.stats,
            },
            signal,
          );
        }),
        args.phaseTimings.additional.measureGenerate(() => {
          return set(
            buildStorageEntriesFromPlans$,
            {
              db: args.input.db,
              bucket: args.input.bucket,
              plans: finalAdditionalPlans,
              requests: additionalRequests,
              prefetchedRows,
              timing: args.input.timing,
              branch: args.branch,
              entryKind: "additional",
              stats: args.input.stats,
            },
            signal,
          );
        }),
        args.phaseTimings.artifact.measureGenerate(async () => {
          const urlsByCacheKey = await set(
            materializeRunStoragePresignedUrls$,
            {
              db: args.input.db,
              requests: { kind: "readonly", values: artifactRequests },
              prefetchedRows,
              observation: storageManifestCacheObservation({
                timing: args.input.timing,
                branch: args.branch,
                entryKind: "artifact",
              }),
            },
            signal,
          );
          const constructEntries = () => {
            return preparedWritebackStorageEntries({
              bucket: args.input.bucket,
              inputs: args.resolved.artifactInputs,
              urlsByCacheKey,
              stats: args.input.stats,
            });
          };
          return args.resolved.artifactInputs.length === 0
            ? constructEntries()
            : measureApiDispatchTimingSync(
                args.input.timing,
                "api_dispatch_prepare_storage_manifest_construct_entries",
                "nested",
                constructEntries,
                storageManifestMaterializationDimensions({
                  branch: args.branch,
                  entryKind: "artifact",
                  entryCount: args.resolved.artifactInputs.length,
                }),
              );
        }),
      ]);
    signal.throwIfAborted();

    return {
      composeEntries,
      additionalEntries,
      writebackEntries,
      resolvedComposeEntryCount: args.resolved.composePlans.length,
      resolvedAdditionalEntryCount: args.resolved.additionalPlans.length,
    };
  },
);

export const materializeStorageEntries$ = command(
  async (
    { set },
    args: {
      readonly plan: ResolvedStorageEntries;
      readonly presigned: PrefetchedStorageManifestPresignedUrls;
    },
    signal: AbortSignal,
  ): Promise<PreparedStorageEntries> => {
    const { plan, presigned } = args;
    return await measureApiDispatchTiming(
      plan.input.timing,
      "api_dispatch_prepare_storage_manifest_build_entries",
      "nested",
      () => {
        return set(
          generatePreparedStorageEntriesFromPlans$,
          { ...plan, presigned },
          signal,
        );
      },
      () => {
        return plan.input.stats?.buildEntriesDimensions();
      },
    ).finally(() => {
      plan.phaseTimings.compose.flushGenerate();
      plan.phaseTimings.additional.flushGenerate();
      plan.phaseTimings.artifact.flushGenerate();
    });
  },
);

function createStorageSelectionObject(
  input$: Computed<AgentRunStorageInput | Promise<AgentRunStorageInput>>,
): Computed<Promise<AgentRunStorageSelection>> {
  return computed(async (get): Promise<AgentRunStorageSelection> => {
    const input = await get(input$);
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (input.kind === "captured") {
      if (
        input.args.mounts.some((mount) => {
          return (
            mount.version === undefined ||
            !/^[0-9a-f]{64}$/u.test(mount.version)
          );
        })
      ) {
        throw new Error("Captured Pi storage must pin every version");
      }
      assertUniquePersistedMountPaths(input.args.mounts);
      return {
        kind: "captured",
        args: input.args,
        bucket,
        requests: persistedStorageMountRequests(input.args.mounts),
      };
    }
    const { artifacts, composeVolumes } = await resolveStorageManifestInputs(
      input.args,
    );
    const { canonicalWritebackMounts, remainingArtifacts } =
      resolveSessionStorageOverlay({
        artifacts,
        persistedStorageMounts: input.args.persistedStorageMounts,
      });
    const request = prepareRequestStorageResolution(
      input.args,
      bucket,
      composeVolumes,
      remainingArtifacts,
    );
    return {
      kind: "requested",
      args: input.args,
      bucket,
      request,
      remainingArtifacts,
      canonicalWritebackMounts,
      requests: [
        ...request.requests,
        ...persistedStorageMountRequests(canonicalWritebackMounts),
      ],
    };
  });
}

function createStorageEntryObjects(
  selection$: Computed<Promise<AgentRunStorageSelection>>,
  storageIndex$: Computed<Promise<StorageIndex>>,
) {
  const missingArtifacts$ = computed(
    async (get): Promise<readonly ContextArtifact[]> => {
      const [selection, storageIndex] = await Promise.all([
        get(selection$),
        get(storageIndex$),
      ]);
      if (selection.kind === "captured") {
        return [];
      }
      return selection.remainingArtifacts.filter((artifact) => {
        const entry = storageIndex.get(
          storageIndexKey(
            selection.args.runtimeOrgId,
            selection.args.userId,
            artifact.name,
          ),
        );
        return !entry || entry.headVersionId === null;
      });
    },
  );
  const requestedEntries$ = computed(async (get) => {
    const [selection, storageIndex, missingArtifacts] = await Promise.all([
      get(selection$),
      get(storageIndex$),
      get(missingArtifacts$),
    ]);
    if (selection.kind === "captured") {
      return resolveValidatedPersistedStorageMounts({
        ...selection.args,
        bucket: selection.bucket,
        storageIndex,
        branch: "captured",
      });
    }
    const missingNames = new Set(
      missingArtifacts.map((artifact) => {
        return artifact.name;
      }),
    );
    const requested = await resolveStorageEntries(
      {
        ...selection.request.input,
        artifacts: selection.remainingArtifacts.filter((artifact) => {
          return !missingNames.has(artifact.name);
        }),
        storageIndex,
      },
      "requested",
    );
    return {
      ...requested,
      input: { ...requested.input, artifacts: selection.remainingArtifacts },
    };
  });
  const sessionWritebackEntries$ = computed(async (get) => {
    const [selection, storageIndex] = await Promise.all([
      get(selection$),
      get(storageIndex$),
    ]);
    if (
      selection.kind === "captured" ||
      selection.canonicalWritebackMounts.length === 0
    ) {
      return undefined;
    }
    return resolveSessionWritebackStorageMounts({
      db: selection.args.db,
      bucket: selection.bucket,
      storageIndex,
      mounts: selection.canonicalWritebackMounts,
      timing: selection.args.timing,
      stats: selection.args.stats,
    });
  });
  const storagePlan$ = computed(async (get): Promise<AgentRunStoragePlan> => {
    const selection = await get(selection$);
    return await measureApiDispatchTiming(
      selection.args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_plan",
      "nested",
      async () => {
        const [requested, sessionWriteback, missingArtifacts] =
          await Promise.all([
            get(requestedEntries$),
            get(sessionWritebackEntries$),
            get(missingArtifacts$),
          ]);
        return { requested, sessionWriteback, missingArtifacts };
      },
    );
  });
  return { storagePlan$, sessionWritebackEntries$ };
}

function createStorageEntryMaterializationCommand(
  entries$: Computed<Promise<ResolvedStorageEntries | undefined>>,
) {
  const { storageRequests$, presignedCacheRows$ } =
    createStoragePresignedUrlObjects(entries$);
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<PreparedStorageEntries | undefined> => {
      const [plan, requests, prefetchedRows] = await Promise.all([
        get(entries$),
        get(storageRequests$),
        get(presignedCacheRows$),
      ]);
      signal.throwIfAborted();
      if (!plan || !requests) {
        return undefined;
      }
      if (!prefetchedRows) {
        throw new Error(
          "Storage cache snapshot is missing from the prepared entry graph",
        );
      }
      return await set(
        materializeStorageEntries$,
        { plan, presigned: { ...requests, prefetchedRows } },
        signal,
      );
    },
  );
}

function createRequestedStorageMaterializationCommand(
  requestedEntries$: Computed<Promise<ResolvedStorageEntries>>,
  materializeRequestedEntries$: ReturnType<
    typeof createStorageEntryMaterializationCommand
  >,
) {
  return command(
    async ({ get, set }, plan: AgentRunStoragePlan, signal: AbortSignal) => {
      if (plan.missingArtifacts.length > 0) {
        throw new Error(
          `Run storage must be initialized before execution: ${plan.missingArtifacts
            .map((artifact) => {
              return artifact.name;
            })
            .join(", ")}`,
        );
      }
      const [requestedPlan, requested] = await Promise.all([
        get(requestedEntries$),
        set(materializeRequestedEntries$, signal),
      ]);
      signal.throwIfAborted();
      if (!requested) {
        throw new Error("Requested storage entries were not materialized");
      }
      return { requestedPlan, requested };
    },
  );
}

/** Read and pin existing storage; run preparation never initializes roots. */
function createAgentRunStorageObjects(
  input$: Computed<AgentRunStorageInput | Promise<AgentRunStorageInput>>,
) {
  const selection$ = createStorageSelectionObject(input$);
  const indexInput$ = computed(async (get): Promise<StorageIndexInput> => {
    const selection = await get(selection$);
    return {
      db: selection.args.db,
      requests: selection.requests,
      timing: selection.args.timing,
    };
  });
  const storageIndex$ = createStorageIndexObject(indexInput$);
  const { storagePlan$, sessionWritebackEntries$ } = createStorageEntryObjects(
    selection$,
    storageIndex$,
  );
  const requestedEntries$ = computed(async (get) => {
    return (await get(storagePlan$)).requested;
  });
  const materializeRequestedEntries$ =
    createStorageEntryMaterializationCommand(requestedEntries$);
  const materializeSessionEntries$ = createStorageEntryMaterializationCommand(
    sessionWritebackEntries$,
  );
  const materializeRequestedStorage$ =
    createRequestedStorageMaterializationCommand(
      requestedEntries$,
      materializeRequestedEntries$,
    );
  const materializeAgentRunStorage$ = command(
    async (
      { set },
      plan: AgentRunStoragePlan,
      signal: AbortSignal,
    ): Promise<MaterializedAgentRunStorage> => {
      const [{ requestedPlan, requested }, sessionWriteback] =
        await Promise.all([
          set(materializeRequestedStorage$, plan, signal),
          set(materializeSessionEntries$, signal),
        ]);
      signal.throwIfAborted();
      const metadataEntries =
        plan.sessionWriteback === undefined
          ? storageEntriesMetadata(requestedPlan)
          : combinePreparedStorageEntries({
              requested: storageEntriesMetadata(requestedPlan),
              sessionWriteback: storageEntriesMetadata(plan.sessionWriteback),
            });
      const [metadata, prepared] = await Promise.all([
        finalizePreparedStorage({ entries: metadataEntries }),
        finalizePreparedStorage({
          entries:
            sessionWriteback === undefined
              ? requested
              : combinePreparedStorageEntries({ requested, sessionWriteback }),
          timing: requestedPlan.input.timing,
          stats: requestedPlan.input.stats,
        }),
      ]);
      signal.throwIfAborted();
      return {
        resolved: {
          metadata,
          requested: requestedPlan,
          sessionWriteback: plan.sessionWriteback,
        },
        prepared,
      };
    },
  );
  return { storagePlan$, materializeAgentRunStorage$ };
}

type QueueFirstAgentRunResult =
  | CreateRunSuccessResult
  | CreateRunErrorResult
  | QueueFirstRunClaimLost;

export function isQueueFirstRunClaimLost(
  result: unknown,
): result is QueueFirstRunClaimLost {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "queue-first-claim-lost"
  );
}

function assertThreadBoundRunHasQueueAssociation(
  args: CreateAgentRunArgs,
): void {
  if (args.chatThreadId !== undefined && !args.queueFirstAssociation) {
    throw new Error("Thread-bound run requires a queue-first association");
  }
}

interface RunResourceScope {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}

interface ScopedRunEnvironmentSnapshot extends PersistedRunEnvironmentSnapshot {
  readonly orgId: string;
  readonly userId: string;
  readonly secretNames: readonly string[];
}

interface RunEnvironmentReadInput extends RunResourceScope {
  readonly secretNames: readonly string[];
}

export const persistedRunEnvironmentRowKindDecoder = zodEnumDriverValueDecoder(
  z.enum(["variable", "secret"]),
);

function isReturnableRouteError(
  value: AtomicLaunchCommitResult | CreateRunErrorResult,
  signal: AbortSignal,
): value is CreateRunErrorResult {
  if (!isRouteError(value)) {
    return false;
  }
  signal.throwIfAborted();
  return true;
}

/**
 * Upstream model ID sent to a selected (non Built-in) provider: the catalog
 * route's `upstream_model`. A model outside the catalog (custom deployments)
 * is sent verbatim.
 */
function providerUpstreamModel(
  catalog: ModelCatalog,
  type: ModelProviderType,
  model: string,
): string {
  return (
    catalogProviderUpstreamModel(catalog, normalizeRunModelId(model), type) ??
    model
  );
}

function createRunFrameworkObject(
  input$: RunModelProviderInputObject,
  content$: ReturnType<typeof createRunIdentityObjects>["content$"],
) {
  return computed(async (get) => {
    const [input, content] = await Promise.all([get(input$), get(content$)]);
    if (isRouteError(input)) {
      return input;
    }
    if (isRouteError(content)) {
      return content;
    }
    const validation = validateCompose(content, undefined, undefined, {
      validateEnvironmentReferences: false,
    });
    if (isRouteError(validation)) {
      return validation;
    }
    const composeFramework = validation.framework;
    const db = input.db;
    const args = input.args;
    if (args.modelProviderType && isModelProviderType(args.modelProviderType)) {
      return (
        frameworkForProviderSelection(
          args.catalog,
          args.modelProviderType,
          args.selectedModelOverride,
        ) ?? composeFramework
      );
    }

    if (!args.modelProviderId) {
      return composeFramework;
    }

    const [provider] = await db
      .select({
        type: modelProviders.type,
        selectedModel: modelProviders.selectedModel,
      })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, args.modelProviderId),
          eq(modelProviders.orgId, args.orgId),
          or(
            eq(modelProviders.userId, args.userId),
            eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          ),
        ),
      )
      .limit(1);

    if (!provider) {
      const [account] = await db
        .select({ type: modelProviderAccounts.type })
        .from(modelProviderAccounts)
        .where(
          and(
            eq(modelProviderAccounts.id, args.modelProviderId),
            eq(modelProviderAccounts.orgId, args.orgId),
            eq(modelProviderAccounts.userId, args.userId),
          ),
        )
        .limit(1);
      return account && isModelProviderType(account.type)
        ? getFrameworkForType(account.type)
        : composeFramework;
    }
    if (!provider || !isModelProviderType(provider.type)) {
      return composeFramework;
    }

    return (
      frameworkForProviderSelection(
        args.catalog,
        provider.type,
        args.selectedModelOverride ?? provider.selectedModel,
      ) ?? composeFramework
    );
  });
}

interface SingleSecretModelProviderConfig {
  readonly framework: SupportedFramework;
  readonly secretName: string;
  readonly envBindings: ModelProviderEnvBindings;
  readonly defaultModel?: string;
}

function isSingleSecretModelProviderConfig(
  value: unknown,
): value is SingleSecretModelProviderConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "framework" in value &&
    "secretName" in value &&
    "envBindings" in value &&
    typeof (value as { readonly secretName: unknown }).secretName === "string"
  );
}

function hasUsableModelProviderSecretValue(value: string): boolean {
  return value.trim().length > 0;
}

function modelProviderFirewallAuthMaps(
  providerType: ModelProviderType,
  sourceUserId: string,
  secretNames: readonly string[],
  sourceId?: string,
):
  | {
      readonly secretConnectorMap: Record<string, string>;
      readonly secretConnectorMetadataMap: Record<
        string,
        SecretConnectorMetadata
      >;
    }
  | undefined {
  if (getModelProviderFirewall(providerType) === undefined) {
    return undefined;
  }

  const uniqueSecretNames = [...new Set(secretNames)];
  if (uniqueSecretNames.length === 0) {
    return undefined;
  }

  const secretConnectorMap = Object.fromEntries(
    uniqueSecretNames.map((secretName) => {
      return [secretName, providerType];
    }),
  );
  const secretConnectorMetadataMap = Object.fromEntries(
    uniqueSecretNames.map((secretName) => {
      return [
        secretName,
        {
          sourceType: "model-provider" as const,
          sourceUserId,
          ...(sourceId ? { sourceId } : {}),
          metadataKey: providerType,
        },
      ];
    }),
  );

  return { secretConnectorMap, secretConnectorMetadataMap };
}

function modelProviderEnvironment(args: {
  readonly catalog: ModelCatalog;
  readonly id: string | null;
  readonly type: ModelProviderType;
  readonly config: SingleSecretModelProviderConfig;
  readonly secretValue: string | undefined;
  readonly sourceUserId: string;
  readonly sourceId?: string;
  readonly captureSecret?: boolean;
  readonly selectedModel: string | null;
}): ResolvedModelProviderEnvironment {
  const firewall = getModelProviderFirewall(args.type);
  const hasFirewallAuth = firewall !== undefined;
  let secrets: Record<string, string> = {};
  if (!hasFirewallAuth || args.captureSecret) {
    if (args.secretValue === undefined) {
      throw new Error(`Missing eager secret for model provider ${args.type}`);
    }
    secrets = { [args.config.secretName]: args.secretValue };
  }
  const envBindings =
    getModelProviderEnvBindings(args.type) ?? args.config.envBindings;
  const model = resolveModelProviderModel({
    type: args.type,
    selectedModel: args.selectedModel,
    defaultModel: args.config.defaultModel,
    envBindings,
  });
  const runtimeModel = model
    ? providerUpstreamModel(args.catalog, args.type, model)
    : "";
  const environmentSecret = modelProviderEnvironmentSecretValue(
    args.type,
    args.config.secretName,
    args.secretValue ?? "",
  );
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    environment[key] = value
      .replaceAll("$secret", environmentSecret)
      .replaceAll("$model", runtimeModel);
  }
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type: args.type,
    logicalModel: model,
    runtimeModel,
    environment,
  });

  return {
    id: args.id,
    type: args.type,
    credentialOwner:
      args.sourceUserId === ORG_SENTINEL_USER_ID ? "organization" : "member",
    environment,
    ...(runtimeModel ? { upstreamModel: runtimeModel } : {}),
    secrets,
    selectedModel: model,
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
    ...modelProviderFirewallAuthMaps(
      args.type,
      args.sourceUserId,
      [args.config.secretName],
      args.sourceId,
    ),
  };
}

function providerEnvironmentFromSecretMap(
  type: ModelProviderType,
  providerSecrets: Record<string, string>,
  selectedModel: string | null,
): Record<string, string> {
  const envBindings = getModelProviderEnvBindings(type);
  if (!envBindings) {
    return Object.fromEntries(
      Object.entries(providerSecrets).map(([secretName, secretValue]) => {
        return [
          secretName,
          modelProviderEnvironmentSecretValue(type, secretName, secretValue),
        ];
      }),
    );
  }

  const fallbackSecret = Object.entries(providerSecrets)[0];
  const model = resolveModelProviderModel({
    type,
    selectedModel,
    defaultModel: getDefaultModel(type),
    envBindings,
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    if (value === "$secret") {
      if (fallbackSecret) {
        const [secretName, secretValue] = fallbackSecret;
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          secretName,
          secretValue,
        );
      }
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const secretName = value.slice("$secrets.".length);
      const secretValue = providerSecrets[secretName];
      if (secretValue) {
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          secretName,
          secretValue,
        );
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
}

function resolveMultiAuthRuntimeModel(
  args: {
    readonly catalog: ModelCatalog;
    readonly type: ModelProviderType;
    readonly configuredModel?: string | null;
    readonly piExecution?: boolean;
  },
  selectedModel: string | null,
): string | null {
  const cloud = args.type === "azure-foundry" || args.type === "aws-bedrock";
  const runtimeModel =
    cloud && args.configuredModel !== undefined
      ? args.configuredModel
      : selectedModel
        ? providerUpstreamModel(args.catalog, args.type, selectedModel)
        : null;
  if (
    cloud &&
    args.piExecution &&
    (!selectedModel ||
      !isCloudModelMappingValid(
        args.type,
        selectedModel,
        runtimeModel,
        catalogHasProviderRoute(args.catalog, selectedModel, args.type),
        args.catalog.byModel,
      ))
  ) {
    throw new PiNativeConfigurationError(
      "Cloud provider requires its explicitly configured deployment or profile",
    );
  }
  return runtimeModel;
}

interface ModelProviderEnvironmentSecret {
  readonly name: string;
  readonly encryptedValue: string | null;
}

async function loadModelProviderEnvironmentSecretRows(
  db: ReadonlyDb,
  args: {
    readonly accountId?: string;
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly piExecution?: boolean;
    readonly secretRows?: readonly ModelProviderEnvironmentSecret[];
  },
  hasFirewallAuth: boolean,
): Promise<readonly ModelProviderEnvironmentSecret[]> {
  if (args.secretRows) {
    return args.secretRows;
  }
  // Codex CLI needs only the workspace ID; keep every other firewall secret
  // lazy so bearer and refresh tokens are not read during run preparation.
  const readCodexRoutingAccountId =
    args.type === "codex-oauth-token" && !args.piExecution;
  if (args.accountId) {
    return await db
      .select({
        name: modelProviderAccountSecrets.name,
        encryptedValue: hasFirewallAuth
          ? readCodexRoutingAccountId
            ? sql`CASE WHEN ${modelProviderAccountSecrets.name} = 'CHATGPT_ACCOUNT_ID' THEN ${modelProviderAccountSecrets.encryptedValue} ELSE NULL END`.mapWith(
                nullableDriverValueDecoder(pgTextDecoder),
              )
            : sql`NULL`.mapWith(pgNullDecoder)
          : modelProviderAccountSecrets.encryptedValue,
      })
      .from(modelProviderAccountSecrets)
      .where(
        eq(modelProviderAccountSecrets.modelProviderAccountId, args.accountId),
      );
  }
  return await db
    .select({
      name: secretsTable.name,
      encryptedValue: hasFirewallAuth
        ? readCodexRoutingAccountId
          ? sql`CASE WHEN ${secretsTable.name} = 'CHATGPT_ACCOUNT_ID' THEN ${secretsTable.encryptedValue} ELSE NULL END`.mapWith(
              nullableDriverValueDecoder(pgTextDecoder),
            )
          : sql`NULL`.mapWith(pgNullDecoder)
        : secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, "model-provider"),
      ),
    );
}

async function multiAuthModelProviderEnvironment(
  db: ReadonlyDb,
  args: {
    readonly catalog: ModelCatalog;
    readonly id: string | null;
    readonly orgId: string;
    readonly userId: string;
    readonly type: ModelProviderType;
    readonly authMethod: string | null;
    readonly selectedModel: string | null;
    readonly configuredModel?: string | null;
    readonly piExecution?: boolean;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly accountId?: string;
    readonly secretRows?: readonly ModelProviderEnvironmentSecret[];
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.authMethod) {
    return null;
  }
  const secretConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretConfig) {
    return null;
  }

  const secretRows = await loadModelProviderEnvironmentSecretRows(
    db,
    args,
    getModelProviderFirewall(args.type) !== undefined,
  );
  return await multiAuthModelProviderEnvironmentFromSnapshot({
    ...args,
    secretRows,
  });
}

async function builtInModelProviderEnvironment(
  db: ReadonlyDb,
  catalog: ModelCatalog,
  selectedModel: string,
  featureSwitchContext: FeatureSwitchContext,
  {
    resolvedRoute,
    newRunPricing,
  }: {
    readonly resolvedRoute: BuiltInModelRuntimeRoute | undefined;
    readonly newRunPricing: NewRunRoutePricingRequest | undefined;
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  if (resolvedRoute && resolvedRoute.selectedModel !== selectedModel) {
    return null;
  }
  // A route captured earlier must still be an enabled catalog candidate; a
  // freshly resolved one already comes from the catalog.
  if (
    resolvedRoute &&
    !isBuiltInModelRuntimeRoutePermitted(catalog, resolvedRoute)
  ) {
    return null;
  }
  const route =
    resolvedRoute ??
    (await resolveBuiltInModelRuntimeRouteFromCatalog(
      db,
      catalog,
      selectedModel,
      featureSwitchContext,
      newRunPricing
        ? await loadBuiltInRoutePricing(db, {
            catalog,
            model: selectedModel,
            serviceTier: newRunPricing.serviceTier,
            resolution: newRunPricing.resolution,
          })
        : undefined,
    ));
  if (!route) {
    return null;
  }
  const [key] = await db
    .select({
      id: builtInModelKeys.id,
      apiKey: builtInModelKeys.apiKey,
    })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, route.modelKeyId))
    .limit(1);
  if (!key?.apiKey) {
    return null;
  }
  return builtInModelProviderEnvironmentFromSnapshot({
    route,
    selectedModel,
    featureSwitchContext,
    apiKey: key.apiKey,
  });
}

async function customGatewayModelProviderEnvironment(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.modelProviderId || !args.selectedModelOverride) {
    return null;
  }
  const [row] = await db
    .select({
      id: modelProviderSurfaces.id,
      protocol: modelProviderSurfaces.protocol,
      apiBaseUrl: modelProviderSurfaces.apiBaseUrl,
      authHeaderName: modelProviderSurfaces.authHeaderName,
      authHeaderTemplate: modelProviderSurfaces.authHeaderTemplate,
      modelMappings: modelProviderSurfaces.modelMappings,
      displayName: modelProviderConnections.displayName,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
    )
    .innerJoin(
      secretsTable,
      eq(modelProviderConnections.secretId, secretsTable.id),
    )
    .where(
      and(
        eq(modelProviderSurfaces.id, args.modelProviderId),
        eq(modelProviderConnections.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }

  return await customGatewayProviderEnvironmentFromSnapshot(args, row);
}

interface ModelProviderEnvironmentRow {
  readonly id: string;
  readonly type: string;
  readonly userId: string;
  readonly isDefault: boolean;
  readonly selectedModel: string | null;
  readonly authMethod: string | null;
  readonly encryptedValue: string | null;
}

interface ResolvableModelProviderEnvironmentRow extends ModelProviderEnvironmentRow {
  readonly type: ModelProviderType;
}

type PersonalModelProviderAccountRow =
  typeof modelProviderAccounts.$inferSelect;

function isCandidateModelProviderRow(
  row: ModelProviderEnvironmentRow,
  args: ResolveModelProviderEnvironmentArgs,
): row is ResolvableModelProviderEnvironmentRow {
  if (args.modelProviderId && row.id !== args.modelProviderId) {
    return false;
  }
  if (
    args.modelProviderCredentialScope === "org" &&
    row.userId !== ORG_SENTINEL_USER_ID
  ) {
    return false;
  }
  if (
    args.modelProviderCredentialScope === "member" &&
    row.userId !== args.userId
  ) {
    return false;
  }
  if (args.modelProviderType && row.type !== args.modelProviderType) {
    return false;
  }
  return isModelProviderType(row.type);
}

async function resolvePersonalModelProviderAccountEnvironment(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
  account: PersonalModelProviderAccountRow,
  selectedModel: string | null,
  secretRows?: readonly ModelProviderEnvironmentSecret[],
): Promise<ResolvedModelProviderEnvironment | null> {
  if (
    !isPersonalSubscriptionProviderType(account.type) ||
    getFrameworkForType(account.type) !== args.framework ||
    (args.modelProviderType !== undefined &&
      args.modelProviderType !== account.type)
  ) {
    return null;
  }

  if (hasAuthMethods(account.type)) {
    return await multiAuthModelProviderEnvironment(db, {
      catalog: args.catalog,
      id: account.id,
      orgId: account.orgId,
      userId: account.userId,
      type: account.type,
      authMethod: account.authMethod,
      selectedModel: args.selectedModelOverride ?? selectedModel,
      piExecution: args.piExecution,
      featureSwitchContext: args.featureSwitchContext,
      accountId: account.id,
      secretRows,
    });
  }

  const config = MODEL_PROVIDER_TYPES[account.type];
  if (!isSingleSecretModelProviderConfig(config)) {
    return null;
  }
  const secret = secretRows
    ? secretRows.find((row) => {
        return row.name === config.secretName;
      })
    : (
        await db
          .select({
            encryptedValue: modelProviderAccountSecrets.encryptedValue,
          })
          .from(modelProviderAccountSecrets)
          .where(
            and(
              eq(
                modelProviderAccountSecrets.modelProviderAccountId,
                account.id,
              ),
              eq(modelProviderAccountSecrets.name, config.secretName),
            ),
          )
          .limit(1)
      )[0];
  if (!secret || secret.encryptedValue === null) {
    return null;
  }

  return await personalProviderEnvironmentFromSnapshot(
    args,
    account,
    selectedModel,
    [{ name: config.secretName, encryptedValue: secret.encryptedValue }],
  );
}

async function resolveExactPersonalModelProviderAccount(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.modelProviderId || args.modelProviderCredentialScope === "org") {
    return null;
  }
  const captured = args.capturedPersonalSubscriptionAccount;
  const capturedType =
    !args.retainedRunId &&
    captured?.id === args.modelProviderId &&
    captured.orgId === args.orgId &&
    captured.userId === args.userId &&
    (args.modelProviderType === undefined ||
      captured.type === args.modelProviderType)
      ? captured.type
      : undefined;
  const account = capturedType
    ? null
    : await personalModelProviderAccountById({
        db,
        id: args.modelProviderId,
        orgId: args.orgId,
        userId: args.userId,
        runId: args.retainedRunId,
      });
  const accountType = capturedType ?? account?.type;
  if (!accountType || !isPersonalSubscriptionProviderType(accountType)) {
    return null;
  }
  // A deferred Run keeps the account its original request authorized, even if
  // it has since been disconnected; a new request needs a connected account.
  if (args.retainedRunId) {
    if (!account) {
      return null;
    }
    const [provider] = await db
      .select({ selectedModel: modelProviders.selectedModel })
      .from(modelProviders)
      .where(eq(modelProviders.id, account.modelProviderId))
      .limit(1);
    return provider
      ? await resolvePersonalModelProviderAccountEnvironment(
          db,
          args,
          account,
          provider.selectedModel,
        )
      : null;
  }
  const current = await readPersonalSubscriptionAccount({
    db,
    orgId: args.orgId,
    userId: args.userId,
    type: accountType,
    sourceId: args.modelProviderId,
  });
  if (!current) {
    return null;
  }
  return await resolvePersonalModelProviderAccountEnvironment(
    db,
    args,
    current.account,
    current.selectedModel,
    current.secrets,
  );
}

function shouldResolveActivePersonalModelProviderAccount(
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): boolean {
  return (
    row.userId === args.userId && isPersonalSubscriptionProviderType(row.type)
  );
}

async function resolveActivePersonalModelProviderAccountEnvironment(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  const account = await activePersonalModelProviderAccount({
    db,
    modelProviderId: row.id,
    orgId: args.orgId,
    userId: args.userId,
  });
  return account
    ? await resolvePersonalModelProviderAccountEnvironment(
        db,
        args,
        account,
        row.selectedModel,
      )
    : null;
}

async function resolveMultiAuthCandidate(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  // Plain reads without a transaction or row lock, Azure and Bedrock included.
  return await multiAuthModelProviderEnvironment(db, {
    catalog: args.catalog,
    id: row.id,
    orgId: args.orgId,
    userId: row.userId,
    type: row.type,
    authMethod: row.authMethod,
    selectedModel: args.selectedModelOverride ?? row.selectedModel,
    configuredModel: row.selectedModel,
    piExecution: args.piExecution,
    featureSwitchContext: args.featureSwitchContext,
  });
}

async function resolveCandidateModelProviderEnvironment(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (isBuiltInModelProviderType(row.type)) {
    const selectedModel =
      args.selectedModelOverride ??
      row.selectedModel ??
      args.catalog.systemDefaultModel;
    const provider = await builtInModelProviderEnvironment(
      db,
      args.catalog,
      selectedModel,
      args.featureSwitchContext,
      {
        resolvedRoute: args.builtInModelRuntimeRoute,
        newRunPricing: args.newRunPricing,
      },
    );
    return provider?.concreteType &&
      getFrameworkForType(provider.concreteType) === args.framework
      ? provider
      : null;
  }

  if (getFrameworkForType(row.type) !== args.framework) {
    return null;
  }

  if (shouldResolveActivePersonalModelProviderAccount(args, row)) {
    return await resolveActivePersonalModelProviderAccountEnvironment(
      db,
      args,
      row,
    );
  }

  if (hasAuthMethods(row.type)) {
    return await resolveMultiAuthCandidate(db, args, row);
  }

  return await regularProviderEnvironmentFromSnapshot(args, {
    provider: row,
    secrets: [],
  });
}

async function resolveModelProviderEnvironment(
  db: ReadonlyDb,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (isBuiltInModelProviderType(args.modelProviderType)) {
    const provider = await builtInModelProviderEnvironment(
      db,
      args.catalog,
      args.selectedModelOverride ?? args.catalog.systemDefaultModel,
      args.featureSwitchContext,
      {
        resolvedRoute: args.builtInModelRuntimeRoute,
        newRunPricing: args.newRunPricing,
      },
    );
    return provider?.concreteType &&
      getFrameworkForType(provider.concreteType) === args.framework
      ? provider
      : null;
  }

  const personalAccount = await resolveExactPersonalModelProviderAccount(
    db,
    args,
  );
  if (personalAccount) {
    return personalAccount;
  }

  const customGateway = await customGatewayModelProviderEnvironment(db, args);
  if (customGateway) {
    return customGateway;
  }

  const rows = await db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      userId: modelProviders.userId,
      isDefault: modelProviders.isDefault,
      selectedModel: modelProviders.selectedModel,
      authMethod: modelProviders.authMethod,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(modelProviders)
    .leftJoin(secretsTable, eq(modelProviders.secretId, secretsTable.id))
    .where(
      and(
        eq(modelProviders.orgId, args.orgId),
        or(
          eq(modelProviders.userId, args.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    );

  const sortedRows = rows.sort((left, right) => {
    const leftUser = left.userId === args.userId ? 1 : 0;
    const rightUser = right.userId === args.userId ? 1 : 0;
    if (leftUser !== rightUser) {
      return rightUser - leftUser;
    }
    const leftDefault = left.isDefault ? 1 : 0;
    const rightDefault = right.isDefault ? 1 : 0;
    return rightDefault - leftDefault;
  });

  for (const row of sortedRows) {
    if (!isCandidateModelProviderRow(row, args)) {
      continue;
    }
    const provider = await resolveCandidateModelProviderEnvironment(
      db,
      args,
      row,
    );
    if (provider) {
      return provider;
    }
  }

  return null;
}

function createRunEnvironmentObject(
  input$: RunContextInputObject,
  { content$ }: Pick<ReturnType<typeof createRunIdentityObjects>, "content$">,
) {
  const readInput$ = computed(async (get) => {
    const input = await get(input$);
    const content = await get(content$);
    if (isRouteError(content)) {
      return content;
    }
    return {
      db: input.db,
      orgId: input.args.orgId,
      userId: input.args.userId,
      secretNames: agentEnvironmentSecretNames(content),
    };
  });
  return createRunEnvironmentSnapshotObject(readInput$);
}

function createRunEnvironmentSnapshotObject(
  input$: Computed<
    | RunEnvironmentReadInput
    | Promise<RunEnvironmentReadInput | CreateRunErrorResult>
  >,
) {
  return computed(async (get) => {
    const args = await get(input$);
    if (isRouteError(args)) {
      return args;
    }
    const { db, secretNames: secretNamesToLoad } = args;
    const variableQuery = db
      .select({
        kind: sql`'variable'`
          .mapWith(persistedRunEnvironmentRowKindDecoder)
          .as("kind"),
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.type, "user"),
          or(
            eq(variables.userId, ORG_SENTINEL_USER_ID),
            eq(variables.userId, args.userId),
          ),
        ),
      );
    const rows =
      secretNamesToLoad.length > 0
        ? await variableQuery.unionAll(
            db
              .select({
                kind: sql`'secret'`
                  .mapWith(persistedRunEnvironmentRowKindDecoder)
                  .as("kind"),
                name: secretsTable.name,
                value: secretsTable.encryptedValue,
                userId: secretsTable.userId,
              })
              .from(secretsTable)
              .where(
                and(
                  eq(secretsTable.orgId, args.orgId),
                  eq(secretsTable.type, "user"),
                  or(
                    eq(secretsTable.userId, ORG_SENTINEL_USER_ID),
                    eq(secretsTable.userId, args.userId),
                  ),
                  inArray(secretsTable.name, secretNamesToLoad),
                ),
              ),
          )
        : await variableQuery;

    const variableRows: PersistedRunEnvironmentVariable[] = [];
    const secretRows: PersistedRunEnvironmentSecret[] = [];
    for (const row of rows) {
      if (row.kind === "variable") {
        variableRows.push({
          name: row.name,
          value: row.value,
          userId: row.userId,
        });
      } else {
        secretRows.push({
          name: row.name,
          encryptedValue: row.value,
          userId: row.userId,
        });
      }
    }

    return {
      orgId: args.orgId,
      userId: args.userId,
      secretNames: secretNamesToLoad,
      variables: variableRows,
      secrets: secretRows,
    };
  });
}

export const storedConnectorSecretNamesDecoder = zodDriverValueDecoder(
  z.array(z.string()),
);

export const storedConnectorVariableValuesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.string()),
);

function createRunAdmissionCheckObjects() {
  const internalInput$ = state<RunAdmissionInput | null>(null);
  const input$ = computed((get) => {
    const input = get(internalInput$);
    if (!input) {
      throw new Error("Run admission input is not installed");
    }
    return input;
  });
  const admission = createRunAdmissionObjects(input$);
  const checkAdmission$ = command(
    async ({ set }, input: RunAdmissionInput, signal: AbortSignal) => {
      signal.throwIfAborted();
      // The model/provider check and the final admission check deliberately
      // take fresh snapshots. Never reuse an earlier phase's entitlement.
      set(internalInput$, input);
      return await set(admission.checkAdmission$, signal);
    },
  );
  const checkPlanStatus$ = command(
    async ({ get, set }, input: RunAdmissionInput, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(internalInput$, input);
      const capabilities = await get(admission.capabilities$);
      signal.throwIfAborted();
      return capabilities?.status === "active" ? null : insufficientCredits();
    },
  );
  return { checkAdmission$, checkPlanStatus$ };
}

function createRunAgentObservationObject(
  input$: RunContextInputObject,
  options$: AsyncRead<ReturnType<typeof agentRunResolutionOptions>>,
) {
  return computed(async (get): Promise<RunAgentObservation | undefined> => {
    const input = await get(input$);
    const options = await get(options$);
    const body = initialRunBody(input.args);
    if (
      options.testOnlyResolveDirectRun ||
      body.sessionId ||
      options.productAgentExecutionPlan?.identity === "no-agent" ||
      !body.agentId
    ) {
      return undefined;
    }
    const agentId = body.agentId;
    const preloaded = options.preloadedAgentExecutionObservation;
    if (
      preloaded &&
      preloaded.requestUserId === input.args.userId &&
      preloaded.requestOrgId === input.args.orgId &&
      preloaded.agentId === agentId &&
      preloaded.agentOrgId === input.args.orgId
    ) {
      return {
        agentId,
        agentOrgId: preloaded.agentOrgId,
        agentOwner: preloaded.ownerUserId,
      };
    }
    const [row] = await input.timing.measure(
      "api_dispatch_resolve_agent_execution_lookup_agent",
      "nested",
      async () => {
        return await input.db
          .select({
            agentId: agents.id,
            agentOrgId: agents.orgId,
            agentOwner: agents.owner,
          })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
      },
    );
    return row;
  });
}

function createRunSessionSnapshotObject(
  input$: RunContextInputObject,
  options$: AsyncRead<ReturnType<typeof agentRunResolutionOptions>>,
) {
  return computed(
    async (get): Promise<ChatThreadExecutionSnapshot | undefined> => {
      const input = await get(input$);
      const options = await get(options$);
      const agentSessionId = initialRunBody(input.args).sessionId;
      if (
        options.testOnlyResolveDirectRun ||
        !agentSessionId ||
        options.productAgentExecutionPlan?.identity === "no-agent"
      ) {
        return undefined;
      }
      if (options.sessionSnapshot) {
        return options.sessionSnapshot;
      }
      const {
        db,
        args: { userId, orgId },
      } = input;
      const [snapshot] = await input.timing.measure(
        "api_dispatch_resolve_agent_execution_lookup_session_snapshot",
        "nested",
        async () => {
          return await db
            .select({
              session: {
                id: agentSessions.id,
                agentId: agentSessions.agentId,
                conversationId: agentSessions.conversationId,
                storageMounts: agentSessions.storageMounts,
              },
              agent: {
                id: agents.id,
                orgId: agents.orgId,
                owner: agents.owner,
              },
              conversation: {
                id: conversations.id,
                runId: conversations.runId,
                cliAgentType: conversations.cliAgentType,
                cliAgentSessionId: conversations.cliAgentSessionId,
                cliAgentSessionHistory: conversations.cliAgentSessionHistory,
                cliAgentSessionHistoryHash:
                  conversations.cliAgentSessionHistoryHash,
              },
              historyBlob: {
                hash: blobs.hash,
                encoding: blobs.encoding,
              },
              previousRun: {
                id: agentRuns.id,
                vars: agentRuns.vars,
                storageMounts: agentRuns.storageMounts,
                selectedModel: agentRuns.selectedModel,
              },
            })
            .from(agentSessions)
            .leftJoin(agents, eq(agentSessions.agentId, agents.id))
            .leftJoin(
              conversations,
              eq(agentSessions.conversationId, conversations.id),
            )
            .leftJoin(
              blobs,
              eq(conversations.cliAgentSessionHistoryHash, blobs.hash),
            )
            .leftJoin(agentRuns, eq(conversations.runId, agentRuns.id))
            .where(
              and(
                eq(agentSessions.id, agentSessionId),
                eq(agentSessions.userId, userId),
                eq(agentSessions.orgId, orgId),
              ),
            )
            .limit(1);
        },
      );
      return snapshot;
    },
  );
}

export async function resolveAgentExecution(
  db: ReadonlyDb,
  body: CreateRunBody,
  userId: string,
  orgId: string,
  options: ResolveAgentExecutionOptions,
): Promise<ResolvedRunExecution | CreateRunErrorResult> {
  const testOnlyResolver = options.testOnlyResolveDirectRun;
  if (testOnlyResolver) {
    if (!body.sessionId && !body.agentId) {
      return badRequestMessage("Missing agentId or sessionId");
    }
    const resolved = await measureApiDispatchTiming(
      options.timing,
      body.sessionId
        ? "api_dispatch_resolve_agent_execution_by_session_id"
        : "api_dispatch_resolve_agent_execution_by_agent_id",
      "nested",
      async () => {
        return await testOnlyResolver({
          db,
          body,
          userId,
          orgId,
          timing: options.timing,
        });
      },
    );
    if (!isRouteError(resolved) && options.resetNativeSession) {
      return {
        ...resolved,
        agentId: body.agentId ?? resolved.agentId,
        resumeSession: undefined,
        resumeSessionIdentity: undefined,
        previousRunStorageMounts: undefined,
        vars: undefined,
      };
    }
    return requireResolvedAgentIdMatch(resolved, body.agentId);
  }

  return await resolveProductAgentExecution(body, userId, orgId, options);
}

function prepareLaunchRunIdentity(args: {
  readonly resolved: ResolvedRunExecution;
}): LaunchRunIdentity {
  return {
    runId: randomUUID(),
    sessionId: args.resolved.agentSessionId ?? randomUUID(),
    shouldCreateSession: !args.resolved.agentSessionId,
  };
}

async function prepareRunCallbackRows(args: {
  readonly runId: string;
  readonly callbacks: readonly RunCallback[] | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<readonly AgentRunCallbackInsert[]> {
  const callbacks = args.callbacks ?? [];
  const internalCallbackCount = callbacks.filter((callback) => {
    return "internalKind" in callback;
  }).length;
  return await args.timing.measure(
    "api_dispatch_prepare_run_callbacks",
    "nested",
    async () => {
      return await Promise.all(
        callbacks.map(async (callback): Promise<AgentRunCallbackInsert> => {
          if ("internalKind" in callback) {
            return {
              runId: args.runId,
              url: null,
              internalKind: callback.internalKind,
              encryptedSecret: null,
              payload: callback.payload,
            };
          }
          return {
            runId: args.runId,
            url: callback.url,
            internalKind: null,
            encryptedSecret: await encryptPersistentSecretValue(
              callback.secret,
              args.featureSwitchContext,
            ),
            payload: callback.payload,
          };
        }),
      );
    },
    {
      run_callback_internal_count_bucket: countBucket(internalCallbackCount),
      run_callback_http_count_bucket: countBucket(
        callbacks.length - internalCallbackCount,
      ),
    },
  );
}

function createPrepareCallbacksCommand(
  callbackInputs$?: SelectedAgentRunGraphSources["callbackInputs$"],
) {
  return command(
    async (
      { get },
      args: Parameters<typeof prepareRunCallbackRows>[0],
      signal: AbortSignal,
    ): Promise<readonly AgentRunCallbackInsert[]> => {
      const callbacks = callbackInputs$
        ? await get(callbackInputs$)
        : args.callbacks;
      signal.throwIfAborted();
      const rows = await prepareRunCallbackRows({ ...args, callbacks });
      signal.throwIfAborted();
      return rows;
    },
  );
}

function createPiMemoryRecallSelectionObject(
  input$: Computed<PreparePiLaunchResourcesArgs>,
) {
  return computed(async (get) => {
    const args = get(input$);
    const { metadata } = await args.storagePlan;
    const currentMemoryMount = canonicalPiMemoryMount(metadata.storageMounts);
    const persistedMemoryMount = canonicalPiMemoryMount(
      metadata.persistedStorageMounts,
    );
    if (
      args.chatThreadId === undefined ||
      currentMemoryMount === undefined ||
      persistedMemoryMount === undefined ||
      persistedMemoryMount.storageId !== currentMemoryMount.storageId ||
      persistedMemoryMount.version !== currentMemoryMount.versionId
    ) {
      return { kind: "unavailable" as const };
    }
    const identity = {
      memoryStorageId: currentMemoryMount.storageId,
      storageVersionId: currentMemoryMount.versionId,
    };
    if (!args.piMemoryEnabled) {
      return {
        kind: "captured" as const,
        recall: noContentPiMemoryRecall(identity),
        mismatchReason: undefined,
      };
    }
    const prior = priorPiMemoryRecall({
      currentMemoryMount,
      previousRunStorageMounts: args.previousRunStorageMounts,
      persistedStorageMounts: metadata.persistedStorageMounts,
    });
    return prior === undefined
      ? {
          kind: "projection" as const,
          identity,
          input: {
            db: args.db,
            args: { orgId: args.orgId, userId: args.userId, ...identity },
          },
        }
      : { kind: "captured" as const, ...prior };
  });
}

function createPiMemoryRecallObjects(
  input$: Computed<PreparePiLaunchResourcesArgs>,
) {
  const selection$ = createPiMemoryRecallSelectionObject(input$);
  const projectionInput$ = computed(
    async (get): Promise<MemorySummaryProjectionReadInput | undefined> => {
      const selection = await get(selection$);
      return selection.kind === "projection" ? selection.input : undefined;
    },
  );
  const { projection$ } =
    createMemorySummaryProjectionObjects(projectionInput$);
  const resolvePiMemoryRecall$ = command(
    async (
      { get },
      signal: AbortSignal,
    ): Promise<PiMemoryRecallSelection | undefined> => {
      const selection = await get(selection$);
      signal.throwIfAborted();
      if (selection.kind === "unavailable") {
        return undefined;
      }
      if (selection.kind === "captured") {
        if (selection.mismatchReason) {
          L.error("Pi memory recall epoch did not match the pinned mount", {
            memoryStorageId: selection.recall.memoryStorageId,
            storageVersionId: selection.recall.storageVersionId,
            reason: selection.mismatchReason,
          });
        }
        return selection.recall;
      }
      const projection = await get(projection$);
      signal.throwIfAborted();
      if (projection?.unavailableReason) {
        L.warn("Pi memory summary projection is not ready", {
          ...selection.identity,
          reason: projection.unavailableReason,
        });
      }
      const ready = projection?.ready;
      return ready
        ? piMemoryRecallSelectionSchema.parse({
            status: "ready",
            ...selection.identity,
            ...ready,
          })
        : noContentPiMemoryRecall(selection.identity);
    },
  );
  return { resolvePiMemoryRecall$ };
}

function createPreparePiLaunchResourcesCommand() {
  const internalInput$ = state<PreparePiLaunchResourcesArgs | null>(null);
  const input$ = computed((get) => {
    const input = get(internalInput$);
    if (!input) {
      throw new Error("Pi launch resources have no captured input");
    }
    return input;
  });
  const { resolvePiMemoryRecall$ } = createPiMemoryRecallObjects(input$);
  return command(
    async (
      { set },
      args: PreparePiLaunchResourcesArgs,
      signal: AbortSignal,
    ): Promise<PreparedPiLaunchResources | undefined> => {
      if (args.piSandbox === undefined) {
        return undefined;
      }
      set(internalInput$, args);
      const piSandbox = args.piSandbox;
      const threadless = args.chatThreadId === undefined;
      const sessionId = args.chatThreadId ?? args.runId;
      const observe = piPreparationObserver(args.runId);
      const finish = startPiPreparationObservation(observe, "launch", signal);
      const result = await onRejection(
        measureApiDispatchTiming(
          args.timing,
          "api_dispatch_prepare_pi_launch_resources",
          "nested",
          async () => {
            const resumeSessionPromise = threadless
              ? Promise.resolve(undefined)
              : measureApiDispatchTiming(
                  args.timing,
                  "api_dispatch_prepare_pi_launch_resume_session",
                  "nested",
                  async () => {
                    return await measurePiPreparation(
                      observe,
                      "launch_resume",
                      () => {
                        return Promise.resolve(args.resumeSession);
                      },
                      signal,
                    );
                  },
                );
            const memoryPromise = (async () => {
              // Both request and canonical session writeback ownership/version and
              // overlay order are final before recall can observe this attempt.
              await args.storagePlan;
              signal.throwIfAborted();
              const memoryRecall = threadless
                ? undefined
                : await measurePiPreparation(
                    observe,
                    "launch_memory",
                    () => {
                      return set(resolvePiMemoryRecall$, signal);
                    },
                    signal,
                  );
              return { memoryRecall };
            })();
            const [resumeSession, { memoryRecall }] = await Promise.all([
              resumeSessionPromise,
              memoryPromise,
            ]);
            signal.throwIfAborted();
            return measurePiPreparationSync(
              observe,
              "launch_identity",
              () => {
                return assemblePiLaunchResources({
                  modelConfig: piSandbox,
                  piLaunchConfig: args.piLaunchConfig,
                  memoryRecall,
                  resumeSession,
                  sessionId,
                });
              },
              signal,
            );
          },
        ),
        () => {
          finish("error");
        },
      );
      signal.throwIfAborted();
      finish("success");
      return result;
    },
  );
}

function runnerStorageInput(
  db: Db,
  args: BuildRunnerJobPayloadInput,
  checkpointArtifacts: BuildRunnerJobPayloadInput["artifacts"],
  body: ReturnType<typeof preparedRunnerJobBody>,
  stats: StorageManifestBuildStats,
): AgentRunStorageInput {
  return args.capturedStorageMounts
    ? {
        kind: "captured",
        args: {
          db,
          mounts: args.capturedStorageMounts,
          timing: args.timing,
          stats,
        },
      }
    : {
        kind: "requested",
        args: {
          db,
          content: args.resolved.content,
          vars: body.vars,
          agentOrgId: args.resolved.orgId,
          runtimeOrgId: args.orgId,
          userId: args.userId,
          artifacts: checkpointArtifacts,
          volumeVersionOverrides: body.volumeVersions,
          additionalVolumes: args.additionalVolumes,
          additionalVolumeSources: args.additionalVolumeSources,
          framework: args.launchSnapshot.framework,
          persistedStorageMounts: args.resolved.persistedStorageMounts,
          timing: args.timing,
          stats,
        },
      };
}

const prepareStorageInput$ = command(
  async (
    _store,
    input: StorageMaterializationInput,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof prepareRunnerStorageInput>> => {
    signal.throwIfAborted();
    // Token generation is owned by this command; the storage read graph only
    // needs the original vars and volume versions, never the random token.
    return await Promise.resolve(prepareRunnerStorageInput(input));
  },
);

function createStoragePreparationObjects(
  internalInput$: State<StorageMaterializationInput | null>,
) {
  const storageInput$ = computed((get) => {
    const input = get(internalInput$);
    if (!input) {
      throw new Error("Storage preparation input is not installed");
    }
    return runnerStorageInput(
      input.db,
      input.args,
      runnerCheckpointArtifacts(input.args),
      input.args.body,
      input.storageManifestStats,
    );
  });
  return createAgentRunStorageObjects(storageInput$);
}

const prepareStoredContextDraft$ = command(
  async (
    _store,
    inputPromise: Promise<ReturnType<typeof prepareRunnerStorageInput>>,
    signal: AbortSignal,
  ): Promise<BuiltStoredExecutionContextDraft> => {
    const { args, body, platformEnvironment } = await inputPromise;
    signal.throwIfAborted();
    // KMS key generation belongs to this explicit resource command, not a
    // computed read. It can run alongside the independent storage plan.
    const context = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_build_stored_execution_context",
      "nested",
      async () => {
        const executionSecrets = buildStoredExecutionSecrets({
          connectorContext: args.connectorContext,
          modelProvider: args.modelProvider,
          bodySecrets: body.secrets,
          customConnectorContext: args.customConnectorContext,
        });
        const encryptedSecrets = await encryptPersistentSecretsMap(
          executionSecrets.secrets ?? null,
          args.featureSwitchContext,
        );
        signal.throwIfAborted();
        return buildStoredExecutionContextDraft(
          {
            ...args,
            body,
            platformEnvironment: withPaidToolPlatformEnvironment(
              args,
              platformEnvironment,
            ),
            runId: args.run.id,
          },
          encryptedSecrets,
        );
      },
    );
    signal.throwIfAborted();
    return context;
  },
);

function createMaterializeStorageCommand(
  storagePlan$: Computed<Promise<AgentRunStoragePlan>>,
  materializeAgentRunStorage$: ReturnType<
    typeof createAgentRunStorageObjects
  >["materializeAgentRunStorage$"],
) {
  const preparePiLaunchResources$ = createPreparePiLaunchResourcesCommand();
  return command(
    async (
      { get, set },
      inputPromise: Promise<ReturnType<typeof prepareRunnerStorageInput>>,
      signal: AbortSignal,
    ): Promise<MaterializedRunnerStorage> => {
      const [input, plan] = await Promise.all([
        inputPromise,
        get(storagePlan$),
      ]);
      signal.throwIfAborted();
      const { db, args } = input;
      const storageManifestStats =
        plan.requested.input.stats ?? input.storageManifestStats;
      const preparedStorage = await measureApiDispatchTiming(
        args.timing,
        "api_dispatch_prepare_storage_manifest",
        "nested",
        async () => {
          return await set(materializeAgentRunStorage$, plan, signal);
        },
        () => {
          return storageManifestStats.overallDimensions();
        },
      );
      signal.throwIfAborted();
      const piResources =
        args.deferredPiResources ??
        (await set(
          preparePiLaunchResources$,
          {
            db,
            orgId: args.orgId,
            userId: args.userId,
            piMemoryEnabled: isFeatureEnabled(
              FeatureSwitchKey.PiMemory,
              args.featureSwitchContext,
            ),
            runId: args.run.id,
            resumeSession:
              args.resolved.resumeSessionIdentity?.cliAgentType === "pi"
                ? args.resolved.resumeSession
                : undefined,
            storagePlan: Promise.resolve(preparedStorage.resolved),
            previousRunStorageMounts: args.resolved.previousRunStorageMounts,
            piSandbox: args.piSandbox,
            chatThreadId: args.chatThreadId,
            piLaunchConfig: args.piLaunchConfig,
            timing: args.timing,
          },
          signal,
        ));
      return { input, preparedStorage, piResources };
    },
  );
}

function createStorageMaterializationObjects(
  storage?: ReturnType<typeof createAgentRunStorageObjects>,
) {
  const internalStorageInput$ = state<StorageMaterializationInput | null>(null);
  const { storagePlan$, materializeAgentRunStorage$ } =
    storage ?? createStoragePreparationObjects(internalStorageInput$);
  const initializeStorageInput$ = command(
    (
      { set },
      args: Omit<StorageMaterializationInput, "storageManifestStats">,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const input = {
        ...args,
        storageManifestStats: new StorageManifestBuildStats(),
      };
      set(internalStorageInput$, input);
      return input;
    },
  );
  const materializeStorage$ = createMaterializeStorageCommand(
    storagePlan$,
    materializeAgentRunStorage$,
  );
  return { initializeStorageInput$, storagePlan$, materializeStorage$ };
}

async function persistAtomicLaunchRows(
  args: PersistAtomicLaunchRowsArgs,
): Promise<PersistedAtomicLaunchRows> {
  const capabilities = args.commit.enforceBuiltInCredits
    ? await loadOrgPlanCapabilities(args.tx, args.commit.createArgs.orgId, {
        forUpdate: true,
      })
    : null;
  const creditAdmitted =
    args.commit.enforceBuiltInCredits &&
    isFreePlanForCreditAdmission(capabilities?.planKey);
  if (args.commit.createArgs.threadSessionResolution?.resetNativeSession) {
    await args.tx
      .update(agentSessions)
      .set({
        agentId: args.commit.context.resolved.agentId,
        conversationId: null,
        storageMounts: [...args.commit.launch.sessionStorageMounts],
      })
      .where(eq(agentSessions.id, args.commit.identity.sessionId));
  }
  const context = buildAtomicLaunchCteContext(args, creditAdmitted);
  const persisted = await args.commit.timing.measure(
    "api_dispatch_persist_atomic_launch",
    "nested",
    async () => {
      return await persistPendingAtomicLaunch(args, context);
    },
  );
  await args.commit.createArgs.persistProducerRunBinding?.(args.tx, {
    runId: persisted.run.id,
    status: "pending",
  });

  observePreparedLaunchPersistenceForTest(
    args.commit.createArgs.agentRunMetadata?.workflowAutomationId,
  );

  const chatThreadId = args.commit.createArgs.chatThreadId;
  if (chatThreadId && !args.validatedThreadSession) {
    const threadSessionBinding = await persistThreadSessionBinding(args.tx, {
      chatThreadId,
      identity: context.rowsArgs.identity,
      resolution: args.commit.createArgs.threadSessionResolution,
      timing: args.commit.timing,
    });
    return { ...persisted, threadSessionBinding };
  }
  return persisted;
}

async function resolveQueueFirstAdmissionForLaunch(args: {
  readonly tx: DbTransaction;
  readonly createArgs: PendingRunArguments;
  readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<QueueFirstRunAdmission | undefined> {
  const association = args.createArgs.queueFirstAssociation;
  if (!association) {
    return undefined;
  }
  if (association.threadId !== args.createArgs.chatThreadId) {
    throw new Error("Queue-first association must match the run chat thread");
  }
  return await resolveQueueFirstRunAdmission(args.tx, {
    association,
    sessionSnapshotState: args.sessionSnapshotState,
    timing: args.timing,
  });
}

async function claimQueueFirstAssociationForLaunch(args: {
  readonly tx: DbTransaction;
  readonly admission: QueueFirstRunAdmission | undefined;
  readonly createArgs: PendingRunArguments;
  readonly identity: LaunchRunIdentity;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<QueueFirstRunClaimResult | undefined> {
  const association = args.createArgs.queueFirstAssociation;
  if (!association) {
    return undefined;
  }
  if (!args.admission) {
    throw new Error("Queue-first claim requires resolved thread admission");
  }
  if (!args.createArgs.agentRunModelPin) {
    throw new Error("Queue-first claim requires a run model pin");
  }
  return await claimQueueFirstRunAssociation(args.tx, {
    ...association,
    admission: args.admission,
    runId: args.identity.runId,
    selectedModel: args.createArgs.agentRunModelPin.selectedModel,
    ...(args.createArgs.codexServiceTier
      ? {
          serviceTier:
            args.createArgs.codexServiceTier === "fast"
              ? ("priority" as const)
              : ("ultrafast" as const),
        }
      : {}),
    timing: args.timing,
  });
}

async function activatePreparedLaunchUsageAllowance(args: {
  readonly tx: DbTransaction;
  readonly commit: PreparedCommitPreparedLaunchArgs;
  readonly run: RunRecord;
}): Promise<void> {
  if (isBuiltInModelProviderType(args.commit.context.modelProvider?.type)) {
    await args.commit.admissionTiming.measureLeaf("usage_allowance", () => {
      return args.commit.timing.measure(
        "api_dispatch_activate_usage_allowance_windows",
        "nested",
        async () => {
          await activateUsageAllowanceWindowsForRun(args.tx, {
            orgId: args.commit.createArgs.orgId,
            runId: args.run.id,
            runCreatedAt: args.run.createdAt,
          });
        },
      );
    });
  }
}

async function commitPendingPreparedLaunch(
  tx: DbTransaction,
  args: PreparedCommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  queueFirstClaim: QueueFirstRunClaimed | undefined,
  admission: ValidatedPreparedLaunchAdmission,
): Promise<Extract<AtomicLaunchCommitResult, { readonly kind: "pending" }>> {
  const persisted = await args.admissionTiming.measureLeaf(
    "persistence",
    () => {
      return persistAtomicLaunchRows({
        tx,
        commit: args,
        payload,
        ...admission,
      });
    },
  );
  await activatePreparedLaunchUsageAllowance({
    tx,
    commit: args,
    run: persisted.run,
  });
  return {
    ...persisted,
    runnerJobPayload: payload,
    runContextSnapshot: args.launch.runContextSnapshot,
    queueFirstClaim,
  };
}

async function commitPreparedLaunchAdmission(
  tx: DbTransaction,
  args: PreparedCommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
): Promise<AtomicLaunchCommitResult | CreateRunErrorResult> {
  const validateOfficialAdmission = () => {
    return args.timing.measure(
      "api_dispatch_validate_official_workflow_admission",
      "nested",
      async () => {
        return await validateOfficialWorkflowRunForInsert(tx, {
          observation: args.context.officialWorkflowRun,
          orgId: args.createArgs.orgId,
          userId: args.createArgs.userId,
          agentId: args.context.resolved.agentId,
          automationId: args.createArgs.agentRunMetadata?.workflowAutomationId,
          runStorageMounts: args.launch.runStorageMounts,
          allowMissingMountsForFailedRun: false,
        });
      },
    );
  };
  const officialAdmissionFailure = args.context.officialWorkflowRun
    ? await args.admissionTiming.measureLeaf(
        "official_workflow",
        validateOfficialAdmission,
      )
    : await validateOfficialAdmission();
  if (officialAdmissionFailure) {
    return conflict(officialAdmissionFailure.message);
  }
  const validateThreadSession = () => {
    return validateThreadSessionSnapshot(tx, {
      createArgs: args.createArgs,
      identity: args.identity,
      timing: args.timing,
    });
  };
  const threadSessionValidation = args.createArgs.chatThreadId
    ? await args.admissionTiming.measureLeaf(
        "thread_session",
        validateThreadSession,
      )
    : await validateThreadSession();
  let capturedIdentity: string | null = null;
  const failure = await validateCapturedSubscriptionAccount(tx, args);
  if (failure && "identity" in failure) {
    capturedIdentity = failure.identity;
  } else if (failure) {
    return failure;
  }
  return await commitValidatedPreparedLaunch(
    tx,
    args,
    payload,
    threadSessionValidation,
    capturedIdentity,
  );
}

async function commitValidatedPreparedLaunch(
  tx: DbTransaction,
  args: PreparedCommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  threadSessionValidation: Awaited<
    ReturnType<typeof validateThreadSessionSnapshot>
  >,
  validatedAccountIdentity: string | null,
): Promise<AtomicLaunchCommitResult | CreateRunErrorResult> {
  const validatedThreadSession = threadSessionValidation;

  const queueFirstClaim = args.createArgs.queueFirstAssociation
    ? await args.admissionTiming.measureLeaf("queue_first", async () => {
        const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
          tx,
          createArgs: args.createArgs,
          sessionSnapshotState: validatedThreadSession
            ? "current"
            : "unvalidated",
          timing: args.timing,
        });
        return await claimQueueFirstAssociationForLaunch({
          tx,
          admission: queueFirstAdmission,
          createArgs: args.createArgs,
          identity: args.identity,
          timing: args.timing,
        });
      })
    : undefined;
  if (queueFirstClaim?.kind === "lost") {
    return { kind: "queue-first-claim-lost" };
  }
  return await commitPendingPreparedLaunch(tx, args, payload, queueFirstClaim, {
    validatedThreadSession,
    validatedAccountIdentity,
  });
}

/**
 * The admitted launch transaction's tail. The active-row insert must stay the
 * transaction's last statement: the per-thread admission index makes it wait
 * on another transaction's uncommitted release of the same thread, which must
 * not then need a lock this transaction already owns.
 */
async function finishAdmittedLaunch(
  tx: DbTransaction,
  args: PreparedCommitPreparedLaunchArgs,
  run: RunRecord,
): Promise<void> {
  // The unique chat_thread_id row is the thread's active-run lock. A conflict
  // rolls the whole launch back when another run already owns the thread.
  await tx.insert(activeAgentRuns).values({
    runId: run.id,
    orgId: args.createArgs.orgId,
    userId: args.createArgs.userId,
    chatThreadId: args.createArgs.chatThreadId ?? null,
    lastHeartbeatAt: run.createdAt,
  });
}

/**
 * Official admission takes the credit plan before Workflow/Automation rows,
 * matching reconciliation and plan changes. Persistence rereads the same plan
 * without changing the lock order.
 */
async function lockOfficialWorkflowLaunchPlan(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
): Promise<void> {
  if (!args.context.officialWorkflowRun || !args.enforceBuiltInCredits) {
    return;
  }
  await loadOrgPlanCapabilities(tx, args.createArgs.orgId, {
    forUpdate: true,
  });
}

async function commitPreparedLaunch(
  args: CommitPreparedLaunchArgs,
): Promise<AtomicLaunchCommitCompletion> {
  const persistence = await args.timing.measure(
    "api_dispatch_prepare_atomic_launch_persistence",
    "nested",
    () => {
      return Promise.resolve(prepareAtomicLaunchPersistence(args));
    },
  );
  const preparedArgs = {
    ...args,
    persistence,
  };
  const admissionTiming = new AdmissionAttemptTiming({
    runId: preparedArgs.identity.runId,
    runnerGroup: preparedArgs.launch.runnerJobPayload.runnerGroup,
    profile: preparedArgs.launch.runnerJobPayload.profile,
    dimensions: timingDimensionsForCreateArgs(preparedArgs.createArgs),
    ...(preparedArgs.context.body.triggerSource
      ? { triggerSource: preparedArgs.context.body.triggerSource }
      : {}),
  });
  const committed = await preparedArgs.db.transaction(async (tx) => {
    admissionTiming.transactionStarted();
    const attemptArgs: PreparedCommitPreparedLaunchArgs = {
      ...preparedArgs,
      admissionTiming,
    };
    const result = await (async () => {
      const payload = preparedArgs.persistence.payload;
      await acquireOfficialWorkflowRunCatalogAdmissionLock(
        tx,
        preparedArgs.context.officialWorkflowRun,
      );
      await lockOfficialWorkflowLaunchPlan(tx, preparedArgs);
      admissionTiming.admissionStarted();
      const result = await commitPreparedLaunchAdmission(
        tx,
        attemptArgs,
        payload,
      );
      if ("kind" in result && result.kind === "pending") {
        await finishAdmittedLaunch(tx, attemptArgs, result.run);
      }
      return result;
    })();
    admissionTiming.callbackFinished();
    return result;
  });
  const transactionReturnedAt = now();
  await admissionTiming.finish(admissionAttemptOutcome(committed));
  return { result: committed, transactionReturnedAt };
}

async function resolveRunModelProvider(
  db: ReadonlyDb,
  args: RunModelProviderArgs,
  options: {
    readonly content: agentRunCreateAgentExecutionConfig;
    readonly framework: SupportedFramework;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly usagePricingResolution: UsagePricingResolution;
  },
): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  const hasFrameworkKey = hasExplicitFrameworkApiKey(
    options.content,
    options.framework,
  );
  const hasProviderOverride =
    args.modelProviderId !== undefined ||
    args.modelProviderCredentialScope !== undefined;
  const shouldResolveModelProvider =
    hasProviderOverride ||
    !hasFrameworkKey ||
    isBuiltInModelProviderType(args.modelProviderType);
  const modelProvider = shouldResolveModelProvider
    ? await resolveModelProviderEnvironment(db, {
        catalog: args.catalog,
        orgId: args.orgId,
        userId: args.userId,
        framework: options.framework,
        modelProviderId: args.modelProviderId,
        modelProviderCredentialScope: args.modelProviderCredentialScope,
        modelProviderType: args.modelProviderType,
        capturedPersonalSubscriptionAccount:
          args.capturedPersonalSubscriptionAccount,
        selectedModelOverride: args.selectedModelOverride,
        builtInModelRuntimeRoute: args.builtInModelRuntimeRoute,
        piExecution: args.piExecution,
        retainedRunId: args.retainedRunId,
        featureSwitchContext: options.featureSwitchContext,
        newRunPricing: {
          serviceTier: args.codexServiceTier,
          resolution: options.usagePricingResolution,
        },
      })
    : null;

  if (!shouldResolveModelProvider || modelProvider) {
    return modelProvider;
  }

  // A new Built-in run whose every executable candidate lacks usage pricing
  // is rejected as unbillable, not as an unconfigured provider.
  if (
    isBuiltInModelProviderType(args.modelProviderType) &&
    !args.builtInModelRuntimeRoute
  ) {
    const selectedModel =
      args.selectedModelOverride ?? args.catalog.systemDefaultModel;
    const unpriced = unpricedBuiltInModelMessage(
      args.catalog,
      selectedModel,
      await loadBuiltInRoutePricing(db, {
        catalog: args.catalog,
        model: selectedModel,
        serviceTier: args.codexServiceTier,
        resolution: options.usagePricingResolution,
      }),
    );
    if (unpriced) {
      return providerUnavailable(unpriced);
    }
  }

  return providerUnavailable(
    `No model provider configured and ${frameworkApiKeyEnv(options.framework)} is not declared in compose environment`,
  );
}

export function agentRunResolutionOptions(
  args: CreateAgentRunArgs,
): Pick<
  ResolveAgentExecutionOptions,
  | "productAgentExecutionPlan"
  | "testOnlyResolveDirectRun"
  | "preloadedAgentExecutionObservation"
  | "resetNativeSession"
  | "sessionSnapshot"
> {
  const productAgentExecutionPlan = args.productAgentExecutionPlan;
  const testOnlyResolveDirectRun = args.testOnlyResolveDirectRun;
  if (
    productAgentExecutionPlan === undefined &&
    testOnlyResolveDirectRun === undefined
  ) {
    throw new Error(
      "Product Agent execution plan is required for Agent run preparation",
    );
  }
  if (
    productAgentExecutionPlan !== undefined &&
    testOnlyResolveDirectRun !== undefined
  ) {
    throw new Error(
      "Agent run preparation cannot mix product and direct-run resolution",
    );
  }
  if (
    productAgentExecutionPlan?.identity === "no-agent" &&
    (args.body.agentId !== undefined ||
      args.body.sessionId !== undefined ||
      args.chatThreadId !== undefined)
  ) {
    throw new Error(
      "Runs without an agent must start a new threadless session",
    );
  }
  return {
    productAgentExecutionPlan,
    testOnlyResolveDirectRun,
    preloadedAgentExecutionObservation: args.preloadedAgentExecutionObservation,
    resetNativeSession: args.threadSessionResolution?.resetNativeSession,
    sessionSnapshot: args.threadSessionResolution?.executionSnapshot,
  };
}

export async function resolvePreparedRunModelProvider(args: {
  readonly db: ReadonlyDb;
  readonly createArgs: RunModelProviderArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly bodyContext: Pick<
    PreparedRunBodyContext,
    "requestedFramework" | "featureSwitchContext"
  > & { readonly content: agentRunCreateAgentExecutionConfig };
  readonly usagePricingResolution: UsagePricingResolution;
}): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  const { content, requestedFramework, featureSwitchContext } =
    args.bodyContext;
  const testHold = observeRunContextParallelStage(
    "model-provider",
    args.createArgs,
  );
  if (testHold) {
    await testHold;
  }
  return await args.timing.measure(
    "api_dispatch_prepare_context_resolve_model_provider",
    "nested",
    async () => {
      return await resolveRunModelProvider(args.db, args.createArgs, {
        content,
        framework: requestedFramework,
        featureSwitchContext,
        usagePricingResolution: args.usagePricingResolution,
      });
    },
  );
}

type RunPreparedConnectorInputsObject = Computed<
  Promise<RunPreparedConnectorInputs | CreateRunErrorResult>
>;

function createRunConnectorEagerSecretPlanObject(
  inputs$: RunPreparedConnectorInputsObject,
) {
  const permissionManifest$ = computed(async (get) => {
    const input = await get(inputs$);
    return isRouteError(input)
      ? input
      : await input.timing.measure(
          "api_dispatch_prepare_context_build_permission_manifest",
          "nested",
          async () => {
            return await buildPreparedPermissionManifest(input);
          },
        );
  });
  return computed(async (get) => {
    const [input, permissionManifest] = await Promise.all([
      get(inputs$),
      get(permissionManifest$),
    ]);
    if (isRouteError(input)) {
      return input;
    }
    if (isRouteError(permissionManifest)) {
      return permissionManifest;
    }
    const snapshot = input.storedConnectorSnapshot;
    const connectorContext =
      storedConnectorExecutionContextFromSnapshot(snapshot);
    const eagerInputs = eagerStoredConnectorSecretInputs({
      content: input.content,
      modelProvider: input.modelProvider,
      connectorContext,
    });
    const names = snapshot
      ? eagerStoredConnectorSecretNames({
          snapshot,
          referencedEnvironmentSecretAliases:
            eagerInputs.referencedEnvironmentSecretAliases,
          storedEnvironment: eagerInputs.eagerStoredEnvironment,
          environmentSecretPlaceholders:
            permissionManifest?.environmentSecretPlaceholders,
          overriddenSecretAliases: overriddenRuntimeSecretAliases([
            input.modelProvider?.secrets,
            input.modelProvider?.secretConnectorMap,
            input.body.secrets,
          ]),
        })
      : new Set<string>();
    return {
      input,
      connectorContext,
      permissionManifest,
      names,
      bindingSets:
        snapshot?.bindingSets.filter((bindingSet) => {
          return !bindingSet.isMcp;
        }) ?? [],
      timingDimensions: storedConnectorTimingDimensions({
        scopeSource: input.connectorScope.source,
        connectorCount: snapshot?.allowedConnectorRows.length ?? 0,
      }),
    };
  });
}

function createRunConnectorEncryptedRowsObject(
  plan$: ReturnType<typeof createRunConnectorEagerSecretPlanObject>,
) {
  return computed(
    async (get): Promise<readonly StoredConnectorEncryptedSecretRow[]> => {
      const plan = await get(plan$);
      if (isRouteError(plan) || plan.names.size === 0) {
        return [];
      }
      const { db } = plan.input;
      const groups = storedConnectorCredentialReadGroups({
        bindingSets: plan.bindingSets,
        kind: "secret",
        names: plan.names,
      });
      return await db
        .select({
          name: secretsTable.name,
          encryptedValue: secretsTable.encryptedValue,
        })
        .from(secretsTable)
        .where(builtinConnectorCredentialSecretReadCondition({ db, groups }));
    },
  );
}

function createRunPreparedConnectorObjects(
  inputs$: RunPreparedConnectorInputsObject,
) {
  const plan$ = createRunConnectorEagerSecretPlanObject(inputs$);
  const encryptedRows$ = createRunConnectorEncryptedRowsObject(plan$);
  const decryptedSecrets$ = computed(async (get) => {
    const [plan, rows] = await Promise.all([get(plan$), get(encryptedRows$)]);
    return isRouteError(plan)
      ? {}
      : await decryptStoredConnectorSecretRows(
          rows,
          {
            featureSwitchContext: plan.input.featureSwitchContext,
            timingDimensions: plan.timingDimensions,
          },
          plan.input.timing,
        );
  });
  const connectorContext$ = computed(
    async (get): Promise<PreparedConnectorContext | CreateRunErrorResult> => {
      const [plan, secrets] = await Promise.all([
        get(plan$),
        get(decryptedSecrets$),
      ]);
      if (isRouteError(plan)) {
        return plan;
      }
      return {
        connectorContext: {
          ...plan.connectorContext,
          secrets: mergeRecords(
            plan.connectorContext.secrets,
            resolveStoredConnectorSecrets(plan.bindingSets, secrets),
          ),
        },
        permissionManifest: plan.permissionManifest,
      };
    },
  );
  return { connectorContext$ };
}
type RunContextInputObject = Computed<
  PrepareRunContextInput | Promise<PrepareRunContextInput>
>;
type AsyncRead<T> = Computed<T | Promise<T>>;

export interface DisabledPaidToolsSnapshot {
  readonly orgId: string;
  readonly userId: string;
  readonly toolIds: readonly string[];
}

export interface RunMemberSnapshot {
  readonly orgId: string;
  readonly userId: string;
  readonly member:
    | Pick<
        typeof orgMembersMetadata.$inferSelect,
        "timezone" | "selectedImageModel"
      >
    | undefined;
}

type RunMemberReadInput = RunResourceScope;
type RunDisabledPaidToolsReadInput = RunResourceScope;

/** Construct the complete read graph once; each input invalidates its own snapshot. */
function createRunIdentityObjects(
  input$: RunContextInputObject,
  shared?: SelectedRunReadObjects,
) {
  const featureSwitchContext$ =
    shared?.featureSwitchContext$ ??
    computed(async (get) => {
      const input = await get(input$);
      const { orgId, userId } = input.args;
      const rows = await input.db
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(
          and(
            eq(userFeatureSwitches.orgId, orgId),
            inArray(userFeatureSwitches.userId, [userId, ORG_SENTINEL_USER_ID]),
          ),
        );
      return {
        orgId,
        userId,
        overrides: userFeatureSwitchOverridesFromRows(rows, userId),
      };
    });
  const resolutionOptions$ = computed(async (get) => {
    return agentRunResolutionOptions((await get(input$)).args);
  });
  const agentObservation$ = createRunAgentObservationObject(
    input$,
    resolutionOptions$,
  );
  const sessionSnapshot$ = createRunSessionSnapshotObject(
    input$,
    resolutionOptions$,
  );
  const execution$ = computed(async (get) => {
    const input = await get(input$);
    const [agentObservation, sessionSnapshot] = await Promise.all([
      get(agentObservation$),
      get(sessionSnapshot$),
    ]);
    return await resolveAgentExecution(
      input.db,
      initialRunBody(input.args),
      input.args.userId,
      input.args.orgId,
      {
        ...(await get(resolutionOptions$)),
        agentObservation,
        sessionSnapshot,
        timing: input.timing,
      },
    );
  });
  const content$ = computed(async (get) => {
    const plan = (await get(resolutionOptions$)).productAgentExecutionPlan;
    if (plan) {
      return plan.content;
    }
    // Direct-compose fixtures own their resolver; production execution plans
    // already carry content and do not wait for a session snapshot here.
    const execution = await get(execution$);
    return isRouteError(execution) ? execution : execution.content;
  });
  return { featureSwitchContext$, execution$, content$ };
}

function createRunBodyObjects(
  input$: RunContextInputObject,
  {
    featureSwitchContext$,
    execution$,
    content$,
  }: ReturnType<typeof createRunIdentityObjects>,
  shared?: SelectedRunReadObjects,
) {
  const environment$ =
    shared?.environment$ ??
    createRunEnvironmentObject(input$, {
      content$,
    });
  const body$ = computed(async (get) => {
    const input = await get(input$);
    const [
      resolved,
      persistedEnvironment,
      featureSwitchContext,
      resolvedEnvironment,
    ] = await Promise.all([
      get(execution$),
      get(environment$),
      get(featureSwitchContext$),
      shared ? get(shared.bodyEnvironment$) : undefined,
    ]);
    if (isRouteError(resolved)) {
      return resolved;
    }
    if (isRouteError(persistedEnvironment)) {
      return persistedEnvironment;
    }
    if (resolved.orgId !== input.args.orgId) {
      return notFound("Resource not found");
    }
    if (
      resolvedEnvironment !== undefined &&
      isRouteError(resolvedEnvironment)
    ) {
      return resolvedEnvironment;
    }
    return await buildResolvedRunBody({
      initialBody: initialRunBody(input.args),
      resolved,
      persistedEnvironment,
      featureSwitchContext,
      canonicalOkouRuntime: input.args.includeOkouTokenSecret === true,
      resolvedEnvironment,
    });
  });
  const framework$ =
    shared?.framework$ ?? createRunFrameworkObject(input$, content$);
  const bodyContext$ = computed(
    async (get): Promise<PreparedRunBodyContext | CreateRunErrorResult> => {
      const input = await get(input$);
      const [resolved, body, requestedFramework, featureSwitchContext] =
        await Promise.all([
          get(execution$),
          get(body$),
          get(framework$),
          get(featureSwitchContext$),
        ]);
      if (isRouteError(resolved)) {
        return resolved;
      }
      if (isRouteError(body)) {
        return body;
      }
      if (isRouteError(requestedFramework)) {
        return requestedFramework;
      }
      return {
        resolved,
        body,
        requestedFramework,
        featureSwitchContext,
        connectorScope: connectorScopeFromCreateArgs(input.args),
      };
    },
  );
  return { bodyContext$, framework$ };
}

async function multiAuthModelProviderEnvironmentFromSnapshot(args: {
  readonly catalog: ModelCatalog;
  readonly id: string | null;
  readonly orgId: string;
  readonly userId: string;
  readonly type: ModelProviderType;
  readonly authMethod: string | null;
  readonly selectedModel: string | null;
  readonly configuredModel?: string | null;
  readonly piExecution?: boolean;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly accountId?: string;
  readonly secretRows: readonly ModelProviderEnvironmentSecret[];
}): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.authMethod) {
    return null;
  }
  const secretConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretConfig) {
    return null;
  }

  const firewall = getModelProviderFirewall(args.type);
  const hasFirewallAuth = firewall !== undefined;
  const needsCodexRoutingAccountId =
    args.type === "codex-oauth-token" && !args.piExecution;
  const secretRows = args.secretRows;
  const storedSecrets: Record<string, string> = {};
  if (hasFirewallAuth) {
    for (const row of secretRows) {
      storedSecrets[row.name] = "__lazy_model_provider_secret__";
    }
  } else {
    for (const row of secretRows) {
      if (row.encryptedValue === null) {
        continue;
      }
      storedSecrets[row.name] = await decryptStoredSecretValue(
        row.encryptedValue,
        args.featureSwitchContext,
      );
    }
  }

  const forwardableSecrets: Record<string, string> = {};
  for (const [secretName, config] of Object.entries(secretConfig)) {
    const value = storedSecrets[secretName];
    if (!value) {
      if (config.required) {
        return null;
      }
      continue;
    }
    if (!config.serverOnly) {
      forwardableSecrets[secretName] = value;
    }
  }

  const selectedModelEnvBindings = getModelProviderEnvBindings(args.type);
  const selectedModel = resolveModelProviderModel({
    type: args.type,
    selectedModel: args.selectedModel,
    defaultModel: getDefaultModel(args.type),
    envBindings: selectedModelEnvBindings,
  });
  const runtimeModel = resolveMultiAuthRuntimeModel(args, selectedModel);
  const environment = providerEnvironmentFromSecretMap(
    args.type,
    forwardableSecrets,
    runtimeModel,
  );
  if (needsCodexRoutingAccountId) {
    const encryptedAccountId = secretRows.find((row) => {
      return row.name === "CHATGPT_ACCOUNT_ID";
    })?.encryptedValue;
    if (!encryptedAccountId) {
      return null;
    }
    // Workspace routing compares this identifier with /wham/accounts/check.
    // It is not an OAuth credential; bearer and refresh tokens remain server-side.
    environment.CODEX_OAUTH_ACCOUNT_ID = await decryptStoredSecretValue(
      encryptedAccountId,
      args.featureSwitchContext,
    );
  }
  const authMaps = modelProviderFirewallAuthMaps(
    args.type,
    args.userId,
    Object.keys(forwardableSecrets),
    args.accountId,
  );
  return {
    id: args.id,
    type: args.type,
    credentialOwner:
      args.userId === ORG_SENTINEL_USER_ID ? "organization" : "member",
    authMethod: args.authMethod,
    environment,
    ...(runtimeModel ? { upstreamModel: runtimeModel } : {}),
    secrets: hasFirewallAuth ? {} : forwardableSecrets,
    selectedModel,
    secretConnectorMap: authMaps?.secretConnectorMap,
    secretConnectorMetadataMap: authMaps?.secretConnectorMetadataMap,
  };
}

export async function customGatewayProviderEnvironmentFromSnapshot(
  args: ResolveModelProviderEnvironmentArgs,
  row: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof createPinnedGatewayProviderSnapshot>["read"]>
    >
  >,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.selectedModelOverride) {
    return null;
  }
  const upstreamModel = row.modelMappings[args.selectedModelOverride];
  const protocol = modelProviderSurfaceProtocolSchema.safeParse(row.protocol);
  if (!protocol.success || !upstreamModel) {
    return null;
  }
  const runtime = compileModelProviderGatewayRuntime({
    surfaceId: row.id,
    protocol: protocol.data,
    apiBaseUrl: row.apiBaseUrl,
    displayName: row.displayName,
    authHeaderName: row.authHeaderName,
    authHeaderTemplate: row.authHeaderTemplate,
    logicalModel: args.selectedModelOverride,
    upstreamModel,
  });
  if (
    getFrameworkForType(runtime.type) !== args.framework ||
    (args.modelProviderType !== undefined &&
      args.modelProviderType !== runtime.type)
  ) {
    return null;
  }

  const secretValue = await decryptStoredSecretValue(
    row.encryptedValue,
    args.featureSwitchContext,
  );
  if (!hasUsableModelProviderSecretValue(secretValue)) {
    return null;
  }
  return {
    id: row.id,
    type: runtime.type,
    credentialOwner: "organization",
    environment: runtime.environment,
    secrets: { [GATEWAY_RUNTIME_SECRET_NAME]: secretValue },
    selectedModel: args.selectedModelOverride,
    firewall: runtime.firewall,
    inlineFirewall: true,
    credentialHeader: {
      name: row.authHeaderName,
      valueTemplate: row.authHeaderTemplate,
    },
    ...(runtime.codexRuntimeConfig
      ? { codexRuntimeConfig: runtime.codexRuntimeConfig }
      : {}),
  };
}

export async function personalProviderEnvironmentFromSnapshot(
  args: ResolveModelProviderEnvironmentArgs,
  account: PersonalModelProviderAccountRow,
  selectedModel: string | null,
  secretRows: readonly ModelProviderEnvironmentSecret[],
): Promise<ResolvedModelProviderEnvironment | null> {
  if (
    !isPersonalSubscriptionProviderType(account.type) ||
    getFrameworkForType(account.type) !== args.framework ||
    (args.modelProviderType !== undefined &&
      args.modelProviderType !== account.type)
  ) {
    return null;
  }

  if (hasAuthMethods(account.type)) {
    return await multiAuthModelProviderEnvironmentFromSnapshot({
      catalog: args.catalog,
      id: account.id,
      orgId: account.orgId,
      userId: account.userId,
      type: account.type,
      authMethod: account.authMethod,
      selectedModel: args.selectedModelOverride ?? selectedModel,
      piExecution: args.piExecution,
      featureSwitchContext: args.featureSwitchContext,
      accountId: account.id,
      secretRows,
    });
  }

  const config = MODEL_PROVIDER_TYPES[account.type];
  if (!isSingleSecretModelProviderConfig(config)) {
    return null;
  }
  const secret = secretRows.find((row) => {
    return row.name === config.secretName;
  });
  if (!secret || secret.encryptedValue === null) {
    return null;
  }

  const hasFirewallAuth = getModelProviderFirewall(account.type) !== undefined;
  const secretValue = hasFirewallAuth
    ? undefined
    : await decryptStoredSecretValue(
        secret.encryptedValue,
        args.featureSwitchContext,
      );
  if (
    secretValue !== undefined &&
    !hasUsableModelProviderSecretValue(secretValue)
  ) {
    return null;
  }
  return modelProviderEnvironment({
    catalog: args.catalog,
    id: account.id,
    type: account.type,
    config,
    secretValue,
    sourceUserId: account.userId,
    sourceId: account.id,
    selectedModel: args.selectedModelOverride ?? selectedModel,
  });
}

type RunModelProviderInputObject = Computed<
  | RunModelProviderReadInput
  | CreateRunErrorResult
  | Promise<RunModelProviderReadInput | CreateRunErrorResult>
>;

function createPinnedProviderReadContext(
  input$: RunModelProviderInputObject,
  { framework$ }: Pick<ReturnType<typeof createRunBodyObjects>, "framework$">,
  {
    content$,
    featureSwitchContext$,
  }: Pick<
    ReturnType<typeof createRunIdentityObjects>,
    "content$" | "featureSwitchContext$"
  >,
) {
  const providerContext$ = computed(async (get) => {
    const input = await get(input$);
    if (isRouteError(input)) {
      return input;
    }
    const [content, requestedFramework, featureSwitchContext] =
      await Promise.all([
        get(content$),
        get(framework$),
        get(featureSwitchContext$),
      ]);
    if (isRouteError(content)) {
      return content;
    }
    if (isRouteError(requestedFramework)) {
      return requestedFramework;
    }
    const args = input.args;
    const hasProviderOverride =
      args.modelProviderId !== undefined ||
      args.modelProviderCredentialScope !== undefined;
    const shouldResolve =
      hasProviderOverride ||
      !hasExplicitFrameworkApiKey(content, requestedFramework) ||
      isBuiltInModelProviderType(args.modelProviderType);
    const environmentArgs: ResolveModelProviderEnvironmentArgs = {
      catalog: args.catalog,
      orgId: args.orgId,
      userId: args.userId,
      framework: requestedFramework,
      modelProviderId: args.modelProviderId,
      modelProviderCredentialScope: args.modelProviderCredentialScope,
      modelProviderType: args.modelProviderType,
      capturedPersonalSubscriptionAccount:
        args.capturedPersonalSubscriptionAccount,
      selectedModelOverride: args.selectedModelOverride,
      builtInModelRuntimeRoute: args.builtInModelRuntimeRoute,
      piExecution: args.piExecution,
      retainedRunId: args.retainedRunId,
      featureSwitchContext,
    };
    return {
      input,
      content,
      requestedFramework,
      featureSwitchContext,
      environmentArgs,
      shouldResolve,
    };
  });
  const pinnedContext$ = computed(async (get) => {
    const context = await get(providerContext$);
    if (
      isRouteError(context) ||
      !context.input.args.queueFirstAssociation ||
      !context.shouldResolve
    ) {
      return null;
    }
    if (context.environmentArgs.retainedRunId) {
      throw new Error("A queued input cannot prepare a retained run provider");
    }
    return context;
  });
  return { providerContext$, pinnedContext$ };
}

function createPinnedBuiltInProviderSnapshot({
  pinnedContext$,
}: ReturnType<typeof createPinnedProviderReadContext>) {
  return computed(
    async (get): Promise<ResolvedModelProviderEnvironment | null> => {
      const context = await get(pinnedContext$);
      if (
        !context ||
        !isBuiltInModelProviderType(context.environmentArgs.modelProviderType)
      ) {
        return null;
      }
      const args = context.environmentArgs;
      const route = args.builtInModelRuntimeRoute;
      if (
        !route ||
        route.selectedModel !== args.selectedModelOverride ||
        !isBuiltInModelRuntimeRoutePermitted(args.catalog, route) ||
        getFrameworkForType(route.providerType) !== args.framework
      ) {
        return null;
      }
      const [key] = await context.input.db
        .select({ apiKey: builtInModelKeys.apiKey })
        .from(builtInModelKeys)
        .where(eq(builtInModelKeys.id, route.modelKeyId))
        .limit(1);
      return key?.apiKey
        ? builtInModelProviderEnvironmentFromSnapshot({
            route,
            selectedModel: route.selectedModel,
            featureSwitchContext: args.featureSwitchContext,
            apiKey: key.apiKey,
          })
        : null;
    },
  );
}

function createPinnedPersonalProviderSnapshot({
  pinnedContext$,
}: ReturnType<typeof createPinnedProviderReadContext>) {
  return computed(async (get) => {
    const context = await get(pinnedContext$);
    const args = context?.environmentArgs;
    if (
      !context ||
      !args?.modelProviderId ||
      !args.modelProviderType ||
      !isPersonalSubscriptionProviderType(args.modelProviderType) ||
      args.modelProviderCredentialScope === "org"
    ) {
      return null;
    }
    const rows = await context.input.db
      .select({
        account: modelProviderAccounts,
        selectedModel: modelProviders.selectedModel,
        secret: {
          name: modelProviderAccountSecrets.name,
          encryptedValue: modelProviderAccountSecrets.encryptedValue,
        },
      })
      .from(modelProviderAccounts)
      .innerJoin(
        modelProviders,
        eq(modelProviderAccounts.modelProviderId, modelProviders.id),
      )
      .leftJoin(
        modelProviderAccountSecrets,
        eq(
          modelProviderAccountSecrets.modelProviderAccountId,
          modelProviderAccounts.id,
        ),
      )
      .where(
        and(
          eq(modelProviderAccounts.id, args.modelProviderId),
          eq(modelProviderAccounts.orgId, args.orgId),
          eq(modelProviderAccounts.userId, args.userId),
          eq(modelProviderAccounts.type, args.modelProviderType),
          isNull(modelProviderAccounts.disconnectedAt),
        ),
      );
    const first = rows[0];
    return first
      ? {
          account: first.account,
          selectedModel: first.selectedModel,
          secrets: rows.flatMap((row) => {
            return row.secret ? [row.secret] : [];
          }),
        }
      : null;
  });
}

function createPinnedGatewayProviderSnapshot({
  pinnedContext$,
}: ReturnType<typeof createPinnedProviderReadContext>) {
  return computed(async (get) => {
    const context = await get(pinnedContext$);
    const args = context?.environmentArgs;
    if (
      !context ||
      !args?.modelProviderId ||
      !args.selectedModelOverride ||
      isBuiltInModelProviderType(args.modelProviderType) ||
      (args.modelProviderType &&
        isPersonalSubscriptionProviderType(args.modelProviderType))
    ) {
      return null;
    }
    const [row] = await context.input.db
      .select({
        id: modelProviderSurfaces.id,
        protocol: modelProviderSurfaces.protocol,
        apiBaseUrl: modelProviderSurfaces.apiBaseUrl,
        authHeaderName: modelProviderSurfaces.authHeaderName,
        authHeaderTemplate: modelProviderSurfaces.authHeaderTemplate,
        modelMappings: modelProviderSurfaces.modelMappings,
        displayName: modelProviderConnections.displayName,
        encryptedValue: secretsTable.encryptedValue,
      })
      .from(modelProviderSurfaces)
      .innerJoin(
        modelProviderConnections,
        eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
      )
      .innerJoin(
        secretsTable,
        eq(modelProviderConnections.secretId, secretsTable.id),
      )
      .where(
        and(
          eq(modelProviderSurfaces.id, args.modelProviderId),
          eq(modelProviderConnections.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

function createPinnedGatewayProviderEnvironment(
  { pinnedContext$ }: ReturnType<typeof createPinnedProviderReadContext>,
  gatewaySnapshot$: ReturnType<typeof createPinnedGatewayProviderSnapshot>,
) {
  return computed(async (get) => {
    const [context, gateway] = await Promise.all([
      get(pinnedContext$),
      get(gatewaySnapshot$),
    ]);
    return context && gateway
      ? await customGatewayProviderEnvironmentFromSnapshot(
          context.environmentArgs,
          gateway,
        )
      : null;
  });
}

export function pinnedProviderSecretProjection(
  type: ModelProviderType,
  hasFirewallAuth: boolean,
  piExecution: ResolveModelProviderEnvironmentArgs["piExecution"],
) {
  if (!hasFirewallAuth) {
    return secretsTable.encryptedValue;
  }
  if (type === "codex-oauth-token" && !piExecution) {
    return sql`CASE WHEN ${secretsTable.name} = 'CHATGPT_ACCOUNT_ID' THEN ${secretsTable.encryptedValue} ELSE NULL END`.mapWith(
      nullableDriverValueDecoder(pgTextDecoder),
    );
  }
  return sql`NULL`.mapWith(pgNullDecoder);
}

function createPinnedRegularProviderSnapshot(
  { pinnedContext$ }: ReturnType<typeof createPinnedProviderReadContext>,
  gatewayEnvironment$: ReturnType<
    typeof createPinnedGatewayProviderEnvironment
  >,
) {
  return computed(async (get) => {
    const [context, gatewayEnvironment] = await Promise.all([
      get(pinnedContext$),
      get(gatewayEnvironment$),
    ]);
    const args = context?.environmentArgs;
    const type = args?.modelProviderType;
    if (
      gatewayEnvironment ||
      !context ||
      !args?.modelProviderId ||
      !type ||
      !isModelProviderType(type) ||
      isBuiltInModelProviderType(type) ||
      (isPersonalSubscriptionProviderType(type) &&
        args.modelProviderCredentialScope !== "org")
    ) {
      return null;
    }
    const multiAuth = hasAuthMethods(type);
    const hasFirewallAuth =
      multiAuth && getModelProviderFirewall(type) !== undefined;
    // The provider row and its cloud resource/region/credential fields share
    // one statement snapshot, including during concurrent settings updates.
    const rows = await context.input.db
      .select({
        provider: {
          id: modelProviders.id,
          type: modelProviders.type,
          userId: modelProviders.userId,
          isDefault: modelProviders.isDefault,
          selectedModel: modelProviders.selectedModel,
          authMethod: modelProviders.authMethod,
        },
        secret: {
          name: secretsTable.name,
          encryptedValue: pinnedProviderSecretProjection(
            type,
            hasFirewallAuth,
            args.piExecution,
          ),
        },
      })
      .from(modelProviders)
      .leftJoin(
        secretsTable,
        multiAuth
          ? and(
              eq(secretsTable.orgId, modelProviders.orgId),
              eq(secretsTable.userId, modelProviders.userId),
              eq(secretsTable.type, "model-provider"),
            )
          : eq(secretsTable.id, modelProviders.secretId),
      )
      .where(
        and(
          eq(modelProviders.id, args.modelProviderId),
          eq(modelProviders.orgId, args.orgId),
          eq(modelProviders.type, type),
          args.modelProviderCredentialScope === "org"
            ? eq(modelProviders.userId, ORG_SENTINEL_USER_ID)
            : args.modelProviderCredentialScope === "member"
              ? eq(modelProviders.userId, args.userId)
              : or(
                  eq(modelProviders.userId, args.userId),
                  eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
                ),
        ),
      );
    const first = rows[0];
    return first
      ? {
          provider: {
            ...first.provider,
            encryptedValue: first.secret?.encryptedValue ?? null,
          },
          secrets: rows.flatMap((row) => {
            return row.secret ? [row.secret] : [];
          }),
        }
      : null;
  });
}

export async function regularProviderEnvironmentFromSnapshot(
  args: ResolveModelProviderEnvironmentArgs,
  snapshot: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof createPinnedRegularProviderSnapshot>["read"]>
    >
  >,
): Promise<ResolvedModelProviderEnvironment | null> {
  const row = snapshot.provider;
  if (
    !isCandidateModelProviderRow(row, args) ||
    getFrameworkForType(row.type) !== args.framework
  ) {
    return null;
  }
  if (hasAuthMethods(row.type)) {
    return await multiAuthModelProviderEnvironmentFromSnapshot({
      catalog: args.catalog,
      id: row.id,
      orgId: args.orgId,
      userId: row.userId,
      type: row.type,
      authMethod: row.authMethod,
      selectedModel: args.selectedModelOverride ?? row.selectedModel,
      configuredModel: row.selectedModel,
      piExecution: args.piExecution,
      featureSwitchContext: args.featureSwitchContext,
      secretRows: snapshot.secrets,
    });
  }
  const config = MODEL_PROVIDER_TYPES[row.type];
  if (!isSingleSecretModelProviderConfig(config) || !row.encryptedValue) {
    return null;
  }
  const piRouteClass = piCatalogModel(
    args.catalog,
    args.selectedModelOverride,
  )?.piRouteClass;
  const captureSecret =
    args.piExecution &&
    (piRouteClass === "claude-native" || piRouteClass === "deepseek");
  if (getModelProviderFirewall(row.type) !== undefined && !captureSecret) {
    return modelProviderEnvironment({
      catalog: args.catalog,
      id: row.id,
      type: row.type,
      config,
      secretValue: undefined,
      sourceUserId: row.userId,
      selectedModel: args.selectedModelOverride ?? row.selectedModel,
    });
  }
  const secretValue = await decryptStoredSecretValue(
    row.encryptedValue,
    args.featureSwitchContext,
  );
  return hasUsableModelProviderSecretValue(secretValue)
    ? modelProviderEnvironment({
        catalog: args.catalog,
        id: row.id,
        type: row.type,
        config,
        secretValue,
        captureSecret,
        sourceUserId: row.userId,
        selectedModel: args.selectedModelOverride ?? row.selectedModel,
      })
    : null;
}

function createPinnedProviderEnvironment(
  { pinnedContext$ }: ReturnType<typeof createPinnedProviderReadContext>,
  snapshots: {
    readonly builtIn$: ReturnType<typeof createPinnedBuiltInProviderSnapshot>;
    readonly personal$: ReturnType<typeof createPinnedPersonalProviderSnapshot>;
    readonly gateway$: ReturnType<
      typeof createPinnedGatewayProviderEnvironment
    >;
    readonly regular$: ReturnType<typeof createPinnedRegularProviderSnapshot>;
  },
) {
  const environment$ = computed(
    async (get): Promise<ResolvedModelProviderEnvironment | null> => {
      const context = await get(pinnedContext$);
      if (!context) {
        return null;
      }
      const args = context.environmentArgs;
      if (isBuiltInModelProviderType(args.modelProviderType)) {
        return await get(snapshots.builtIn$);
      }
      if (
        args.modelProviderType &&
        isPersonalSubscriptionProviderType(args.modelProviderType) &&
        args.modelProviderCredentialScope !== "org"
      ) {
        const personal = await get(snapshots.personal$);
        return personal
          ? await personalProviderEnvironmentFromSnapshot(
              args,
              personal.account,
              personal.selectedModel,
              personal.secrets,
            )
          : null;
      }
      const [gateway, regular] = await Promise.all([
        get(snapshots.gateway$),
        get(snapshots.regular$),
      ]);
      return (
        gateway ??
        (regular
          ? await regularProviderEnvironmentFromSnapshot(args, regular)
          : null)
      );
    },
  );
  return environment$;
}

function createRunModelProviderObjects(
  input$: RunModelProviderInputObject,
  body: Pick<ReturnType<typeof createRunBodyObjects>, "framework$">,
  identity: Pick<
    ReturnType<typeof createRunIdentityObjects>,
    "content$" | "featureSwitchContext$"
  >,
) {
  const sources = createPinnedProviderReadContext(input$, body, identity);
  const gateway$ = createPinnedGatewayProviderEnvironment(
    sources,
    createPinnedGatewayProviderSnapshot(sources),
  );
  const pinnedEnvironment$ = createPinnedProviderEnvironment(sources, {
    builtIn$: createPinnedBuiltInProviderSnapshot(sources),
    personal$: createPinnedPersonalProviderSnapshot(sources),
    gateway$,
    regular$: createPinnedRegularProviderSnapshot(sources, gateway$),
  });
  const queuedModelRoute$ = computed(async (get) => {
    const context = await get(sources.providerContext$);
    if (isRouteError(context)) {
      return context;
    }
    if (!context.shouldResolve) {
      return null;
    }
    const hold = observeRunContextParallelStage(
      "model-provider",
      context.input.args,
    );
    if (hold) {
      await hold;
    }
    return await context.input.timing.measure(
      "api_dispatch_prepare_context_resolve_model_provider",
      "nested",
      async () => {
        return (
          (await get(pinnedEnvironment$)) ??
          providerUnavailable(
            `No model provider configured and ${frameworkApiKeyEnv(context.requestedFramework)} is not declared in compose environment`,
          )
        );
      },
    );
  });
  const modelRoute$ = computed(async (get) => {
    const context = await get(sources.providerContext$);
    if (isRouteError(context)) {
      return context;
    }
    const providerResult = await settle(
      context.input.args.queueFirstAssociation
        ? get(queuedModelRoute$)
        : resolvePreparedRunModelProvider({
            db: context.input.db,
            createArgs: context.input.args,
            timing: context.input.timing,
            bodyContext: {
              content: context.content,
              requestedFramework: context.requestedFramework,
              featureSwitchContext: context.featureSwitchContext,
            },
            usagePricingResolution: get(usagePricingResolution$),
          }),
    );
    if (!providerResult.ok) {
      return piConfigurationRouteError(providerResult.error);
    }
    const provider = providerResult.value;
    if (isRouteError(provider)) {
      return provider;
    }
    if (
      context.input.args.codexServiceTier === "ultrafast" &&
      !isCatalogUltrafastServiceTierSupported(
        context.input.args.catalog,
        provider?.selectedModel,
        provider?.type,
      )
    ) {
      return badRequestMessage("Ultrafast is unavailable for this model route");
    }
    const materialized = await settle(
      materializePreparedPiProvider(context.input.args, provider),
    );
    return materialized.ok
      ? materialized.value
      : piConfigurationRouteError(materialized.error);
  });
  return { modelRoute$ };
}

function createRunModelObject(
  input$: RunContextInputObject,
  body: ReturnType<typeof createRunBodyObjects>,
  identity: ReturnType<typeof createRunIdentityObjects>,
) {
  return createRunModelProviderObjects(input$, body, identity);
}

type RunConnectorScopeObject = Computed<
  EffectiveConnectorScope | Promise<EffectiveConnectorScope>
>;

type RunConnectorSelectionObject = Computed<
  Promise<RunConnectorSelection | CreateRunErrorResult>
>;

type RunConnectorPreparationObject = Computed<
  Promise<RunConnectorPreparation | CreateRunErrorResult>
>;

function createRunConnectorCatalogObjects(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  definitionRows$: RunCustomConnectorDefinitionRowsObject,
) {
  const metadataSlugs$ = computed(async (get) => {
    const rows = await get(definitionRows$);
    return [
      ...new Set(
        rows.flatMap((row) => {
          const slug =
            row.permissionBundleRef === null
              ? null
              : customConnectorPermissionBundleDependencySlug(
                  row.permissionBundleRef,
                );
          return slug === null ? [] : [slug];
        }),
      ),
    ].sort();
  });
  const catalogInput$ = computed(async (get) => {
    const { db, timing } = await get(input$);
    return { db, timing };
  });
  const requestedSlugs$ = computed(async (get) => {
    const [scope, metadataConnectorSlugs] = await Promise.all([
      get(scope$),
      get(metadataSlugs$),
    ]);
    return {
      requestedConnectorSlugs: scope.allowedConnectorSlugs,
      metadataConnectorSlugs,
    };
  });
  const { connectorCatalog$ } = createConnectorRuntimeSelectionObjects(
    catalogInput$,
    requestedSlugs$,
  );
  const catalog$ = computed(
    async (get): Promise<RunConnectorCatalogSelection> => {
      const [input, scope] = await Promise.all([get(input$), get(scope$)]);
      return await input.timing.measure(
        "api_dispatch_prepare_context_select_connector_catalog",
        "nested",
        async () => {
          return isEmptyRunConnectorScope(scope)
            ? { kind: "empty" }
            : { kind: "scoped", selection: await get(connectorCatalog$) };
        },
      );
    },
  );
  return { catalog$ };
}

function createRunOwnedConnectorThreadObject(
  input$: AsyncRead<RunConnectorReadInput>,
) {
  return computed(async (get) => {
    const { db, args } = await get(input$);
    if (args.chatThreadId === undefined) {
      return null;
    }
    const [thread] = await db
      .select({ agentId: agents.id })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
      )
      .where(
        and(
          eq(chatThreads.id, args.chatThreadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    return thread ?? null;
  });
}

function createRunThreadSelectionRowObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  ownedThread$: ReturnType<typeof createRunOwnedConnectorThreadObject>,
) {
  return computed(
    async (get): Promise<readonly ConnectorAccountSelection[]> => {
      const { db, args } = await get(input$);
      const [thread, scope] = await Promise.all([
        get(ownedThread$),
        get(scope$),
      ]);
      if (!thread || args.chatThreadId === undefined) {
        return [];
      }
      const rows = await db
        .select({
          connectorId: chatThreadConnectorSelections.connectorId,
          connectorSlug: chatThreadConnectorSelections.connectorSlug,
          customConnectorId: chatThreadConnectorSelections.customConnectorId,
        })
        .from(chatThreadConnectorSelections)
        .where(
          eq(chatThreadConnectorSelections.chatThreadId, args.chatThreadId),
        )
        .orderBy(
          asc(chatThreadConnectorSelections.connectorSlug),
          asc(chatThreadConnectorSelections.customConnectorId),
        );
      return rows
        .map((row) => {
          return {
            connectionId: row.connectorId,
            target: runConnectorTargetFromRow(row),
          };
        })
        .filter((selection) => {
          return runConnectorTargetIsAuthorized(scope, selection.target);
        });
    },
  );
}

function createRunConnectorAccountRowsObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  selections$: ReturnType<typeof createRunThreadSelectionRowObject>,
) {
  return computed(async (get) => {
    const { db, args } = await get(input$);
    const scope = await get(scope$);
    const selections = await get(selections$);
    const sourceIds = [
      ...selections.map((selection) => {
        return selection.connectionId;
      }),
      ...(args.connectorSourceId ? [args.connectorSourceId] : []),
    ];
    if (isEmptyRunConnectorScope(scope)) {
      return [];
    }
    await observeRunConnectorAccountsRead();
    return await db
      .select({
        connectorId: connectors.id,
        connectorSlug: connectors.connectorSlug,
        customConnectorId: connectors.customConnectorId,
        isDefault: connectors.isDefault,
        customDefinitionId: orgCustomConnectors.id,
        providerAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
      })
      .from(connectors)
      .leftJoin(
        orgCustomConnectors,
        and(
          eq(orgCustomConnectors.id, connectors.customConnectorId),
          eq(orgCustomConnectors.orgId, connectors.orgId),
        ),
      )
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          or(
            sourceIds.length ? inArray(connectors.id, sourceIds) : undefined,
            and(
              eq(connectors.isDefault, true),
              or(
                scope.allowedConnectorSlugs.length
                  ? inArray(connectors.connectorSlug, [
                      ...scope.allowedConnectorSlugs,
                    ])
                  : undefined,
                scope.allowedCustomConnectorIds.length
                  ? inArray(connectors.customConnectorId, [
                      ...scope.allowedCustomConnectorIds,
                    ])
                  : undefined,
              ),
            ),
          ),
        ),
      );
  });
}

function createRunThreadConnectorSelectionObjects(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
) {
  const ownedThread$ = createRunOwnedConnectorThreadObject(input$);
  const selections$ = createRunThreadSelectionRowObject(
    input$,
    scope$,
    ownedThread$,
  );
  const accountRows$ = createRunConnectorAccountRowsObject(
    input$,
    scope$,
    selections$,
  );
  const threadSelections$ = computed(
    async (
      get,
    ): Promise<
      ThreadConnectorSelectionIds | CreateRunErrorResult | undefined
    > => {
      const { args } = await get(input$);
      if (args.chatThreadId === undefined) {
        return undefined;
      }
      const [thread, selections, accountRows, scope] = await Promise.all([
        get(ownedThread$),
        get(selections$),
        get(accountRows$),
        get(scope$),
      ]);
      if (!thread) {
        return badRequestMessage("Chat thread is no longer available");
      }
      const byId = new Map(
        accountRows.map((row) => {
          return [row.connectorId, row];
        }),
      );
      const projectedSelections = selections.filter((selection) => {
        const row = byId.get(selection.connectionId);
        return (
          row !== undefined &&
          connectorAccountTargetKey(runConnectorTargetFromRow(row)) ===
            connectorAccountTargetKey(selection.target) &&
          (row.customConnectorId === null ||
            (row.customDefinitionId !== null &&
              !isIntegrationManagedCustomConnectorProviderAdapter(
                row.providerAdapter,
              )))
        );
      });
      const sourceRow = args.connectorSourceId
        ? byId.get(args.connectorSourceId)
        : undefined;
      const sourceTarget = sourceRow
        ? runConnectorTargetFromRow(sourceRow)
        : undefined;
      const source =
        sourceRow &&
        sourceTarget &&
        runConnectorTargetIsAuthorized(scope, sourceTarget)
          ? { connectionId: sourceRow.connectorId, target: sourceTarget }
          : null;
      return runThreadConnectorCandidates(projectedSelections, source);
    },
  );
  const accountCandidates$ = computed(async (get) => {
    const [selections, rows, scope] = await Promise.all([
      get(threadSelections$),
      get(accountRows$),
      get(scope$),
    ]);
    return isRouteError(selections)
      ? new Map<string, readonly string[]>()
      : runConnectorAccountCandidatesFromRows({
          requests: runConnectorAccountRequests(scope, selections),
          rows,
        });
  });
  return { threadSelections$, accountCandidates$ };
}

function createRunConnectorPreparationObject(
  input$: AsyncRead<RunConnectorReadInput>,
  connectorSelection$: RunConnectorSelectionObject,
) {
  return computed(
    async (get): Promise<RunConnectorPreparation | CreateRunErrorResult> => {
      const input = await get(input$);
      const selection = await get(connectorSelection$);
      if (isRouteError(selection)) {
        return selection;
      }
      await observeRunContextParallelStage("connector-contexts", input.args);
      const {
        connectorCatalogSelection,
        connectorScope,
        threadConnectorSelectionIds,
      } = selection;
      if (connectorCatalogSelection.kind === "empty") {
        return { selection, stored: null, custom: null };
      }
      const connectorCatalogSnapshot = connectorCatalogSelection.selection;
      const allowedConnectorSlugs = [
        ...new Set(
          connectorScope.allowedConnectorSlugs.filter((slug) => {
            return (
              getConnectorRuntimeConnector(connectorCatalogSnapshot, slug)
                ?.catalogConnector.mcp === undefined ||
              input.args.includeOkouTokenSecret === true
            );
          }),
        ),
      ];
      return {
        selection,
        stored:
          allowedConnectorSlugs.length === 0
            ? null
            : {
                orgId: input.args.orgId,
                userId: input.args.userId,
                allowedConnectorSlugs,
                connectorIdCandidatesBySlug:
                  threadConnectorSelectionIds?.connectorIdCandidatesBySlug,
                scopeSource: connectorScope.source,
                connectorCatalogSnapshot,
              },
        custom:
          connectorScope.allowedCustomConnectorIds.length === 0
            ? null
            : {
                orgId: input.args.orgId,
                userId: input.args.userId,
                allowedCustomConnectorIds:
                  connectorScope.allowedCustomConnectorIds,
                connectorIdCandidatesByCustomConnectorId:
                  threadConnectorSelectionIds?.connectorIdCandidatesByCustomConnectorId,
                customConnectorGrants: connectorScope.customConnectorGrants,
                connectorCatalogSnapshot,
              },
      };
    },
  );
}

type RunConnectorAccountCandidatesObject = ReturnType<
  typeof createRunThreadConnectorSelectionObjects
>["accountCandidates$"];

function createRunStoredConnectorSelectionViewObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  accountCandidates$: RunConnectorAccountCandidatesObject,
) {
  return computed(async (get) => {
    const { db, args } = await get(input$);
    const candidates = await get(accountCandidates$);
    const connectorIds = (await get(scope$)).allowedConnectorSlugs.flatMap(
      (connectorSlug) => {
        return (
          candidates.get(
            connectorAccountTargetKey({ kind: "builtin", connectorSlug }),
          ) ?? []
        );
      },
    );
    if (connectorIds.length === 0) {
      return null;
    }
    return db.$with("stored_connector_candidates").as(
      db
        .select({
          connectorId: connectors.id,
          connectorSlug: sql`${connectors.connectorSlug}`
            .mapWith(pgTextDecoder)
            .as("connector_slug"),
          authMethod: connectors.authMethod,
          automaticAuthType: connectors.automaticAuthType,
          connectorStateRevision:
            sql`(EXTRACT(EPOCH FROM ${connectors.updatedAt}) * 1000000)::bigint`
              .mapWith(pgInt8ToBigIntDecoder)
              .as("connector_state_revision"),
          needsReconnect: connectors.needsReconnect,
          orgId: connectors.orgId,
          storageVersion: connectors.storageVersion,
          tokenExpiresAt: connectors.tokenExpiresAt,
          userId: connectors.userId,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            isNotNull(connectors.connectorSlug),
            inArray(connectors.id, connectorIds),
          ),
        ),
    );
  });
}

function createRunStoredConnectorRowObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  accountCandidates$: RunConnectorAccountCandidatesObject,
) {
  const selectedConnectors$ = createRunStoredConnectorSelectionViewObject(
    input$,
    scope$,
    accountCandidates$,
  );
  return computed(
    async (
      get,
    ): Promise<readonly StoredConnectorMaterializationSnapshotRow[]> => {
      const { db, args, timing } = await get(input$);
      const selectedConnectors = await get(selectedConnectors$);
      if (!selectedConnectors) {
        return [];
      }
      const secretGroups = db
        .select({
          connectorId: secretsTable.connectorId,
          secretNames: sql`jsonb_agg(${secretsTable.name})`
            .mapWith(storedConnectorSecretNamesDecoder)
            .as("secret_names"),
        })
        .from(secretsTable)
        .innerJoin(
          selectedConnectors,
          and(
            eq(selectedConnectors.connectorId, secretsTable.connectorId),
            eq(secretsTable.orgId, args.orgId),
            eq(secretsTable.userId, args.userId),
          ),
        )
        .where(eq(secretsTable.type, "connector"))
        .groupBy(secretsTable.connectorId)
        .as("stored_connector_secret_groups");
      const variableGroups = db
        .select({
          connectorId: variables.connectorId,
          variableValues:
            sql`jsonb_object_agg(${variables.name}, ${variables.value})`
              .mapWith(storedConnectorVariableValuesDecoder)
              .as("variable_values"),
        })
        .from(variables)
        .innerJoin(
          selectedConnectors,
          and(
            eq(selectedConnectors.connectorId, variables.connectorId),
            eq(variables.orgId, args.orgId),
            eq(variables.userId, args.userId),
          ),
        )
        .where(eq(variables.type, "connector"))
        .groupBy(variables.connectorId)
        .as("stored_connector_variable_groups");
      const startedAt = now();
      const dimensions = storedConnectorTimingDimensions({
        scopeSource: (await get(scope$)).source,
      });
      const rows = await onRejection(
        db
          .with(selectedConnectors)
          .select({
            connectorId: selectedConnectors.connectorId,
            connectorSlug: selectedConnectors.connectorSlug,
            authMethod: selectedConnectors.authMethod,
            automaticAuthType: selectedConnectors.automaticAuthType,
            connectorStateRevision: selectedConnectors.connectorStateRevision,
            needsReconnect: selectedConnectors.needsReconnect,
            orgId: selectedConnectors.orgId,
            storageVersion: selectedConnectors.storageVersion,
            tokenExpiresAt: selectedConnectors.tokenExpiresAt,
            userId: selectedConnectors.userId,
            secretNames: sql`${secretGroups.secretNames}`.mapWith(
              nullableDriverValueDecoder(storedConnectorSecretNamesDecoder),
            ),
            variableValues: sql`${variableGroups.variableValues}`.mapWith(
              nullableDriverValueDecoder(storedConnectorVariableValuesDecoder),
            ),
          })
          .from(selectedConnectors)
          .leftJoin(
            secretGroups,
            eq(secretGroups.connectorId, selectedConnectors.connectorId),
          )
          .leftJoin(
            variableGroups,
            eq(variableGroups.connectorId, selectedConnectors.connectorId),
          ),
        () => {
          timing.recordElapsed(
            "api_dispatch_prepare_context_load_stored_connector_snapshot_rows",
            "nested",
            startedAt,
            now(),
            dimensions,
          );
        },
      );
      timing.recordElapsed(
        "api_dispatch_prepare_context_load_stored_connector_snapshot_rows",
        "nested",
        startedAt,
        now(),
        {
          ...dimensions,
          stored_connector_candidate_count_bucket: countBucket(rows.length),
        },
      );
      return rows.map((row) => {
        return {
          ...row,
          secretNames: row.secretNames ?? [],
          variableValues: row.variableValues ?? {},
        };
      });
    },
  );
}

function createRunStoredConnectorSnapshotObject(
  input$: AsyncRead<RunConnectorReadInput>,
  preparation$: RunConnectorPreparationObject,
  rows$: ReturnType<typeof createRunStoredConnectorRowObject>,
  accountCandidates$: RunConnectorAccountCandidatesObject,
) {
  return computed(
    async (
      get,
    ): Promise<
      StoredConnectorMaterializationSnapshot | null | CreateRunErrorResult
    > => {
      const [preparation, rows, candidates] = await Promise.all([
        get(preparation$),
        get(rows$),
        get(accountCandidates$),
      ]);
      if (isRouteError(preparation)) {
        return preparation;
      }
      const args = preparation.stored;
      if (!args) {
        return null;
      }
      const available = new Set(
        allowedStoredConnectorRows(
          rows,
          args.allowedConnectorSlugs,
          args.connectorCatalogSnapshot,
          nowDate(),
        ).map((row) => {
          return row.access.connectorId;
        }),
      );
      const selectedIds = new Set(
        args.allowedConnectorSlugs.flatMap((connectorSlug) => {
          const ids =
            candidates.get(
              connectorAccountTargetKey({ kind: "builtin", connectorSlug }),
            ) ?? [];
          const id = ids.find((candidate) => {
            return available.has(candidate);
          });
          return id ? [id] : [];
        }),
      );
      return materializeStoredConnectorSnapshotRows(
        {
          rows: rows.filter((row) => {
            return selectedIds.has(row.connectorId);
          }),
          allowedConnectorSlugs: args.allowedConnectorSlugs,
          connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          timingDimensions: storedConnectorTimingDimensions({
            scopeSource: args.scopeSource,
          }),
        },
        (await get(input$)).timing,
      );
    },
  );
}

function createRunCustomConnectorDefinitionRowsObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
) {
  return computed(async (get) => {
    const { db, args, timing } = await get(input$);
    const ids = (await get(scope$)).allowedCustomConnectorIds;
    if (ids.length === 0) {
      return [];
    }
    const startedAt = now();
    const rows = await db
      .select({
        connector: customConnectorDefinitionSelection(),
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.enabled, true),
          inArray(orgCustomConnectors.id, [...ids]),
        ),
      );
    timing.recordElapsed(
      "api_dispatch_prepare_context_load_custom_connector_rows",
      "nested",
      startedAt,
      now(),
    );
    return rows.map((row) => {
      return normaliseCustomConnectorRow(row.connector, row.oauthConfig);
    });
  });
}

type RunCustomConnectorDefinitionRowsObject = ReturnType<
  typeof createRunCustomConnectorDefinitionRowsObject
>;

export const runCustomConnectorAccessTokenSecret = alias(
  secretsTable,
  "run_custom_connector_access_token",
);

export const runCustomConnectorRefreshTokenSecret = alias(
  secretsTable,
  "run_custom_connector_refresh_token",
);

export const runCustomConnectorStoredValueKindDecoder =
  zodEnumDriverValueDecoder(z.enum(["secret", "variable"]));

export function runCustomConnectorConnectionColumns() {
  return {
    id: sql`${connectors.id}`.mapWith(connectors.id).as("member_connector_id"),
    updatedAt: connectors.updatedAt,
    customConnectorId: sql`${orgCustomConnectors.id}`
      .mapWith(orgCustomConnectors.id)
      .as("custom_connector_id"),
    storedAuthMethod: sql`${connectors.authMethod}`
      .mapWith(connectors.authMethod)
      .as("stored_auth_method"),
    storedStorageVersion: sql`${connectors.storageVersion}`
      .mapWith(connectors.storageVersion)
      .as("stored_storage_version"),
    storedNeedsReconnect: sql`${connectors.needsReconnect}`
      .mapWith(connectors.needsReconnect)
      .as("stored_needs_reconnect"),
    tokenExpiresAt: sql`${connectors.tokenExpiresAt}`
      .mapWith(connectors.tokenExpiresAt)
      .as("token_expires_at"),
    definitionAuthMethod: sql`${orgCustomConnectors.authMode}`
      .mapWith(orgCustomConnectors.authMode)
      .as("definition_auth_method"),
    definitionMcpTransport: orgCustomConnectors.mcpTransport,
    definitionStorageVersion: sql`${orgCustomConnectors.storageVersion}`
      .mapWith(orgCustomConnectors.storageVersion)
      .as("definition_storage_version"),
    oauthAccessTokenId: sql`${runCustomConnectorAccessTokenSecret.id}`
      .mapWith(runCustomConnectorAccessTokenSecret.id)
      .as("oauth_access_token_id"),
    oauthRefreshTokenId: sql`${runCustomConnectorRefreshTokenSecret.id}`
      .mapWith(runCustomConnectorRefreshTokenSecret.id)
      .as("oauth_refresh_token_id"),
    automaticOAuthBindingId:
      sql`${customConnectorAccountOauthBindings.connectorAccountId}`
        .mapWith(customConnectorAccountOauthBindings.connectorAccountId)
        .as("automatic_oauth_binding_id"),
  };
}

function createRunCustomConnectorConnectionViewObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  accountCandidates$: RunConnectorAccountCandidatesObject,
) {
  return computed(async (get) => {
    const { db, args } = await get(input$);
    const candidates = await get(accountCandidates$);
    const connectorIds = (await get(scope$)).allowedCustomConnectorIds;
    const memberConnectorIds = connectorIds.flatMap((customConnectorId) => {
      return (
        candidates.get(
          connectorAccountTargetKey({ kind: "custom", customConnectorId }),
        ) ?? []
      );
    });
    if (memberConnectorIds.length === 0) {
      return null;
    }
    return db.$with("custom_connector_runtime_connections").as(
      db
        .select(runCustomConnectorConnectionColumns())
        .from(connectors)
        .innerJoin(
          orgCustomConnectors,
          and(
            eq(orgCustomConnectors.id, connectors.customConnectorId),
            eq(orgCustomConnectors.orgId, connectors.orgId),
          ),
        )
        .leftJoin(
          runCustomConnectorAccessTokenSecret,
          and(
            eq(runCustomConnectorAccessTokenSecret.connectorId, connectors.id),
            eq(runCustomConnectorAccessTokenSecret.name, "access_token"),
          ),
        )
        .leftJoin(
          runCustomConnectorRefreshTokenSecret,
          and(
            eq(runCustomConnectorRefreshTokenSecret.connectorId, connectors.id),
            eq(runCustomConnectorRefreshTokenSecret.name, "refresh_token"),
          ),
        )
        .leftJoin(
          customConnectorAccountOauthBindings,
          and(
            eq(
              customConnectorAccountOauthBindings.connectorAccountId,
              connectors.id,
            ),
            eq(
              customConnectorAccountOauthBindings.customConnectorId,
              orgCustomConnectors.id,
            ),
          ),
        )
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            inArray(connectors.customConnectorId, [...connectorIds]),
            inArray(connectors.id, memberConnectorIds),
          ),
        ),
    );
  });
}

function createRunCustomConnectorValueViewObject(
  input$: AsyncRead<RunConnectorReadInput>,
  connections$: ReturnType<typeof createRunCustomConnectorConnectionViewObject>,
) {
  return computed(async (get) => {
    const { db, args } = await get(input$);
    const connections = await get(connections$);
    if (!connections) {
      return null;
    }
    const compatible = or(
      eq(connections.definitionAuthMethod, connections.storedAuthMethod),
      and(
        eq(connections.definitionAuthMethod, "automatic"),
        inArray(connections.storedAuthMethod, ["none", "oauth"]),
      ),
    );
    const currentVersion = eq(
      connections.storedStorageVersion,
      connections.definitionStorageVersion,
    );
    const secretQuery = db
      .select({
        memberConnectorId: sql`${connections.id}`
          .mapWith(pgTextDecoder)
          .as("value_member_connector_id"),
        kind: sql`'secret'`
          .mapWith(runCustomConnectorStoredValueKindDecoder)
          .as("kind"),
        key: secretsTable.name,
        storedValue: secretsTable.encryptedValue,
      })
      .from(connections)
      .innerJoin(secretsTable, eq(secretsTable.connectorId, connections.id))
      .where(
        and(
          eq(secretsTable.type, "connector"),
          eq(secretsTable.orgId, args.orgId),
          eq(secretsTable.userId, args.userId),
          compatible,
          currentVersion,
          ne(connections.storedAuthMethod, "none"),
        ),
      );
    const variableQuery = db
      .select({
        memberConnectorId: sql`${connections.id}`
          .mapWith(pgTextDecoder)
          .as("value_member_connector_id"),
        kind: sql`'variable'`
          .mapWith(runCustomConnectorStoredValueKindDecoder)
          .as("kind"),
        key: variables.name,
        storedValue: variables.value,
      })
      .from(connections)
      .innerJoin(variables, eq(variables.connectorId, connections.id))
      .where(
        and(
          eq(variables.type, "connector"),
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          compatible,
          currentVersion,
        ),
      );
    return db
      .$with("custom_connector_runtime_values")
      .as(unionAll(secretQuery, variableQuery));
  });
}

function createRunCustomConnectorStoredRowsObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  accountCandidates$: RunConnectorAccountCandidatesObject,
) {
  const connections$ = createRunCustomConnectorConnectionViewObject(
    input$,
    scope$,
    accountCandidates$,
  );
  const values$ = createRunCustomConnectorValueViewObject(input$, connections$);
  return computed(
    async (get): Promise<readonly CustomConnectorRuntimeStorageRow[]> => {
      const { db, timing } = await get(input$);
      const [connections, values] = await Promise.all([
        get(connections$),
        get(values$),
      ]);
      if (!connections || !values) {
        return [];
      }
      const startedAt = now();
      const rows = await db
        .with(connections, values)
        .select({
          id: connections.id,
          updatedAt: connections.updatedAt,
          customConnectorId: connections.customConnectorId,
          storedAuthMethod: connections.storedAuthMethod,
          storedStorageVersion: connections.storedStorageVersion,
          storedNeedsReconnect: connections.storedNeedsReconnect,
          tokenExpiresAt: connections.tokenExpiresAt,
          definitionAuthMethod: connections.definitionAuthMethod,
          definitionMcpTransport: connections.definitionMcpTransport,
          definitionStorageVersion: connections.definitionStorageVersion,
          oauthAccessTokenId: connections.oauthAccessTokenId,
          oauthRefreshTokenId: connections.oauthRefreshTokenId,
          automaticOAuthBindingId: connections.automaticOAuthBindingId,
          kind: values.kind,
          key: values.key,
          storedValue: values.storedValue,
        })
        .from(connections)
        .leftJoin(values, eq(values.memberConnectorId, connections.id));
      timing.recordElapsed(
        "api_dispatch_prepare_context_load_custom_connector_value_rows",
        "nested",
        startedAt,
        now(),
      );
      return rows;
    },
  );
}

function createRunCustomConnectorPermissionBundlesObject(
  preparation$: RunConnectorPreparationObject,
  definitionRows$: RunCustomConnectorDefinitionRowsObject,
  storedRows$: ReturnType<typeof createRunCustomConnectorStoredRowsObject>,
  accountCandidates$: RunConnectorAccountCandidatesObject,
) {
  return computed(async (get) => {
    const [preparation, connectors, storageRows, candidates] =
      await Promise.all([
        get(preparation$),
        get(definitionRows$),
        get(storedRows$),
        get(accountCandidates$),
      ]);
    if (isRouteError(preparation) || !preparation.custom) {
      return new Map<
        string,
        CustomConnectorPermissionBundle | null | undefined
      >();
    }
    const snapshot = preparation.custom.connectorCatalogSnapshot;
    const entries = await Promise.all(
      connectors.map(async (connector) => {
        const rows = customConnectorCandidateRuntimeRows({
          connector,
          storageRows,
          candidateIds:
            candidates.get(
              connectorAccountTargetKey({
                kind: "custom",
                customConnectorId: connector.id,
              }),
            ) ?? [],
        });
        const row = rows.find((candidate) => {
          return (
            customConnectorNewRunRowIsAdmissible(candidate) &&
            resolveCustomConnectorBaseUrlVars({
              row: candidate,
              provided: undefined,
              hasProvided: false,
            }) !== undefined
          );
        });
        if (!row) {
          return [connector.id, null] as const;
        }
        const bundle = await loadEffectiveCustomConnectorPermissionBundle({
          row,
          snapshot,
        });
        return [connector.id, bundle] as const;
      }),
    );
    return new Map(entries);
  });
}

function createRunCustomConnectorContextObject(
  input$: AsyncRead<RunConnectorReadInput>,
  preparation$: RunConnectorPreparationObject,
  {
    definitionRows$,
    storedRows$,
    accountCandidates$,
  }: {
    readonly definitionRows$: RunCustomConnectorDefinitionRowsObject;
    readonly storedRows$: ReturnType<
      typeof createRunCustomConnectorStoredRowsObject
    >;
    readonly accountCandidates$: RunConnectorAccountCandidatesObject;
  },
  featureSwitchContext$: ReturnType<
    typeof createRunIdentityObjects
  >["featureSwitchContext$"],
) {
  const permissionBundles$ = createRunCustomConnectorPermissionBundlesObject(
    preparation$,
    definitionRows$,
    storedRows$,
    accountCandidates$,
  );
  return computed(
    async (
      get,
    ): Promise<CustomConnectorRuntimeContext | CreateRunErrorResult> => {
      const [
        preparation,
        connectors,
        storageRows,
        candidates,
        featureSwitchContext,
        permissionBundlesByConnectorId,
      ] = await Promise.all([
        get(preparation$),
        get(definitionRows$),
        get(storedRows$),
        get(accountCandidates$),
        get(featureSwitchContext$),
        get(permissionBundles$),
      ]);
      if (isRouteError(preparation)) {
        return preparation;
      }
      if (!preparation.custom) {
        return emptyCustomConnectorRuntimeContext();
      }
      const args = preparation.custom;
      const chosenRows = await Promise.all(
        connectors.map(async (connector) => {
          const rows = customConnectorCandidateRuntimeRows({
            connector,
            storageRows,
            candidateIds:
              candidates.get(
                connectorAccountTargetKey({
                  kind: "custom",
                  customConnectorId: connector.id,
                }),
              ) ?? [],
          });
          for (const row of rows) {
            const context = await buildNewRunCustomConnectorRuntimeContext({
              rows: [row],
              permissionBundlesByConnectorId,
              featureSwitchContext,
              connectorCatalogSnapshot: args.connectorCatalogSnapshot,
              grants: args.customConnectorGrants,
            });
            if (context.targets.length > 0) {
              return row;
            }
          }
          return {
            connector,
            values: [],
            credentialAccess: { kind: "absent" as const },
          };
        }),
      );
      return await (
        await get(input$)
      ).timing.measure(
        "api_dispatch_prepare_context_build_custom_connector_firewalls",
        "nested",
        async () => {
          return await buildNewRunCustomConnectorRuntimeContext({
            rows: chosenRows,
            permissionBundlesByConnectorId,
            featureSwitchContext,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
            grants: args.customConnectorGrants,
          });
        },
      );
    },
  );
}

function createRunConnectorSelectionObject(
  input$: AsyncRead<RunConnectorReadInput>,
  scope$: RunConnectorScopeObject,
  definitionRows$: RunCustomConnectorDefinitionRowsObject,
  threadSelections$: ReturnType<
    typeof createRunThreadConnectorSelectionObjects
  >["threadSelections$"],
  selectedCatalog$?: Computed<Promise<RunConnectorCatalogSelection>>,
) {
  const catalog$ =
    selectedCatalog$ ??
    createRunConnectorCatalogObjects(input$, scope$, definitionRows$).catalog$;
  return computed(
    async (get): Promise<RunConnectorSelection | CreateRunErrorResult> => {
      const [connectorCatalogSelection, threadConnectorSelectionIds] =
        await Promise.all([get(catalog$), get(threadSelections$)]);
      if (isRouteError(threadConnectorSelectionIds)) {
        return threadConnectorSelectionIds;
      }
      const scope = await get(scope$);
      return {
        connectorCatalogSelection,
        threadConnectorSelectionIds,
        connectorScope:
          connectorCatalogSelection.kind === "scoped"
            ? connectorScopeForRuntimeSnapshot(
                scope,
                connectorCatalogSelection.selection,
              )
            : scope,
      };
    },
  );
}

function createRunConnectorReadObjects(
  input$: AsyncRead<RunConnectorReadInput>,
  {
    featureSwitchContext$,
  }: Pick<ReturnType<typeof createRunIdentityObjects>, "featureSwitchContext$">,
  scope$: RunConnectorScopeObject,
  selectedCatalog$?: Computed<Promise<RunConnectorCatalogSelection>>,
) {
  const definitionRows$ = createRunCustomConnectorDefinitionRowsObject(
    input$,
    scope$,
  );
  const { threadSelections$, accountCandidates$ } =
    createRunThreadConnectorSelectionObjects(input$, scope$);
  const connectorSelection$ = createRunConnectorSelectionObject(
    input$,
    scope$,
    definitionRows$,
    threadSelections$,
    selectedCatalog$,
  );
  const preparation$ = createRunConnectorPreparationObject(
    input$,
    connectorSelection$,
  );
  const storedRows$ = createRunStoredConnectorRowObject(
    input$,
    scope$,
    accountCandidates$,
  );
  const storedSnapshot$ = createRunStoredConnectorSnapshotObject(
    input$,
    preparation$,
    storedRows$,
    accountCandidates$,
  );
  const customStoredRows$ = createRunCustomConnectorStoredRowsObject(
    input$,
    scope$,
    accountCandidates$,
  );
  const customContext$ = createRunCustomConnectorContextObject(
    input$,
    preparation$,
    { definitionRows$, storedRows$: customStoredRows$, accountCandidates$ },
    featureSwitchContext$,
  );
  const connectorSnapshot$ = computed(
    async (
      get,
    ): Promise<RunConnectorContextSnapshot | CreateRunErrorResult> => {
      const input = await get(input$);
      const scope = await get(scope$);
      return await input.timing.measure(
        "api_dispatch_prepare_context_load_connector_contexts",
        "nested",
        async () => {
          const [preparation, storedConnectorSnapshot, customConnectorContext] =
            await Promise.all([
              get(preparation$),
              get(storedSnapshot$),
              get(customContext$),
            ]);
          if (isRouteError(preparation)) {
            return preparation;
          }
          if (isRouteError(storedConnectorSnapshot)) {
            return storedConnectorSnapshot;
          }
          if (isRouteError(customConnectorContext)) {
            return customConnectorContext;
          }
          return {
            storedConnectorSnapshot,
            storedConnectorMetadataContext: storedConnectorContextFromSnapshot(
              storedConnectorSnapshot,
            ),
            customConnectorContext,
          };
        },
        storedConnectorTimingDimensions({
          scopeSource: scope.source,
        }),
      );
    },
  );
  return { connectorSelection$, connectorSnapshot$ };
}

function createRunConnectorSelectionObjects(
  input$: RunContextInputObject,
  identity: ReturnType<typeof createRunIdentityObjects>,
) {
  const scope$ = computed(async (get) => {
    return connectorScopeFromCreateArgs((await get(input$)).args);
  });
  return createRunConnectorReadObjects(input$, identity, scope$);
}

function createRunRuntimeObjects(
  input$: RunContextInputObject,
  { bodyContext$ }: ReturnType<typeof createRunBodyObjects>,
  { modelRoute$ }: ReturnType<typeof createRunModelObject>,
  {
    connectorSelection$,
    connectorSnapshot$,
  }: ReturnType<typeof createRunConnectorSelectionObjects>,
  shared?: SelectedRunReadObjects,
) {
  const connectorInputs$ = computed(
    async (get): Promise<RunPreparedConnectorInputs | CreateRunErrorResult> => {
      const input = await get(input$);
      const [bodyResult, modelResult, selectionResult, snapshotResult] =
        await Promise.all([
          get(bodyContext$),
          get(modelRoute$),
          get(connectorSelection$),
          get(connectorSnapshot$),
        ]);

      const selection = selectionResult;
      const bodyContext = bodyResult;
      const modelProvider = modelResult;
      const snapshot = snapshotResult;
      if (isRouteError(bodyContext)) {
        return bodyContext;
      }
      if (isRouteError(modelProvider)) {
        return modelProvider;
      }
      if (isRouteError(selection)) {
        return selection;
      }
      if (isRouteError(snapshot)) {
        return snapshot;
      }
      return {
        db: input.db,
        connectorScope: selection.connectorScope,
        connectorCatalogSelection: selection.connectorCatalogSelection,
        body: bodyContext.body,
        content: bodyContext.resolved.content,
        modelProvider,
        ...snapshot,
        featureSwitchContext: bodyContext.featureSwitchContext,
        timing: input.timing,
      };
    },
  );
  const { connectorContext$ } =
    shared ?? createRunPreparedConnectorObjects(connectorInputs$);
  const runtimeContext$ = computed(
    async (get): Promise<PreparedRuntimeContext | CreateRunErrorResult> => {
      const [
        bodyResult,
        modelResult,
        selectionResult,
        snapshotResult,
        connectorResult,
      ] = await Promise.all([
        get(bodyContext$),
        get(modelRoute$),
        get(connectorSelection$),
        get(connectorSnapshot$),
        get(connectorContext$),
      ]);
      const selection = selectionResult;
      const bodyContext = bodyResult;
      const modelProvider = modelResult;
      const snapshot = snapshotResult;
      const connectors = connectorResult;
      if (isRouteError(bodyContext)) {
        return bodyContext;
      }
      if (isRouteError(modelProvider)) {
        return modelProvider;
      }
      if (isRouteError(selection)) {
        return selection;
      }
      if (isRouteError(snapshot)) {
        return snapshot;
      }
      if (isRouteError(connectors)) {
        return connectors;
      }
      const input = await get(input$);
      const usage = prepareModelUsageContext({
        catalog: input.args.catalog,
        modelProvider,
        permissionManifest: connectors.permissionManifest,
        routePricing: await loadRunRoutePricing(input.db, {
          catalog: input.args.catalog,
          modelProvider,
          serviceTier: input.args.codexServiceTier,
          resolution: get(usagePricingResolution$),
        }),
      });
      if (isRouteError(usage)) {
        return usage;
      }
      return {
        framework: modelProvider
          ? modelProviderFramework(modelProvider)
          : bodyContext.requestedFramework,
        modelProvider,
        ...connectors,
        customConnectorContext: snapshot.customConnectorContext,
        ...usage,
        connectorScope: selection.connectorScope,
        connectorCatalogSelection: selection.connectorCatalogSelection,
      };
    },
  );
  return { runtimeContext$ };
}

function createRunMemberObjects(
  input$: RunContextInputObject,
  shared?: SelectedRunReadObjects,
) {
  const readInput$ = computed(async (get) => {
    const { db, args } = await get(input$);
    return { db, orgId: args.orgId, userId: args.userId };
  });
  const memberSnapshot$ =
    shared?.member$ ?? createRunMemberSnapshotObject(readInput$);
  const userTimezone$ = computed(async (get) => {
    const input = await get(input$);
    await observeRunContextParallelStage("user-timezone", input.args);
    return shared
      ? get(shared.userTimezone$)
      : ((await get(memberSnapshot$)).member?.timezone ?? undefined);
  });
  const imageModel$ = computed(async (get) => {
    const input = await get(input$);
    await observeRunContextParallelStage("image-model", input.args);
    const stored = (await get(memberSnapshot$)).member?.selectedImageModel;
    return isImageModelId(stored) ? stored : DEFAULT_IMAGE_MODEL;
  });
  return { userTimezone$, imageModel$ };
}

function createRunMemberSnapshotObject(input$: AsyncRead<RunMemberReadInput>) {
  return computed(async (get): Promise<RunMemberSnapshot> => {
    const args = await get(input$);
    const { db } = args;
    const [member] = await db
      .select({
        timezone: orgMembersMetadata.timezone,
        selectedImageModel: orgMembersMetadata.selectedImageModel,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);
    return { orgId: args.orgId, userId: args.userId, member };
  });
}

function createRunWorkflowReadObject(
  input$: Computed<RunWorkflowReadInput | Promise<RunWorkflowReadInput>>,
  modelState$: Computed<Promise<RunWorkflowModelState>>,
) {
  const workflowInput$ = computed(async (get) => {
    const { db, args } = await get(input$);
    return {
      db,
      hasOfficialWorkflows: (args.injectSkillVolumes?.workflows ?? []).some(
        (workflow) => {
          return workflow.officialDefinitionName !== null;
        },
      ),
    };
  });
  const candidates$ = computed(async (get) => {
    const { args } = await get(input$);
    await observeRunContextParallelStage("official-workflow", args);
    const modelState = await get(modelState$);
    if (modelState === undefined || isRouteError(modelState)) {
      return [];
    }
    const { requestedFramework, modelProvider } = modelState;
    const framework = modelProvider
      ? modelProviderFramework(modelProvider)
      : requestedFramework;
    const piSandbox = resolvePreparedPiModelConfig({
      createArgs: args,
      modelProvider,
    });
    return officialWorkflowRunCandidates(
      args.injectSkillVolumes?.workflows ?? [],
      skillsRootForRun(framework, piSandbox),
      args.requiredOfficialWorkflowIds ?? [],
    );
  });
  const { observation$ } = createOfficialWorkflowRunObjects({
    input$: workflowInput$,
    candidates$,
  });
  const officialWorkflow$ = computed(
    async (get): Promise<PreparedOfficialWorkflow> => {
      const result = await settle(
        Promise.all([get(modelState$), get(observation$)]),
      );
      if (!result.ok) {
        if (result.error instanceof OfficialWorkflowRunAdmissionError) {
          return conflict(result.error.message);
        }
        throw result.error;
      }
      const [model, observation] = result.value;
      return isRouteError(model) ? model : observation;
    },
  );
  return { officialWorkflow$ };
}

function createRunWorkflowObject(
  input$: RunContextInputObject,
  { framework$ }: ReturnType<typeof createRunBodyObjects>,
  { modelRoute$ }: ReturnType<typeof createRunModelObject>,
) {
  const modelState$ = computed(async (get): Promise<RunWorkflowModelState> => {
    const [requestedFramework, modelProvider] = await Promise.all([
      get(framework$),
      get(modelRoute$),
    ]);
    if (isRouteError(requestedFramework)) {
      return requestedFramework;
    }
    if (isRouteError(modelProvider)) {
      return modelProvider;
    }
    return { requestedFramework, modelProvider };
  });
  return createRunWorkflowReadObject(input$, modelState$);
}

function createRunDisabledPaidToolsObject(input$: RunContextInputObject) {
  const readInput$ = computed(async (get) => {
    const { db, args } = await get(input$);
    return {
      db,
      orgId: args.orgId,
      userId: args.userId,
    };
  });
  const snapshot$ = createRunDisabledPaidToolsSnapshotObject(readInput$);
  return computed(async (get) => {
    return (await get(snapshot$)).toolIds;
  });
}

function createRunDisabledPaidToolsSnapshotObject(
  input$: AsyncRead<RunDisabledPaidToolsReadInput>,
) {
  return computed(async (get): Promise<DisabledPaidToolsSnapshot> => {
    const args = await get(input$);
    const { db } = args;
    const rows = await db
      .select({ toolId: userDisabledPaidTools.toolId })
      .from(userDisabledPaidTools)
      .where(
        and(
          eq(userDisabledPaidTools.orgId, args.orgId),
          eq(userDisabledPaidTools.userId, args.userId),
        ),
      )
      .orderBy(asc(userDisabledPaidTools.toolId));
    return {
      orgId: args.orgId,
      userId: args.userId,
      toolIds: rows.map((row) => {
        return row.toolId;
      }),
    };
  });
}

function createRunContextObjects(
  input$: RunContextInputObject,
  shared?: SelectedRunReadObjects,
) {
  const identity = createRunIdentityObjects(input$, shared);
  const body = createRunBodyObjects(input$, identity, shared);
  const model = shared ?? createRunModelObject(input$, body, identity);
  const selection =
    shared ?? createRunConnectorSelectionObjects(input$, identity);
  const runtime = createRunRuntimeObjects(
    input$,
    body,
    model,
    selection,
    shared,
  );
  const { userTimezone$, imageModel$ } = createRunMemberObjects(input$, shared);
  const disabledPaidTools$ = shared
    ? computed(async (get) => {
        return (await get(shared.disabledPaidTools$)).toolIds;
      })
    : createRunDisabledPaidToolsObject(input$);
  const { officialWorkflow$ } =
    shared ?? createRunWorkflowObject(input$, body, model);
  const { bodyContext$ } = body;
  const { runtimeContext$ } = runtime;
  const runContext$ = computed(
    async (get): Promise<PreparedRunContext | CreateRunErrorResult> => {
      const { args } = await get(input$);
      const gate = enforceCaptureNetworkBodiesGate(
        args.orgId,
        initialRunBody(args).captureNetworkBodies,
      );
      if (gate) {
        return gate;
      }
      const [
        bodyResult,
        runtimeResult,
        timezoneResult,
        imageResult,
        workflowResult,
        paidToolsResult,
      ] = await Promise.all([
        get(bodyContext$),
        get(runtimeContext$),
        get(userTimezone$),
        get(imageModel$),
        get(officialWorkflow$),
        get(disabledPaidTools$),
      ]);
      const bodyContext = bodyResult;
      const runtimeContext = runtimeResult;
      const userTimezone = timezoneResult;
      const selectedImageModel = imageResult;
      const officialWorkflowRun = workflowResult;
      const disabledPaidTools = paidToolsResult;
      if (isRouteError(bodyContext)) {
        return bodyContext;
      }
      if (isRouteError(runtimeContext)) {
        return runtimeContext;
      }
      if (isRouteError(officialWorkflowRun)) {
        return officialWorkflowRun;
      }
      return composePreparedRunContext({
        args,
        bodyContext,
        runtimeContext,
        userTimezone,
        selectedImageModel,
        disabledPaidTools,
        officialWorkflowRun,
        systemSkillStorageResolution: get(systemSkillStorageResolution$),
      });
    },
  );
  return { runContext$ };
}

function finalizeAtomicLaunchCommit(
  args: {
    readonly input: AtomicLaunchRunInput;
    readonly identity: LaunchRunIdentity;
    readonly launch: PreparedRunnerLaunch;
    readonly committed: AtomicLaunchCommitCompletion;
  },
  signal: AbortSignal,
): QueueFirstAgentRunResult {
  const committed = args.committed.result;
  if (isReturnableRouteError(committed, signal)) {
    return committed;
  }
  if (committed.kind === "queue-first-claim-lost") {
    flushQueueFirstClaimLostTiming({
      createArgs: args.input.args,
      identity: args.identity,
      launch: args.launch,
      timing: args.input.timing,
      phaseTiming: args.input.phaseTiming,
    });
    return committed;
  }
  return committedAtomicLaunchResponse({
    createArgs: { ...args.input.args, body: args.input.context.body },
    committed,
    transactionReturnedAt: args.committed.transactionReturnedAt,
    timing: args.input.timing,
    phaseTiming: args.input.phaseTiming,
  });
}

async function commitAtomicLaunch(
  args: {
    readonly input: AtomicLaunchRunInput;
    readonly identity: LaunchRunIdentity;
    readonly callbackRows: readonly AgentRunCallbackInsert[];
    readonly launch: PreparedRunnerLaunch;
  },
  signal: AbortSignal,
): Promise<QueueFirstAgentRunResult> {
  const { input, identity, callbackRows, launch } = args;
  const committed = await input.timing.measure(
    "api_dispatch_insert_run_with_concurrency",
    "top_level",
    async () => {
      return await commitPreparedLaunch({
        db: input.db,
        createArgs: input.args,
        enforceBuiltInCredits: input.enforceBuiltInCredits,
        context: input.context,
        identity,
        callbackRows,
        launch,
        timing: input.timing,
      });
    },
  );
  return finalizeAtomicLaunchCommit(
    { input, identity, launch, committed },
    signal,
  );
}

const createRun$ = command(
  async (
    _store,
    args: Parameters<typeof commitAtomicLaunch>[0],
    signal: AbortSignal,
  ): Promise<QueueFirstAgentRunResult> => {
    return await commitAtomicLaunch(args, signal);
  },
);

interface FailedDirectLaunchInput {
  readonly input: AtomicLaunchRunInput;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly error: unknown;
}

function failedDirectLaunchRows(
  args: FailedDirectLaunchInput,
  message: string,
): LaunchRunRowsArgs {
  const { input, identity, callbackRows } = args;
  return {
    userId: input.args.userId,
    orgId: input.args.orgId,
    identity,
    status: "failed",
    resolved: input.context.resolved,
    body: input.context.body,
    runStorageMounts: undefined,
    sessionStorageMounts: undefined,
    modelProvider: input.context.modelProvider,
    agentRunModelPin: input.args.agentRunModelPin,
    selectedImageModel: input.context.selectedImageModel,
    callbackRows,
    chatThreadId: input.args.chatThreadId,
    agentRunMetadata: input.args.agentRunMetadata,
    apiStartTime: input.args.apiStartTime,
    runnerGroup: undefined,
    launchSnapshot: input.context.launchSnapshot,
    langfuseTraceEnabled: false,
    officialWorkflowProvenance: input.context.officialWorkflowRun?.provenance,
    error: message,
    creditAdmitted: false,
  };
}

// Direct/background callers retain their failed-run response and callback
// contract. Queue-first preparation failures must leave the input untouched.
const commitFailedDirectLaunch$ = command(
  async (
    { set },
    args: FailedDirectLaunchInput,
    signal: AbortSignal,
  ): Promise<CreateRunSuccessResult | CreateRunErrorResult> => {
    const { input, identity } = args;
    if (input.args.queueFirstAssociation) {
      throw args.error;
    }
    signal.throwIfAborted();
    const message =
      args.error instanceof Error ? args.error.message : "Run failed";
    const rows = failedDirectLaunchRows(args, message);
    const committed = await input.db.transaction(async (tx) => {
      await acquireOfficialWorkflowRunCatalogAdmissionLock(
        tx,
        input.context.officialWorkflowRun,
      );
      const admissionFailure = await validateOfficialWorkflowRunForInsert(tx, {
        observation: input.context.officialWorkflowRun,
        orgId: input.args.orgId,
        userId: input.args.userId,
        agentId: input.context.resolved.agentId,
        automationId: input.args.agentRunMetadata?.workflowAutomationId,
        runStorageMounts: undefined,
        allowMissingMountsForFailedRun: true,
      });
      signal.throwIfAborted();
      if (admissionFailure) {
        return conflict(admissionFailure.message);
      }
      if (identity.shouldCreateSession) {
        await tx.insert(agentSessions).values(launchSessionValues(rows));
      }
      const createdAt = nowDate();
      await tx
        .insert(agentRuns)
        .values(
          launchRunValues(rows, createdAt, launchRunMetadataValues(rows)),
        );
      if (args.callbackRows.length > 0) {
        await tx.insert(agentRunCallbacks).values([...args.callbackRows]);
      }
      await input.args.persistProducerRunBinding?.(tx, {
        runId: identity.runId,
        status: "failed",
      });
      return { createdAt };
    });
    signal.throwIfAborted();
    if ("status" in committed) {
      return committed;
    }
    if (input.args.dispatchFailedCallbacks) {
      await tapError(
        set(
          input.args.dispatchFailedCallbacks,
          {
            db: input.db,
            runId: identity.runId,
            error: message,
            callbacks: input.args.callbacks ?? [],
          },
          signal,
        ),
        (error) => {
          L.error("Failed to dispatch failed-run callbacks", {
            runId: identity.runId,
            error,
          });
        },
      );
    }
    return {
      status: 201,
      body: {
        runId: identity.runId,
        status: "failed",
        sessionId: identity.sessionId,
        error: message,
        createdAt: committed.createdAt.toISOString(),
      },
    };
  },
);

function createLaunchObjects(
  storage?: ReturnType<typeof createAgentRunStorageObjects>,
  callbackInputs$?: SelectedAgentRunGraphSources["callbackInputs$"],
) {
  const prepareCallbacks$ = createPrepareCallbacksCommand(callbackInputs$);
  const { initializeStorageInput$, materializeStorage$ } =
    createStorageMaterializationObjects(storage);
  const createAtomicLaunchRun$ = command(
    async (
      { set },
      input: AtomicLaunchRunInput,
      signal: AbortSignal,
    ): Promise<QueueFirstAgentRunResult> => {
      const identity = prepareLaunchRunIdentity({
        resolved: input.context.resolved,
      });
      const storageInput = set(
        initializeStorageInput$,
        {
          db: input.db,
          args: atomicLaunchPayloadInput({
            createArgs: input.args,
            context: input.context,
            run: {
              id: identity.runId,
              sessionId: identity.sessionId,
              shouldCreateSession: identity.shouldCreateSession,
            },
            timing: input.timing,
          }),
        },
        signal,
      );
      const contextInput = set(prepareStorageInput$, storageInput, signal);
      // Reading the fixed storage plan begins before callback encryption; each
      // command waits only for its actual prerequisites.
      const storage = set(materializeStorage$, contextInput, signal);
      const callbacks = set(
        prepareCallbacks$,
        {
          runId: identity.runId,
          callbacks: input.args.callbacks,
          featureSwitchContext: input.context.featureSwitchContext,
          timing: input.timing,
        },
        signal,
      );
      const contextDraft = set(
        prepareStoredContextDraft$,
        contextInput,
        signal,
      );
      const joinedResources = Promise.all([storage, callbacks, contextDraft]);
      const launchResult = await settle(
        input.timing.measure(
          "api_dispatch_build_runner_job_payload",
          "top_level",
          async () => {
            const [materializedStorage, callbackRows, draft] =
              await joinedResources;
            signal.throwIfAborted();
            return {
              callbackRows,
              launch: finalizedMaterializedLaunch(materializedStorage, draft),
            };
          },
          {
            pi_launch_resources:
              input.context.piSandbox === undefined
                ? "not_required"
                : "required",
          },
        ),
        signal,
      );
      if (!launchResult.ok) {
        if (
          launchResult.error instanceof OfficialWorkflowArtifactResolutionError
        ) {
          return conflict(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE);
        }
        if (input.args.queueFirstAssociation) {
          throw launchResult.error;
        }
        // Legacy non-chat failed runs require their callback rows atomically.
        // Reuse the already-started encryption; chat failures never wait here.
        const callbackRows = await callbacks;
        signal.throwIfAborted();
        return await set(
          commitFailedDirectLaunch$,
          { input, identity, callbackRows, error: launchResult.error },
          signal,
        );
      }
      const { callbackRows, launch } = launchResult.value;
      signal.throwIfAborted();
      input.phaseTiming.checkpoint("api_dispatch_phase_prepare_launch", now());
      return await set(
        createRun$,
        { input, identity, callbackRows, launch },
        signal,
      );
    },
  );
  return { createAtomicLaunchRun$ };
}

interface PrepareAgentRunArgs {
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
  readonly checkOrgPlanStatusBeforeContext: boolean;
}

interface CompleteAgentRunArgs {
  readonly prepared: PreparedAgentRun;
  readonly finalAppendSystemPrompt: CreateRunBody["appendSystemPrompt"];
}

function createCheckUnavailableProviderCreditsCommand() {
  const { checkAdmission$ } = createRunAdmissionCheckObjects();
  return command(
    async ({ set }, args: CreateAgentRunArgs, signal: AbortSignal) => {
      return await set(
        checkAdmission$,
        {
          catalog: args.catalog,
          orgId: args.orgId,
          userId: args.userId,
          modelProviderType: "built-in",
          selectedModel: args.selectedModelOverride,
          enforceBuiltInCredits: true,
        },
        signal,
      );
    },
  );
}

function createPrepareAgentRunCommand(
  internalContextInput$: State<PrepareRunContextInput | null>,
  runContext$: Computed<Promise<PreparedRunContext | CreateRunErrorResult>>,
) {
  const { checkPlanStatus$ } = createRunAdmissionCheckObjects();
  const checkUnavailableProviderCredits$ =
    createCheckUnavailableProviderCreditsCommand();
  const prepareAgentRun$ = command(
    async (
      { get, set },
      input: PrepareAgentRunArgs,
      signal: AbortSignal,
    ): Promise<PreparedAgentRun | CreateRunErrorResult> => {
      assertThreadBoundRunHasQueueAssociation(input.args);
      // A preview request that passed the protection guard carries the bypass as
      // API-authored environment while the runner preserves its existing filter.
      const previewAutomationBypass = get(previewAutomationBypass$);
      const requestArgs = previewAutomationBypass
        ? {
            ...input.args,
            platformEnvironment: {
              ...input.args.platformEnvironment,
              [VERCEL_AUTOMATION_BYPASS_ENV]: previewAutomationBypass,
            },
          }
        : input.args;
      // The requested model resolves against the run's catalog snapshot with
      // the queue pick's resolution: a provider-prefixed upstream ID names its
      // catalog model and a replaced model runs as its final replacement. An
      // ID the catalog does not know stays the provider's own model.
      const requestedModel = requestArgs.selectedModelOverride;
      const args =
        requestedModel === undefined
          ? requestArgs
          : {
              ...requestArgs,
              selectedModelOverride:
                resolveRunSelectionModel(requestArgs.catalog, requestedModel) ??
                requestedModel,
            };
      const { timing } = input;
      const db = set(writeDb$);
      if (input.checkOrgPlanStatusBeforeContext) {
        const tierGate = await timing.measure(
          "api_dispatch_check_org_tier",
          "top_level",
          async () => {
            return await set(
              checkPlanStatus$,
              {
                catalog: args.catalog,
                db,
                orgId: args.orgId,
                userId: args.userId,
                modelProviderType: args.modelProviderType,
                selectedModel: args.selectedModelOverride,
                enforceBuiltInCredits: false,
              },
              signal,
            );
          },
        );
        signal.throwIfAborted();
        if (tierGate) {
          return tierGate;
        }
      }

      const contextInput: PrepareRunContextInput = { db, args, timing };
      set(internalContextInput$, contextInput);
      const context = await timing.measure(
        "api_dispatch_prepare_run_context",
        "top_level",
        async () => {
          return await get(runContext$);
        },
      );
      signal.throwIfAborted();
      if ("status" in context) {
        if (
          context.body.error.code === "PROVIDER_UNAVAILABLE" &&
          args.enforceBuiltInCredits &&
          isBuiltInModelProviderType(args.modelProviderType)
        ) {
          const creditFailure = await set(
            checkUnavailableProviderCredits$,
            args,
            signal,
          );
          if (creditFailure) {
            return creditFailure;
          }
        }
        return context;
      }

      input.phaseTiming.checkpoint("api_dispatch_phase_prepare_context", now());
      return {
        args,
        context,
        contextInput,
        timing,
        phaseTiming: input.phaseTiming,
      };
    },
  );

  return prepareAgentRun$;
}

function createCompleteAgentRunCommand(
  createAtomicLaunchRun$: ReturnType<
    typeof createLaunchObjects
  >["createAtomicLaunchRun$"],
) {
  const { checkAdmission$ } = createRunAdmissionCheckObjects();
  const completeAgentRun$ = command(
    async (
      { set },
      input: CompleteAgentRunArgs,
      signal: AbortSignal,
    ): Promise<QueueFirstAgentRunResult> => {
      assertThreadBoundRunHasQueueAssociation(input.prepared.args);
      const db = set(writeDb$);
      const { args, timing } = input.prepared;
      const context = finalizePreparedRunContext(
        input.prepared,
        input.finalAppendSystemPrompt,
      );
      signal.throwIfAborted();

      const modelProviderType =
        context.modelProvider?.type ?? args.modelProviderType;
      const selectedModel =
        context.modelProvider?.selectedModel ?? args.selectedModelOverride;
      const enforceBuiltInCredits =
        args.enforceBuiltInCredits === true &&
        isBuiltInModelProviderType(context.modelProvider?.type);
      const admissionGate = await timing.measure(
        "api_dispatch_check_run_admission",
        "top_level",
        async () => {
          const check = () => {
            return set(
              checkAdmission$,
              {
                catalog: args.catalog,
                db,
                orgId: args.orgId,
                userId: args.userId,
                modelProviderType,
                selectedModel,
                enforceBuiltInCredits,
              },
              signal,
            );
          };
          return enforceBuiltInCredits
            ? await timing.measure(
                "api_dispatch_check_built_in_credits",
                "nested",
                check,
              )
            : await check();
        },
      );
      signal.throwIfAborted();
      if (admissionGate) {
        return admissionGate;
      }

      let launchContext = context;
      if (args.piExecution && args.piStableContext) {
        // The eager body intentionally omitted the stable prefix, so bind the
        // canonical prompt before launch.
        launchContext = finalizePreparedRunContext(
          input.prepared,
          bindStableAppendSystemPrompt(
            args.piStableContext.buildPrompt(),
            input.finalAppendSystemPrompt ??
              args.piStableContext.dynamicAppendSystemPrompt,
          ),
        );
      }

      return await set(
        createAtomicLaunchRun$,
        {
          db,
          args,
          enforceBuiltInCredits,
          context: launchContext,
          timing,
          phaseTiming: input.prepared.phaseTiming,
        },
        signal,
      );
    },
  );

  return completeAgentRun$;
}

export function createAgentRunExecutionObjects() {
  const { createAtomicLaunchRun$ } = createLaunchObjects();
  const internalContextInput$ = state<PrepareRunContextInput | null>(null);
  const contextInput$ = computed((get) => {
    const input = get(internalContextInput$);
    if (!input) {
      throw new Error("Run preparation input is not installed");
    }
    return input;
  });
  const { runContext$ } = createRunContextObjects(contextInput$);
  const prepareAgentRun$ = createPrepareAgentRunCommand(
    internalContextInput$,
    runContext$,
  );
  const completeAgentRun$ = createCompleteAgentRunCommand(
    createAtomicLaunchRun$,
  );
  return { runContext$, prepareAgentRun$, completeAgentRun$ };
}

function assertThreadBoundAgentRunHasQueueAssociation(
  args: AnyCreateAgentRunCommandArgs,
): void {
  if (!("queueFirstAssociation" in args)) {
    if (args.chatThreadId !== undefined) {
      throw new Error(
        "Thread-bound agent run requires a queue-first association",
      );
    }
    return;
  }
  if (args.queueFirstAssociation.threadId !== args.chatThreadId) {
    throw new Error(
      "Queue-first association must target the run's chat thread",
    );
  }
}

type BootstrapCountBucket = "0" | "1" | "2_4" | "5_8" | "9_16" | "17_plus";

function bootstrapCountBucket(count: number): BootstrapCountBucket {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

export function bootstrapLoadTimingDimensions(
  rows: RunBootstrapSnapshotRows | undefined,
): ApiDispatchTimingDimensions | undefined {
  if (!rows) {
    return undefined;
  }
  return {
    agent_run_bootstrap_total_row_count_bucket: bootstrapCountBucket(
      rows.metadataRows.length + rows.workflowRows.length,
    ),
    agent_run_bootstrap_workflow_candidate_count_bucket: bootstrapCountBucket(
      rows.workflowRows.length,
    ),
  };
}

export function bootstrapMaterializeTimingDimensions(
  rows: RunBootstrapSnapshotRows,
  context: RunBootstrapContext | undefined,
): ApiDispatchTimingDimensions {
  return {
    ...bootstrapLoadTimingDimensions(rows),
    ...(context
      ? {
          agent_run_bootstrap_workflow_winner_count_bucket:
            bootstrapCountBucket(context.workflows.length),
        }
      : {}),
  };
}

function serviceEntryTiming(args: {
  readonly apiStartTime: number;
  readonly timing?: ApiDispatchTimingCollector;
}): ApiDispatchTimingCollector {
  const timing = args.timing ?? new ApiDispatchTimingCollector();
  if (!args.timing) {
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_entrypoint_gap",
      "nested",
      args.apiStartTime,
    );
  }
  return timing;
}

export const bootstrapMetadataRowKindDecoder = zodEnumDriverValueDecoder(
  bootstrapMetadataRowKindSchema,
);

const bootstrapMetadataSwitchesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.boolean()),
);

const customConnectorPermissionNamesDecoder = zodDriverValueDecoder(
  z.array(z.string()),
);

const permissionGrantActionDecoder = zodEnumDriverValueDecoder(
  userPermissionGrantActionSchema,
);

export const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);

const nullableBooleanDecoder = nullableDriverValueDecoder(pgBooleanDecoder);

export const nullableBootstrapMetadataSwitchesDecoder =
  nullableDriverValueDecoder(bootstrapMetadataSwitchesDecoder);

export const nullablePermissionGrantActionDecoder = nullableDriverValueDecoder(
  permissionGrantActionDecoder,
);

const nullablePermissionGrantExpiresAtDecoder = nullableDriverValueDecoder(
  userPermissionGrants.expiresAt,
);

const nullableCustomConnectorPermissionNamesDecoder =
  nullableDriverValueDecoder(customConnectorPermissionNamesDecoder);

const nullableCustomConnectorStorageVersionDecoder = nullableDriverValueDecoder(
  orgCustomConnectors.storageVersion,
);

interface RunBootstrapSnapshotArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly checkedAt: Date;
}

export interface RunBootstrapSnapshotRows {
  readonly metadataRows: readonly BootstrapMetadataQueryRow[];
  readonly workflowRows: readonly RunWorkflowSourceRow[];
}

export function emptyBootstrapMetadataFields() {
  return {
    id: sql`NULL::text`.mapWith(nullableTextDecoder).as("id"),
    name: sql`NULL::text`.mapWith(nullableTextDecoder).as("name"),
    email: sql`NULL::text`.mapWith(nullableTextDecoder).as("email"),
    timezone: sql`NULL::text`.mapWith(nullableTextDecoder).as("timezone"),
    featureUserId: sql`NULL::text`
      .mapWith(nullableTextDecoder)
      .as("feature_user_id"),
    switches: sql`NULL::jsonb`
      .mapWith(nullableBootstrapMetadataSwitchesDecoder)
      .as("switches"),
    detail: sql`NULL::text`.mapWith(nullableTextDecoder).as("detail"),
    action: sql`NULL::text`
      .mapWith(nullablePermissionGrantActionDecoder)
      .as("action"),
    permissionNames: sql`NULL::text[]`
      .mapWith(nullableCustomConnectorPermissionNamesDecoder)
      .as("permission_names"),
    permissionBundleRef: sql`NULL::text`
      .mapWith(nullableTextDecoder)
      .as("permission_bundle_ref"),
    storageVersion: sql`NULL::bigint`
      .mapWith(nullableCustomConnectorStorageVersionDecoder)
      .as("storage_version"),
    skillStorageVersionId: sql`NULL::text`
      .mapWith(nullableTextDecoder)
      .as("skill_storage_version_id"),
    isMcp: sql`NULL::boolean`.mapWith(nullableBooleanDecoder).as("is_mcp"),
    expiresAt: sql`NULL::timestamp`
      .mapWith(nullablePermissionGrantExpiresAtDecoder)
      .as("expires_at"),
  };
}

function agentRunCustomConnectorMetadataQuery(
  db: ReadonlyDb,
  args: RunBootstrapSnapshotArgs,
) {
  return db
    .select({
      kind: sql`'custom_connector'`
        .mapWith(bootstrapMetadataRowKindDecoder)
        .as("kind"),
      ...emptyBootstrapMetadataFields(),
      id: sql`${userCustomConnectors.customConnectorId}::text`
        .mapWith(nullableTextDecoder)
        .as("id"),
      detail: sql`${orgCustomConnectors.slug}`
        .mapWith(nullableTextDecoder)
        .as("detail"),
      permissionNames: sql`${userCustomConnectors.permissionNames}`
        .mapWith(nullableCustomConnectorPermissionNamesDecoder)
        .as("permission_names"),
      permissionBundleRef: sql`${orgCustomConnectors.permissionBundleRef}`
        .mapWith(nullableTextDecoder)
        .as("permission_bundle_ref"),
      storageVersion: orgCustomConnectors.storageVersion,
      skillStorageVersionId: sql`${orgCustomConnectors.skillStorageVersionId}`
        .mapWith(nullableTextDecoder)
        .as("skill_storage_version_id"),
      isMcp: isNotNull(orgCustomConnectors.mcpEndpoint)
        .mapWith(pgBooleanDecoder)
        .as("is_mcp"),
    })
    .from(userCustomConnectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, userCustomConnectors.customConnectorId),
        eq(orgCustomConnectors.orgId, userCustomConnectors.orgId),
      ),
    )
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
        eq(orgCustomConnectors.enabled, true),
      ),
    );
}

function requireCustomConnectorMcpFlag(value: boolean | null): boolean {
  if (value === null) {
    throw new Error("Custom connector MCP classification is unavailable");
  }
  return value;
}

function materializeBootstrapFeatureSwitchContext(args: {
  readonly scope: { readonly userId: string; readonly orgId: string };
  readonly userInfo: UserInfo;
  readonly rows: readonly UserFeatureSwitchOverrideRow[];
  readonly preloaded?: FeatureSwitchContext;
}): FeatureSwitchContext {
  const context: FeatureSwitchContext = args.preloaded
    ? {
        ...args.preloaded,
        email: args.preloaded.email ?? args.userInfo.email ?? undefined,
      }
    : {
        orgId: args.scope.orgId,
        userId: args.scope.userId,
        email: args.userInfo.email ?? undefined,
        overrides: userFeatureSwitchOverridesFromRows(
          args.rows,
          args.scope.userId,
        ),
      };
  if (
    context.userId !== args.scope.userId ||
    context.orgId !== args.scope.orgId
  ) {
    throw new Error("Preloaded feature-switch context scope mismatch");
  }
  return context;
}

export function materializeRunBootstrapContext(
  rows: RunBootstrapSnapshotRows,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
  observedFeatureSwitchContext?: FeatureSwitchContext,
): RunBootstrapContext {
  let userInfo: UserInfo = {
    name: null,
    email: null,
    timezone: null,
  };
  const featureSwitchRows: UserFeatureSwitchOverrideRow[] = [];
  const connectorRows: AgentConnectorSlugRow[] = [];
  const customConnectorRows: AgentCustomConnectorRow[] = [];
  const connectorCatalogMetadataSlugs = new Set<ConnectorSlug>();
  const permissionGrants: FirewallPermissionGrant[] = [];

  for (const row of rows.metadataRows) {
    switch (row.kind) {
      case "user_info": {
        userInfo = {
          name: row.name,
          email: row.email,
          timezone: row.timezone,
        };
        break;
      }
      case "feature_switch": {
        if (row.featureUserId === null || row.switches === null) {
          throw new Error("Invalid bootstrap metadata feature-switch row");
        }
        featureSwitchRows.push({
          userId: row.featureUserId,
          switches: row.switches,
        });
        break;
      }
      case "builtin_connector": {
        if (row.name === null) {
          throw new Error("Invalid bootstrap metadata connector row");
        }
        connectorRows.push({ connectorSlug: row.name });
        break;
      }
      case "custom_connector": {
        if (
          row.id === null ||
          row.detail === null ||
          row.permissionNames === null ||
          row.storageVersion === null
        ) {
          throw new Error("Invalid bootstrap metadata custom connector row");
        }
        customConnectorRows.push({
          customConnectorId: row.id,
          permissionNames: row.permissionNames,
          connectorSlug: row.detail,
          storageVersion: row.storageVersion,
          skillStorageVersionId: row.skillStorageVersionId,
          isMcp: requireCustomConnectorMcpFlag(row.isMcp),
        });
        if (row.permissionBundleRef !== null) {
          const dependency = customConnectorPermissionBundleDependencySlug(
            row.permissionBundleRef,
          );
          if (dependency !== null) {
            connectorCatalogMetadataSlugs.add(dependency);
          }
        }
        break;
      }
      case "permission_grant": {
        if (row.name === null || row.detail === null || row.action === null) {
          throw new Error("Invalid bootstrap metadata permission grant row");
        }
        permissionGrants.push({
          connectorSlug: row.name,
          permission: row.detail,
          action: row.action,
        });
        break;
      }
    }
  }

  permissionGrants.sort((left, right) => {
    return (
      left.connectorSlug.localeCompare(right.connectorSlug) ||
      left.permission.localeCompare(right.permission)
    );
  });
  const connectorScope = agentConnectorScopeFromRows({
    connectorRows,
    customConnectorRows,
  });
  const featureSwitchContext = materializeBootstrapFeatureSwitchContext({
    scope: args,
    userInfo,
    rows: featureSwitchRows,
    preloaded: observedFeatureSwitchContext,
  });

  return {
    userInfo,
    featureSwitchContext,
    ...connectorScope,
    workflows: workflowsForRunFromRows(rows.workflowRows, args.userId),
    permissionGrants,
    permissionValidityHorizon: permissionValidityHorizon(rows.metadataRows),
    connectorCatalogMetadataSlugs: [...connectorCatalogMetadataSlugs].sort(),
  };
}
export interface AgentRunSelectionGraphInput {
  readonly command: AgentRunSelectionInput;
  readonly db: Db;
  readonly timing: ApiDispatchTimingCollector;
}
export interface SelectedAgentRunGraphSources {
  readonly identityInput$: AsyncRead<AgentRunIdentityInput | null>;
  readonly selectionInput$: AsyncRead<AgentRunSelectionGraphInput | null>;
  readonly threadSession$?: AsyncRead<ChatThreadSessionResolution | undefined>;
  readonly command$: AsyncRead<AnyCreateAgentRunCommandArgs | null>;
  readonly featureSwitchContext$?: AsyncRead<FeatureSwitchContext | undefined>;
  readonly callbackInputs$?: AsyncRead<CreateAgentRunCommandArgs["callbacks"]>;
  readonly connectorSourceId$?: AsyncRead<string | null | undefined>;
  readonly memberAccountSnapshot$?: AsyncRead<
    MemberModelAccountSnapshot | null | undefined
  >;
  readonly storageBody$?: AsyncRead<
    Pick<CreateAgentRunCommandArgs["body"], "additionalVolumes">
  >;
}

function createPreCreateInternalInput() {
  return state<{
    readonly timing: ApiDispatchTimingCollector;
    readonly command: AnyCreateAgentRunCommandArgs;
  } | null>(null);
}

function createPreCreateInput(
  internalInput$: ReturnType<typeof createPreCreateInternalInput>,
  source$?: AsyncRead<AgentRunSelectionGraphInput | null>,
) {
  return computed(async (get): Promise<AgentRunGraphInput> => {
    const input = source$ ? await get(source$) : get(internalInput$);
    if (!input) {
      throw new Error("Agent preparation has no selected input");
    }
    return input;
  });
}

function createPreCreateAgentId(
  input$: ReturnType<typeof createPreCreateInput>,
) {
  const agentId$ = computed(async (get) => {
    const { command: args, timing } = await get(input$);
    const db = get(db$);
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_resolve_agent_id",
      async () => {
        if (args.body.agentId) {
          return args.body.agentId;
        }
        if (!args.body.sessionId) {
          return null;
        }
        const [session] = await db
          .select({ agentId: agentSessions.agentId })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.id, args.body.sessionId),
              eq(agentSessions.userId, args.auth.userId),
              eq(agentSessions.orgId, args.auth.orgId),
            ),
          )
          .limit(1);
        return session?.agentId ?? null;
      },
    );
  });
  return agentId$;
}

function createPreCreateRequestObservation(
  input$: ReturnType<typeof createPreCreateInput>,
  agentId$: ReturnType<typeof createPreCreateAgentId>,
) {
  const requestObservation$ = computed(async (get) => {
    const { command } = await get(input$);
    const agentId = await get(agentId$);
    return agentId
      ? matchingAuthorizedRequestObservation(command, agentId)
      : undefined;
  });
  return requestObservation$;
}

function createPreCreateFeatureSwitchObservation(
  requestObservation$: ReturnType<typeof createPreCreateRequestObservation>,
) {
  return computed(async (get) => {
    return (await get(requestObservation$))?.featureSwitchContext;
  });
}

function createPreCreateAgent(
  input$: ReturnType<typeof createPreCreateInput>,
  agentId$: ReturnType<typeof createPreCreateAgentId>,
  requestObservation$: ReturnType<typeof createPreCreateRequestObservation>,
) {
  const agent$ = computed(async (get): Promise<AgentRunRecord | null> => {
    const { timing } = await get(input$);
    const db = get(db$);
    const [agentId, observation] = await Promise.all([
      get(agentId$),
      get(requestObservation$),
    ]);
    if (!agentId) {
      return null;
    }
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_load_agent",
      async () => {
        if (observation) {
          return observation.agent;
        }
        const [agent] = await db
          .select({
            id: agents.id,
            name: agents.name,
            orgId: agents.orgId,
            defaultAgentId: orgMetadata.defaultAgentId,
            owner: agents.owner,
            visibility: agents.visibility,
            displayName: agents.displayName,
            description: agents.description,
            sound: agents.sound,
            modelProviderId: agents.modelProviderId,
            selectedModel: agents.selectedModel,
          })
          .from(agents)
          .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
          .where(eq(agents.id, agentId))
          .limit(1);
        return agent ?? null;
      },
      {
        authorized_request_agent_source:
          observation === undefined ? "database" : "request_observation",
      },
    );
  });
  return agent$;
}

function createPreCreateBootstrapQueryArgs(
  input$: ReturnType<typeof createPreCreateInput>,
  agent$: ReturnType<typeof createPreCreateAgent>,
) {
  const bootstrapQueryArgs$ = computed(async (get) => {
    const { command } = await get(input$);
    const agent = await get(agent$);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return {
      userId: command.auth.userId,
      orgId: command.auth.orgId,
      agentId: agent.id,
      checkedAt: new Date(command.apiStartTime),
    };
  });
  return bootstrapQueryArgs$;
}

function createPreCreateBootstrapMetadataRows(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapQueryArgs$: ReturnType<typeof createPreCreateBootstrapQueryArgs>,
  featureSwitchObservation$: AsyncRead<FeatureSwitchContext | undefined>,
) {
  const bootstrapMetadataRows$ = computed(
    async (get): Promise<BootstrapMetadataQueryRow[]> => {
      await get(input$);
      const db = get(db$);
      const [args, featureContext] = await Promise.all([
        get(bootstrapQueryArgs$),
        get(featureSwitchObservation$),
      ]);
      const includeFeatureSwitches = featureContext === undefined;
      const userInfoQuery = db
        .select({
          kind: sql`'user_info'`
            .mapWith(bootstrapMetadataRowKindDecoder)
            .as("kind"),
          ...emptyBootstrapMetadataFields(),
          name: userCache.name,
          email: sql`${userCache.email}`
            .mapWith(nullableTextDecoder)
            .as("email"),
          timezone: orgMembersMetadata.timezone,
        })
        .from(userCache)
        .leftJoin(
          orgMembersMetadata,
          and(
            eq(orgMembersMetadata.userId, args.userId),
            eq(orgMembersMetadata.orgId, args.orgId),
          ),
        )
        .where(eq(userCache.userId, args.userId));
      const featureSwitchQuery = db
        .select({
          kind: sql`'feature_switch'`
            .mapWith(bootstrapMetadataRowKindDecoder)
            .as("kind"),
          ...emptyBootstrapMetadataFields(),
          featureUserId: sql`${userFeatureSwitches.userId}`
            .mapWith(nullableTextDecoder)
            .as("feature_user_id"),
          switches: sql`${userFeatureSwitches.switches}`
            .mapWith(nullableBootstrapMetadataSwitchesDecoder)
            .as("switches"),
        })
        .from(userFeatureSwitches)
        .where(
          and(
            eq(userFeatureSwitches.orgId, args.orgId),
            inArray(userFeatureSwitches.userId, [
              args.userId,
              ORG_SENTINEL_USER_ID,
            ]),
          ),
        );
      const builtinConnectorQuery = db
        .select({
          kind: sql`'builtin_connector'`
            .mapWith(bootstrapMetadataRowKindDecoder)
            .as("kind"),
          ...emptyBootstrapMetadataFields(),
          name: sql`${userBuiltinConnectors.connectorSlug}`
            .mapWith(nullableTextDecoder)
            .as("name"),
        })
        .from(userBuiltinConnectors)
        .where(
          and(
            eq(userBuiltinConnectors.orgId, args.orgId),
            eq(userBuiltinConnectors.userId, args.userId),
            eq(userBuiltinConnectors.agentId, args.agentId),
          ),
        );
      const customConnectorQuery = agentRunCustomConnectorMetadataQuery(
        db,
        args,
      );
      const permissionGrantQuery = db
        .select({
          kind: sql`'permission_grant'`
            .mapWith(bootstrapMetadataRowKindDecoder)
            .as("kind"),
          ...emptyBootstrapMetadataFields(),
          name: sql`${userPermissionGrants.connectorSlug}`
            .mapWith(nullableTextDecoder)
            .as("name"),
          detail: sql`${userPermissionGrants.permission}`
            .mapWith(nullableTextDecoder)
            .as("detail"),
          action: sql`${userPermissionGrants.action}`
            .mapWith(nullablePermissionGrantActionDecoder)
            .as("action"),
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, args.orgId),
            eq(userPermissionGrants.userId, args.userId),
            eq(userPermissionGrants.agentId, args.agentId),
            activeUserPermissionGrantCondition(args.checkedAt),
          ),
        );
      if (includeFeatureSwitches) {
        return await unionAll(
          userInfoQuery,
          featureSwitchQuery,
          builtinConnectorQuery,
          customConnectorQuery,
          permissionGrantQuery,
        );
      }
      return await unionAll(
        userInfoQuery,
        builtinConnectorQuery,
        customConnectorQuery,
        permissionGrantQuery,
      );
    },
  );
  return bootstrapMetadataRows$;
}

function createPreCreateWorkflowRows(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapQueryArgs$: ReturnType<typeof createPreCreateBootstrapQueryArgs>,
) {
  const workflowRows$ = computed(
    async (get): Promise<RunWorkflowSourceRow[]> => {
      await get(input$);
      const db = get(db$);
      const args = await get(bootstrapQueryArgs$);
      return await db
        .select({
          id: workflows.id,
          name: workflows.name,
          visibility: workflows.visibility,
          ownerUserId: workflows.ownerUserId,
          officialDefinitionName: workflows.officialDefinitionName,
          createdAt: workflows.createdAt,
        })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, args.orgId),
            eq(workflows.agentId, args.agentId),
            or(
              isNull(workflows.officialDefinitionName),
              eq(workflows.officialInstallationState, "installed"),
            ),
            or(
              eq(workflows.visibility, "public"),
              eq(workflows.ownerUserId, args.userId),
            ),
          ),
        );
    },
  );
  return workflowRows$;
}

function createPreCreateBootstrapRows(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapMetadataRows$: ReturnType<
    typeof createPreCreateBootstrapMetadataRows
  >,
  workflowRows$: ReturnType<typeof createPreCreateWorkflowRows>,
) {
  const bootstrapRows$ = computed(
    async (get): Promise<RunBootstrapSnapshotRows> => {
      const { timing } = await get(input$);
      let snapshot: RunBootstrapSnapshotRows | undefined;
      return await measureAgentRunPreCreate(
        timing,
        "api_dispatch_pre_create_agent_load_bootstrap_snapshot_rows",
        async () => {
          const [metadataRows, workflowRows] = await Promise.all([
            get(bootstrapMetadataRows$),
            get(workflowRows$),
          ]);
          snapshot = { metadataRows, workflowRows };
          return snapshot;
        },
        () => {
          return bootstrapLoadTimingDimensions(snapshot);
        },
      );
    },
  );
  return bootstrapRows$;
}

function createPreCreateBootstrapMetadata(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapMetadataRows$: ReturnType<
    typeof createPreCreateBootstrapMetadataRows
  >,
  featureSwitchObservation$: AsyncRead<FeatureSwitchContext | undefined>,
) {
  return computed(async (get) => {
    const { command } = await get(input$);
    const [metadataRows, featureContext] = await Promise.all([
      get(bootstrapMetadataRows$),
      get(featureSwitchObservation$),
    ]);
    return materializeRunBootstrapContext(
      { metadataRows, workflowRows: [] },
      { userId: command.auth.userId, orgId: command.auth.orgId },
      featureContext,
    );
  });
}

function createPreCreateBootstrap(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapRows$: ReturnType<typeof createPreCreateBootstrapRows>,
  bootstrapMetadata$: ReturnType<typeof createPreCreateBootstrapMetadata>,
) {
  const bootstrap$ = computed(async (get) => {
    const { command, timing } = await get(input$);
    const [rows, metadata] = await Promise.all([
      get(bootstrapRows$),
      get(bootstrapMetadata$),
    ]);
    let context: RunBootstrapContext | undefined;
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_materialize_bootstrap_context",
      () => {
        context = {
          ...metadata,
          workflows: workflowsForRunFromRows(
            rows.workflowRows,
            command.auth.userId,
          ),
        };
        return context;
      },
      () => {
        return bootstrapMaterializeTimingDimensions(rows, context);
      },
    );
  });
  return bootstrap$;
}

function createPreCreateSubscriptionAccount(
  input$: ReturnType<typeof createPreCreateInput>,
  snapshot$?: AsyncRead<MemberModelAccountSnapshot | null | undefined>,
) {
  const subscriptionAccount$ = computed(
    async (
      get,
    ): Promise<
      | {
          readonly command: AgentRunIdentityCommand;
          readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
        }
      | ReturnType<typeof conflict>
    > => {
      const { command, timing } = await get(input$);
      const db = get(db$);
      const pin = command.agentRunModelPin;
      if (
        !pin ||
        !pin.modelProvider ||
        !isPersonalSubscriptionProviderType(pin.modelProvider) ||
        pin.modelProviderCredentialScope === "org"
      ) {
        return { command };
      }
      const providerType = pin.modelProvider;
      await observeAgentRunPreCreateParallelStage("subscription-account", {
        command,
      });
      return await measureAgentRunPreCreate(
        timing,
        "api_dispatch_pre_create_agent_capture_subscription_account",
        async () => {
          const preloaded = personalSubscriptionAccountCandidates({
            command,
            providerType,
            modelProviderId: pin.modelProviderId,
            snapshot: snapshot$ ? await get(snapshot$) : undefined,
          });
          const accountCandidates =
            preloaded ??
            (await db
              .select()
              .from(modelProviderAccounts)
              .where(
                and(
                  eq(modelProviderAccounts.orgId, command.auth.orgId),
                  eq(modelProviderAccounts.userId, command.auth.userId),
                  isNull(modelProviderAccounts.disconnectedAt),
                  pin.modelProviderId === null
                    ? and(
                        eq(modelProviderAccounts.type, providerType),
                        eq(modelProviderAccounts.isActive, true),
                      )
                    : or(
                        eq(modelProviderAccounts.id, pin.modelProviderId),
                        and(
                          eq(
                            modelProviderAccounts.modelProviderId,
                            pin.modelProviderId,
                          ),
                          eq(modelProviderAccounts.type, providerType),
                          eq(modelProviderAccounts.isActive, true),
                        ),
                      ),
                ),
              )
              .limit(pin.modelProviderId === null ? 1 : 2));
          const account =
            accountCandidates.find((candidate) => {
              return candidate.id === pin.modelProviderId;
            }) ?? accountCandidates[0];
          if (!account || account.type !== providerType) {
            return conflict(
              "The selected subscription account is unavailable. Reconnect it before starting another run.",
            );
          }
          return {
            capturedPersonalSubscriptionAccount: {
              id: account.id,
              orgId: account.orgId,
              userId: account.userId,
              type: providerType,
            },
            command: {
              ...command,
              modelProviderId: account.id,
              agentRunModelPin: { ...pin, modelProviderId: account.id },
            },
          };
        },
      );
    },
  );
  return subscriptionAccount$;
}

function createPreCreateModelObjects(
  input$: ReturnType<typeof createPreCreateInput>,
  agent$: ReturnType<typeof createPreCreateAgent>,
  bootstrapMetadata$: ReturnType<typeof createPreCreateBootstrapMetadata>,
  subscriptionAccount$: ReturnType<typeof createPreCreateSubscriptionAccount>,
  catalog$: AsyncRead<ModelCatalog>,
) {
  const providerInput$ = computed(
    async (get): Promise<RunModelProviderReadInput | CreateRunErrorResult> => {
      const input = await get(input$);
      const [agent, account, catalog] = await Promise.all([
        get(agent$),
        get(subscriptionAccount$),
        get(catalog$),
      ]);
      if ("status" in account) {
        return account;
      }
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      return {
        db: get(db$),
        timing: input.timing,
        args: {
          ...selectedRunModelProviderArgs(
            account.command,
            agent,
            account.capturedPersonalSubscriptionAccount,
          ),
          catalog,
        },
      };
    },
  );
  const content$ = computed(async (get) => {
    const agent = await get(agent$);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return buildAgentExecutionConfig(agent.name);
  });
  const featureSwitchContext$ = computed(async (get) => {
    return (await get(bootstrapMetadata$)).featureSwitchContext;
  });
  const framework$ = createRunFrameworkObject(providerInput$, content$);
  const { modelRoute$ } = createRunModelProviderObjects(
    providerInput$,
    { framework$ },
    { content$, featureSwitchContext$ },
  );
  return {
    providerInput$,
    content$,
    featureSwitchContext$,
    framework$,
    modelRoute$,
  };
}

function createPreCreateOfficialWorkflowObjects(
  input$: ReturnType<typeof createPreCreateInput>,
  workflowRows$: ReturnType<typeof createPreCreateWorkflowRows>,
  { framework$, modelRoute$ }: ReturnType<typeof createPreCreateModelObjects>,
  catalog$: AsyncRead<ModelCatalog>,
) {
  const workflowInput$ = computed(
    async (get): Promise<RunWorkflowReadInput> => {
      const { command } = await get(input$);
      const db = get(db$);
      const workflows = workflowsForRunFromRows(
        await get(workflowRows$),
        command.auth.userId,
      );
      return {
        db,
        args: {
          catalog: await get(catalog$),
          orgId: command.auth.orgId,
          userId: command.auth.userId,
          injectSkillVolumes: { workflows },
          requiredOfficialWorkflowIds: command.requiredOfficialWorkflowIds,
          piExecution: selectedRunPiExecution(command),
          codexServiceTier: command.codexServiceTier,
          agentRunMetadata: { reasoningEffort: command.reasoningEffort },
        },
      };
    },
  );
  const modelState$ = computed(async (get): Promise<RunWorkflowModelState> => {
    const [requestedFramework, modelProvider] = await Promise.all([
      get(framework$),
      get(modelRoute$),
    ]);
    if (isRouteError(requestedFramework)) {
      return requestedFramework;
    }
    if (isRouteError(modelProvider)) {
      return modelProvider;
    }
    return { requestedFramework, modelProvider };
  });
  const { officialWorkflow$ } = createRunWorkflowReadObject(
    workflowInput$,
    modelState$,
  );
  return { officialWorkflow$ };
}

function createPreCreateConnectorCatalog(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapMetadata$: ReturnType<typeof createPreCreateBootstrapMetadata>,
) {
  const catalogInput$ = computed(async (get) => {
    const { timing } = await get(input$);
    const db = get(db$);
    return { db, timing };
  });
  const requestedSlugs$ = computed(async (get) => {
    const bootstrap = await get(bootstrapMetadata$);
    return {
      requestedConnectorSlugs: bootstrap.allowedConnectorSlugs,
      metadataConnectorSlugs: bootstrap.connectorCatalogMetadataSlugs,
    };
  });
  const { connectorCatalog$: selectedCatalog$ } =
    createConnectorRuntimeSelectionObjects(catalogInput$, requestedSlugs$);
  const connectorCatalog$ = computed(
    async (get): Promise<RunConnectorCatalogSelection> => {
      const [{ command }, bootstrap] = await Promise.all([
        get(input$),
        get(bootstrapMetadata$),
      ]);
      await observeAgentRunPreCreateParallelStage(
        "post-authorization-context",
        { command },
      );
      return isEmptyRunConnectorScope(bootstrap)
        ? { kind: "empty" }
        : { kind: "scoped", selection: await get(selectedCatalog$) };
    },
  );
  return connectorCatalog$;
}

function createPreCreatePermissionPolicies(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapMetadata$: ReturnType<typeof createPreCreateBootstrapMetadata>,
  connectorCatalog$: ReturnType<typeof createPreCreateConnectorCatalog>,
) {
  const permissionPolicies$ = computed(async (get) => {
    const { timing } = await get(input$);
    const [bootstrap, catalog] = await Promise.all([
      get(bootstrapMetadata$),
      get(connectorCatalog$),
    ]);
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_resolve_firewall_metadata",
      async () => {
        const stored = permissionGrantsToFirewallPolicies(
          bootstrap.permissionGrants,
        );
        return catalog.kind === "empty"
          ? stored
          : await expandConnectorServerFirewallPolicies({
              catalog: catalog.selection.serverFirewalls,
              stored,
              connectorSlugs: [...bootstrap.allowedConnectorSlugs],
            });
      },
    );
  });
  return permissionPolicies$;
}

function createPreCreateThreadSession(
  input$: ReturnType<typeof createPreCreateInput>,
  agent$: ReturnType<typeof createPreCreateAgent>,
) {
  const threadSession$ = computed(
    async (get): Promise<ChatThreadSessionResolution | undefined> => {
      const { command, timing } = await get(input$);
      const db = get(db$);
      if (!command.chatThreadId) {
        return undefined;
      }
      const agent = await get(agent$);
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      await observeAgentRunPreCreateParallelStage("thread-session", {
        command,
      });
      const threadId = command.chatThreadId;
      const route = command.threadSessionRoute;
      if (!route) {
        throw new Error("Thread-bound agent run is missing its model route");
      }
      return await measureAgentRunPreCreate(
        timing,
        "api_dispatch_pre_create_agent_resolve_thread_session",
        async () => {
          const [thread] = await db
            .select(chatThreadSessionSelection())
            .from(chatThreads)
            .leftJoin(
              agentSessions,
              and(
                eq(agentSessions.id, chatThreads.agentSessionId),
                eq(agentSessions.userId, command.auth.userId),
                eq(agentSessions.orgId, command.auth.orgId),
              ),
            )
            .leftJoin(agents, eq(agents.id, agent.id))
            .leftJoin(
              conversations,
              eq(conversations.id, agentSessions.conversationId),
            )
            .leftJoin(
              blobs,
              eq(blobs.hash, conversations.cliAgentSessionHistoryHash),
            )
            .leftJoin(
              chatThreadConversationRun,
              eq(chatThreadConversationRun.id, conversations.runId),
            )
            .leftJoin(
              agentRuns,
              eq(agentRuns.id, chatThreads.agentSessionRunId),
            )
            .where(
              and(
                eq(chatThreads.id, threadId),
                eq(chatThreads.userId, command.auth.userId),
                eq(
                  chatThreads.agentId,
                  command.expectedThreadAgentId ?? agent.id,
                ),
              ),
            )
            .limit(1);
          if (!thread) {
            throw new Error(
              "Chat thread not found while resolving session binding",
            );
          }
          return resolveChatThreadSessionSnapshot(thread, {
            agentId: agent.id,
            route,
          });
        },
      );
    },
  );
  return threadSession$;
}

function createPreCreateSessionPrompt(
  input$: AsyncRead<{
    readonly command: AnyCreateAgentRunCommandArgs;
    readonly timing: ApiDispatchTimingCollector;
  }>,
  threadSession$: AsyncRead<ChatThreadSessionResolution | undefined>,
) {
  const promptInput$ = computed(
    async (get): Promise<WebChatSessionPromptInput | undefined> => {
      const { command } = await get(input$);
      const resolution = await get(threadSession$);
      if (
        !command.chatThreadId ||
        !command.webChatSessionPromptContext ||
        !resolution
      ) {
        return undefined;
      }
      return {
        threadId: command.chatThreadId,
        sessionAction: resolution.action,
        context: command.webChatSessionPromptContext,
      };
    },
  );
  const { prompt$ } = createWebChatSessionPromptObjects(promptInput$);
  return computed(async (get) => {
    const { command, timing } = await get(input$);
    const input = await get(promptInput$);
    if (!input) {
      return command.appendSystemPrompt;
    }
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_web_chat_resolve_session_prompt_context",
      () => {
        return get(prompt$);
      },
    );
  });
}

function createPreCreatePostAuthorization({
  input$,
  bootstrap$,
  agent$,
  subscriptionAccount$,
  connectorCatalog$,
  permissionPolicies$,
  requestObservation$,
}: {
  input$: ReturnType<typeof createPreCreateInput>;
  bootstrap$: ReturnType<typeof createPreCreateBootstrap>;
  agent$: ReturnType<typeof createPreCreateAgent>;
  subscriptionAccount$: ReturnType<typeof createPreCreateSubscriptionAccount>;
  connectorCatalog$: ReturnType<typeof createPreCreateConnectorCatalog>;
  permissionPolicies$: ReturnType<typeof createPreCreatePermissionPolicies>;
  requestObservation$: ReturnType<typeof createPreCreateRequestObservation>;
}) {
  const postAuthorization$ = computed(
    async (
      get,
    ): Promise<AgentRunAfterPreCreate | ReturnType<typeof conflict>> => {
      const { timing } = await get(input$);
      const [
        bootstrapResult,
        agentResult,
        accountResult,
        catalogResult,
        policiesResult,
        observationResult,
      ] = await Promise.all([
        get(bootstrap$),
        get(agent$),
        get(subscriptionAccount$),
        get(connectorCatalog$),
        get(permissionPolicies$),
        get(requestObservation$),
      ]);
      const bootstrap = bootstrapResult;
      const agent = agentResult;
      const account = accountResult;
      if ("status" in account) {
        return account;
      }
      const catalog = catalogResult;
      const policies = policiesResult;
      const observation = observationResult;
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      return {
        ...bootstrap,
        ...account,
        agent,
        timing,
        cloudBrowserEnabled: undefined,
        connectorCatalogSelection: catalog,
        runPermissionPolicies: policies,
        authorizedRequestObservation: observation ?? {
          userId: account.command.auth.userId,
          orgId: account.command.auth.orgId,
          agent,
          featureSwitchContext: bootstrap.featureSwitchContext,
        },
      };
    },
  );
  return postAuthorization$;
}

function createPreCreatePreparedInput(
  postAuthorization$: ReturnType<typeof createPreCreatePostAuthorization>,
  threadSession$: AsyncRead<ChatThreadSessionResolution | undefined>,
  sessionPrompt$: AsyncRead<string | undefined>,
  command$: AsyncRead<AnyCreateAgentRunCommandArgs | null>,
  catalog$: AsyncRead<ModelCatalog>,
) {
  return computed(async (get) => {
    // One catalog snapshot per run. A queued input picked later reads the
    // catalog current at the pick, not at enqueue.
    const [input, resolution, appendSystemPrompt, fullCommand, catalog] =
      await Promise.all([
        get(postAuthorization$),
        get(threadSession$),
        get(sessionPrompt$),
        get(command$),
        get(catalog$),
      ]);
    if (!fullCommand) {
      return null;
    }
    if ("status" in input) {
      return input;
    }
    const body: AgentRunCreateBody = { ...fullCommand.body };
    if (resolution?.sessionId) {
      body.sessionId = resolution.sessionId;
    } else if (fullCommand.chatThreadId) {
      delete body.sessionId;
    }
    return {
      ...input,
      catalog,
      command: {
        ...fullCommand,
        modelProviderId: input.command.modelProviderId,
        agentRunModelPin: input.command.agentRunModelPin,
        body,
        appendSystemPrompt,
      },
      threadSessionResolution: resolution,
      cloudBrowserEnabled: resolution?.cloudBrowserEnabled,
    };
  });
}

function createPreCreateRunArgs(
  preparedInput$: ReturnType<typeof createPreCreatePreparedInput>,
) {
  const runArgs$ = computed(async (get) => {
    const input = await get(preparedInput$);
    if (!input || "status" in input) {
      return input;
    }
    return {
      input,
      args: await measureAgentRunPreCreate(
        input.timing,
        "api_dispatch_pre_create_agent_build_create_run_args",
        () => {
          return buildCreateAgentRunArgs(input);
        },
      ),
    };
  });
  return runArgs$;
}

function createPreCreateConnectorObjects(
  input$: ReturnType<typeof createPreCreateInput>,
  bootstrapMetadata$: ReturnType<typeof createPreCreateBootstrapMetadata>,
  connectorCatalog$: ReturnType<typeof createPreCreateConnectorCatalog>,
  connectorSourceId$?: AsyncRead<string | null | undefined>,
) {
  const connectorInput$ = computed(
    async (get): Promise<RunConnectorReadInput> => {
      const { command, timing } = await get(input$);
      const db = get(db$);
      return {
        db,
        timing,
        args: {
          orgId: command.auth.orgId,
          userId: command.auth.userId,
          chatThreadId: command.chatThreadId,
          connectorSourceId: connectorSourceId$
            ? ((await get(connectorSourceId$)) ?? undefined)
            : command.connectorSourceId,
          includeOkouTokenSecret: true,
        },
      };
    },
  );
  const scope$ = computed(async (get): Promise<EffectiveConnectorScope> => {
    const metadata = await get(bootstrapMetadata$);
    return {
      allowedConnectorSlugs: metadata.allowedConnectorSlugs,
      allowedCustomConnectorIds: metadata.allowedCustomConnectorIds,
      customConnectorGrants: metadata.customConnectorGrants,
      source: isEmptyRunConnectorScope(metadata) ? "empty" : "stored_agent",
    };
  });
  const featureSwitchContext$ = computed(async (get) => {
    return (await get(bootstrapMetadata$)).featureSwitchContext;
  });
  const { connectorSelection$, connectorSnapshot$ } =
    createRunConnectorReadObjects(
      connectorInput$,
      { featureSwitchContext$ },
      scope$,
      connectorCatalog$,
    );
  return { connectorSelection$, connectorSnapshot$ };
}

function createPreCreateResourceObjects(
  input$: ReturnType<typeof createPreCreateInput>,
  agent$: ReturnType<typeof createPreCreateAgent>,
) {
  const scope$ = computed(async (get) => {
    const { command } = await get(input$);
    const db = get(db$);
    return { db, orgId: command.auth.orgId, userId: command.auth.userId };
  });
  const environmentInput$ = computed(async (get) => {
    const scope = await get(scope$);
    const agent = await get(agent$);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return {
      ...scope,
      secretNames: agentEnvironmentSecretNames(
        buildAgentExecutionConfig(agent.name),
      ),
    };
  });
  return {
    disabledPaidTools$: createRunDisabledPaidToolsSnapshotObject(scope$),
    member$: createRunMemberSnapshotObject(scope$),
    environment$: createRunEnvironmentSnapshotObject(environmentInput$),
  };
}

function createPreCreateBodyEnvironmentObject({
  agent$,
  bootstrapMetadata$,
  resources,
}: {
  readonly input$: ReturnType<typeof createPreCreateInput>;
  readonly agent$: ReturnType<typeof createPreCreateAgent>;
  readonly bootstrapMetadata$: ReturnType<
    typeof createPreCreateBootstrapMetadata
  >;
  readonly resources: ReturnType<typeof createPreCreateResourceObjects>;
}) {
  const environment$ = computed(async (get) => {
    const [agent, metadata, environment] = await Promise.all([
      get(agent$),
      get(bootstrapMetadata$),
      get(resources.environment$),
    ]);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    if (isRouteError(environment)) {
      return environment;
    }
    return await resolveRunBodyEnvironment({
      content: buildAgentExecutionConfig(agent.name),
      runVars: selectedAgentRunVariables(agent.id),
      runSecrets: pendingOkouTokenSecrets(undefined),
      persistedEnvironment: environment,
      featureSwitchContext: metadata.featureSwitchContext,
      canonicalOkouRuntime: true,
    });
  });
  return environment$;
}

function createPreCreatePreparedConnectorObjects(args: {
  readonly input$: ReturnType<typeof createPreCreateInput>;
  readonly agent$: ReturnType<typeof createPreCreateAgent>;
  readonly bootstrapMetadata$: ReturnType<
    typeof createPreCreateBootstrapMetadata
  >;
  readonly permissionPolicies$: ReturnType<
    typeof createPreCreatePermissionPolicies
  >;
  readonly connectors: ReturnType<typeof createPreCreateConnectorObjects>;
  readonly model: ReturnType<typeof createPreCreateModelObjects>;
  readonly bodyEnvironment$: ReturnType<
    typeof createPreCreateBodyEnvironmentObject
  >;
}) {
  const inputs$ = computed(
    async (get): Promise<RunPreparedConnectorInputs | CreateRunErrorResult> => {
      const [
        input,
        selection,
        snapshot,
        modelProvider,
        body,
        policies,
        metadata,
        agent,
      ] = await Promise.all([
        get(args.input$),
        get(args.connectors.connectorSelection$),
        get(args.connectors.connectorSnapshot$),
        get(args.model.modelRoute$),
        get(args.bodyEnvironment$),
        get(args.permissionPolicies$),
        get(args.bootstrapMetadata$),
        get(args.agent$),
      ]);
      if (isRouteError(body)) {
        return body;
      }
      if (isRouteError(modelProvider)) {
        return modelProvider;
      }
      if (isRouteError(selection)) {
        return selection;
      }
      if (isRouteError(snapshot)) {
        return snapshot;
      }
      if (!agent) {
        throw new Error("Authorized selected run preparation is missing");
      }
      return {
        db: get(db$),
        timing: input.timing,
        connectorScope: selection.connectorScope,
        connectorCatalogSelection: selection.connectorCatalogSelection,
        body: { ...body, permissionPolicies: policies ?? undefined },
        content: buildAgentExecutionConfig(agent.name),
        modelProvider,
        ...snapshot,
        featureSwitchContext: metadata.featureSwitchContext,
      };
    },
  );
  return createRunPreparedConnectorObjects(inputs$);
}

function createPreCreateExecutionObjects(args: {
  readonly connectorSourceId$?: AsyncRead<string | null | undefined>;
  readonly input$: ReturnType<typeof createPreCreateInput>;
  readonly identityInput$: ReturnType<typeof createPreCreateInput>;
  readonly agent$: ReturnType<typeof createPreCreateAgent>;
  readonly bootstrapMetadata$: ReturnType<
    typeof createPreCreateBootstrapMetadata
  >;
  readonly subscriptionAccount$: ReturnType<
    typeof createPreCreateSubscriptionAccount
  >;
  readonly connectorCatalog$: ReturnType<
    typeof createPreCreateConnectorCatalog
  >;
  readonly permissionPolicies$: ReturnType<
    typeof createPreCreatePermissionPolicies
  >;
  readonly workflowRows$: ReturnType<typeof createPreCreateWorkflowRows>;
  readonly catalog$: AsyncRead<ModelCatalog>;
}) {
  const {
    input$,
    identityInput$,
    agent$,
    bootstrapMetadata$,
    subscriptionAccount$,
    connectorCatalog$,
    permissionPolicies$,
    workflowRows$,
  } = args;
  const resources = createPreCreateResourceObjects(identityInput$, agent$);
  const model = createPreCreateModelObjects(
    input$,
    agent$,
    bootstrapMetadata$,
    subscriptionAccount$,
    args.catalog$,
  );
  const connectors = createPreCreateConnectorObjects(
    identityInput$,
    bootstrapMetadata$,
    connectorCatalog$,
    args.connectorSourceId$,
  );
  const bodyEnvironment$ = createPreCreateBodyEnvironmentObject({
    input$: identityInput$,
    agent$,
    bootstrapMetadata$,
    resources,
  });
  const prepared = createPreCreatePreparedConnectorObjects({
    input$: identityInput$,
    agent$,
    bootstrapMetadata$,
    permissionPolicies$,
    connectors,
    model,
    bodyEnvironment$,
  });
  const workflow = createPreCreateOfficialWorkflowObjects(
    input$,
    workflowRows$,
    model,
    args.catalog$,
  );
  const userTimezone$ = computed(async (get) => {
    return (await get(bootstrapMetadata$)).userInfo.timezone ?? undefined;
  });
  return {
    ...resources,
    ...model,
    ...connectors,
    ...prepared,
    ...workflow,
    bodyEnvironment$,
    userTimezone$,
  };
}
interface SelectedRunReadObjects {
  readonly featureSwitchContext$: Computed<Promise<FeatureSwitchContext>>;
  readonly environment$: Computed<
    Promise<ScopedRunEnvironmentSnapshot | CreateRunErrorResult>
  >;
  readonly bodyEnvironment$: Computed<
    Promise<RunBodyEnvironment | CreateRunErrorResult>
  >;
  readonly framework$: Computed<
    Promise<SupportedFramework | CreateRunErrorResult>
  >;
  readonly modelRoute$: Computed<
    Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult>
  >;
  readonly connectorSelection$: RunConnectorSelectionObject;
  readonly connectorSnapshot$: Computed<
    Promise<RunConnectorContextSnapshot | CreateRunErrorResult>
  >;
  readonly connectorContext$: Computed<
    Promise<PreparedConnectorContext | CreateRunErrorResult>
  >;
  readonly officialWorkflow$: Computed<Promise<PreparedOfficialWorkflow>>;
  readonly member$: Computed<Promise<RunMemberSnapshot>>;
  readonly disabledPaidTools$: Computed<Promise<DisabledPaidToolsSnapshot>>;
  readonly userTimezone$: Computed<Promise<string | undefined>>;
}

function createAuthorizeSelectedAgentRunCommand(
  identityInput$: ReturnType<typeof createPreCreateInput>,
  agentId$: ReturnType<typeof createPreCreateAgentId>,
  agent$: ReturnType<typeof createPreCreateAgent>,
) {
  return command(async ({ get }, signal: AbortSignal) => {
    const [{ command: args }, agentId, agent] = await Promise.all([
      get(identityInput$),
      get(agentId$),
      get(agent$),
    ]);
    signal.throwIfAborted();
    if (!agentId) {
      return args.body.sessionId
        ? notFound("Session not found")
        : badRequestMessage("Missing agentId or sessionId");
    }
    if (!agent || agent.orgId !== args.auth.orgId) {
      return notFound("Agent not found");
    }
    if (agent.visibility === "private" && agent.owner !== args.auth.userId) {
      return agentRunsCreateForbidden(
        "Only the private agent owner can run this agent",
      );
    }
    return undefined;
  });
}

function createSelectedIdentityInput(
  input$: ReturnType<typeof createPreCreateInput>,
  sources?: SelectedAgentRunGraphSources,
) {
  const identityInput$ = sources
    ? computed(async (get): Promise<AgentRunGraphInput> => {
        const input = await get(sources.identityInput$);
        if (!input) {
          throw new Error("Run identity is unavailable");
        }
        return {
          timing: input.timing,
          command: {
            auth: input.auth,
            apiStartTime: input.apiStartTime,
            body: { agentId: input.agentId },
            chatThreadId: input.chatThreadId,
            expectedThreadAgentId: input.expectedThreadAgentId,
            queueFirstAssociation: input.queueFirstAssociation,
          },
        };
      })
    : input$;
  return identityInput$;
}

function createSelectedAgentRunReadGraph(
  internalInput$: ReturnType<typeof createPreCreateInternalInput>,
  sources?: SelectedAgentRunGraphSources,
) {
  const input$ = createPreCreateInput(internalInput$, sources?.selectionInput$);
  // One catalog snapshot per run creation (or queue pick): a queued input
  // reads the catalog current at the pick, not at enqueue.
  const catalog$ = computed((get) => {
    return loadModelCatalog(get(db$));
  });
  const identityInput$ = createSelectedIdentityInput(input$, sources);
  const command$ =
    sources?.command$ ??
    computed((get) => {
      return get(internalInput$)?.command ?? null;
    });
  const agentId$ = createPreCreateAgentId(identityInput$);
  const requestObservation$ = createPreCreateRequestObservation(
    identityInput$,
    agentId$,
  );
  const featureSwitchObservation$ =
    sources?.featureSwitchContext$ ??
    createPreCreateFeatureSwitchObservation(requestObservation$);
  const agent$ = createPreCreateAgent(
    identityInput$,
    agentId$,
    requestObservation$,
  );
  const bootstrapQueryArgs$ = createPreCreateBootstrapQueryArgs(
    identityInput$,
    agent$,
  );
  const bootstrapMetadataRows$ = createPreCreateBootstrapMetadataRows(
    identityInput$,
    bootstrapQueryArgs$,
    featureSwitchObservation$,
  );
  const workflowRows$ = createPreCreateWorkflowRows(
    identityInput$,
    bootstrapQueryArgs$,
  );
  const bootstrapRows$ = createPreCreateBootstrapRows(
    identityInput$,
    bootstrapMetadataRows$,
    workflowRows$,
  );
  const bootstrapMetadata$ = createPreCreateBootstrapMetadata(
    identityInput$,
    bootstrapMetadataRows$,
    featureSwitchObservation$,
  );
  const bootstrap$ = createPreCreateBootstrap(
    identityInput$,
    bootstrapRows$,
    bootstrapMetadata$,
  );
  const subscriptionAccount$ = createPreCreateSubscriptionAccount(
    input$,
    sources?.memberAccountSnapshot$,
  );
  const connectorCatalog$ = createPreCreateConnectorCatalog(
    identityInput$,
    bootstrapMetadata$,
  );
  const permissionPolicies$ = createPreCreatePermissionPolicies(
    identityInput$,
    bootstrapMetadata$,
    connectorCatalog$,
  );
  const threadSession$ =
    sources?.threadSession$ ?? createPreCreateThreadSession(input$, agent$);
  const fullInput$ = computed(async (get) => {
    const [input, fullCommand] = await Promise.all([
      get(input$),
      get(command$),
    ]);
    if (!fullCommand) {
      throw new Error("Final run input is unavailable");
    }
    return { ...input, command: fullCommand };
  });
  const sessionPrompt$ = sources
    ? computed(async (get) => {
        return (await get(command$))?.appendSystemPrompt;
      })
    : createPreCreateSessionPrompt(fullInput$, threadSession$);
  const postAuthorization$ = createPreCreatePostAuthorization({
    input$,
    bootstrap$,
    agent$,
    subscriptionAccount$,
    connectorCatalog$,
    permissionPolicies$,
    requestObservation$,
  });
  const preparedInput$ = createPreCreatePreparedInput(
    postAuthorization$,
    threadSession$,
    sessionPrompt$,
    command$,
    catalog$,
  );
  const runArgs$ = createPreCreateRunArgs(preparedInput$);
  const shared = createPreCreateExecutionObjects({
    connectorSourceId$: sources?.connectorSourceId$,
    input$,
    catalog$,
    identityInput$,
    agent$,
    bootstrapMetadata$,
    subscriptionAccount$,
    connectorCatalog$,
    permissionPolicies$,
    workflowRows$,
  });
  return {
    input$,
    catalog$,
    identityInput$,
    agentId$,
    agent$,
    threadSession$,
    runArgs$,
    bootstrap$,
    shared,
    bootstrapMetadata$,
  };
}

function createSelectedStorageInputObject(
  graph: ReturnType<typeof createSelectedAgentRunReadGraph>,
  storageBody$: NonNullable<SelectedAgentRunGraphSources["storageBody$"]>,
) {
  return computed(
    async (get): Promise<AgentRunStorageInput | CreateRunErrorResult> => {
      const [
        input,
        agent,
        session,
        requestedFramework,
        modelProvider,
        selection,
        snapshot,
        officialWorkflowRun,
        environment,
        bootstrap,
        body,
      ] = await Promise.all([
        get(graph.input$),
        get(graph.agent$),
        get(graph.threadSession$),
        get(graph.shared.framework$),
        get(graph.shared.modelRoute$),
        get(graph.shared.connectorSelection$),
        get(graph.shared.connectorSnapshot$),
        get(graph.shared.officialWorkflow$),
        get(graph.shared.environment$),
        get(graph.bootstrap$),
        get(storageBody$),
      ]);
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      if (isRouteError(requestedFramework)) {
        return requestedFramework;
      }
      if (isRouteError(modelProvider)) {
        return modelProvider;
      }
      if (isRouteError(selection)) {
        return selection;
      }
      if (isRouteError(snapshot)) {
        return snapshot;
      }
      if (isRouteError(officialWorkflowRun)) {
        return officialWorkflowRun;
      }
      if (isRouteError(environment)) {
        return environment;
      }
      const resolved = selectedRunStorageExecution(agent, session);
      if (isRouteError(resolved)) {
        return resolved;
      }
      const framework = modelProvider
        ? modelProviderFramework(modelProvider)
        : requestedFramework;
      const piSandbox = resolvePreparedPiModelConfig({
        createArgs: {
          catalog: await get(graph.catalog$),
          piExecution: selectedRunPiExecution(input.command),
          codexServiceTier: input.command.codexServiceTier,
          agentRunMetadata: { reasoningEffort: input.command.reasoningEffort },
        },
        modelProvider,
      });
      const metadata = prepareRunOutputMetadata({
        createArgs: { injectSkillVolumes: { workflows: bootstrap.workflows } },
        systemSkillStorageResolution: get(systemSkillStorageResolution$),
        connectorScope: selection.connectorScope,
        connectorCatalogSelection: selection.connectorCatalogSelection,
        customConnectorContext: snapshot.customConnectorContext,
        framework,
        piSandbox,
        body,
        resolved,
        officialWorkflowRun,
      });
      return {
        kind: "requested",
        args: {
          db: get(db$),
          content: resolved.content,
          vars: withoutLegacyAgentRunEnvironmentEntries(
            buildMergedVariables({
              persistedEnvironment: environment,
              runVars: selectedAgentRunVariables(agent.id),
            }),
          ),
          agentOrgId: resolved.orgId,
          runtimeOrgId: input.command.auth.orgId,
          userId: input.command.auth.userId,
          artifacts: metadata.artifacts,
          // Selected product inputs do not override compose versions. Session
          // writeback versions remain in the same captured mount snapshot.
          volumeVersionOverrides: undefined,
          additionalVolumes: metadata.additionalVolumes,
          additionalVolumeSources: metadata.additionalVolumeSources,
          framework: piSandbox === undefined ? framework : "pi",
          persistedStorageMounts: resolved.persistedStorageMounts,
          timing: input.timing,
          stats: new StorageManifestBuildStats(),
        },
      };
    },
  );
}

function createSelectedStorageObjects(
  graph: ReturnType<typeof createSelectedAgentRunReadGraph>,
  storageBody$: NonNullable<SelectedAgentRunGraphSources["storageBody$"]>,
) {
  const selectedStorageInput$ = createSelectedStorageInputObject(
    graph,
    storageBody$,
  );
  const storageInput$ = computed(async (get): Promise<AgentRunStorageInput> => {
    const input = await get(selectedStorageInput$);
    if (isRouteError(input)) {
      throw new Error("Rejected storage input cannot be materialized");
    }
    return input;
  });
  const storage = createAgentRunStorageObjects(storageInput$);
  const storagePlan$ = computed(async (get) => {
    const input = await get(selectedStorageInput$);
    return isRouteError(input) ? input : get(storage.storagePlan$);
  });
  return { storage, storagePlan$ };
}

function createSelectedRunContextObjects(
  graph: ReturnType<typeof createSelectedAgentRunReadGraph>,
) {
  const { runArgs$, shared } = graph;
  const contextInput$ = computed(
    async (get): Promise<PrepareRunContextInput> => {
      const selected = await get(runArgs$);
      if (!selected || "status" in selected) {
        throw new Error("Run context requires an authorized ready input");
      }
      const previewAutomationBypass = get(previewAutomationBypass$);
      const args = previewAutomationBypass
        ? {
            ...selected.args,
            platformEnvironment: {
              ...selected.args.platformEnvironment,
              [VERCEL_AUTOMATION_BYPASS_ENV]: previewAutomationBypass,
            },
          }
        : selected.args;
      return {
        db: get(db$),
        args,
        timing: selected.input.timing,
      };
    },
  );
  const preparedContext = createRunContextObjects(contextInput$, shared);
  const runContext$ = computed(async (get) => {
    const selected = await get(runArgs$);
    if (!selected || "status" in selected) {
      return selected;
    }
    return get(preparedContext.runContext$);
  });
  return { contextInput$, runContext$ };
}

function createObserveSelectedExecutionCommand(
  input$: ReturnType<typeof createPreCreateInput>,
) {
  return command(async ({ get }, signal: AbortSignal) => {
    const { command: selected } = await get(input$);
    signal.throwIfAborted();
    await observeAgentRunPiExecutionSnapshot({
      userId: selected.auth.userId,
      orgId: selected.auth.orgId,
      chatThreadId: selected.chatThreadId,
      piExecution: selectedRunPiExecution(selected),
      threadSessionCliAgentType: selected.threadSessionRoute?.cliAgentType,
    });
    signal.throwIfAborted();
  });
}

function createPrepareReadySelectedRunCommand(
  graph: ReturnType<typeof createSelectedAgentRunReadGraph>,
  context: ReturnType<typeof createSelectedRunContextObjects>,
  sources?: SelectedAgentRunGraphSources,
  earlyStorage?: ReturnType<typeof createSelectedStorageObjects>,
) {
  const checkUnavailableProviderCredits$ =
    createCheckUnavailableProviderCreditsCommand();
  const { input$, runArgs$, shared } = graph;
  const { contextInput$, runContext$ } = context;
  const observeExecution$ = createObserveSelectedExecutionCommand(input$);
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<PreparedAgentRun | CreateRunErrorResult | null> => {
      if (sources && !(await get(sources.selectionInput$))) {
        signal.throwIfAborted();
        return null;
      }
      signal.throwIfAborted();
      const { timing: preparationTiming, command: selectedInput } =
        await get(input$);
      signal.throwIfAborted();
      const phaseTiming = new ApiDispatchPhaseCollector(
        selectedInput.apiStartTime,
      );
      preparationTiming.recordElapsed(
        "api_dispatch_pre_create_agent_run",
        "top_level",
        selectedInput.apiStartTime,
      );
      phaseTiming.checkpoint("api_dispatch_phase_pre_create", now());
      const [selected, context, storagePlan] = await preparationTiming.measure(
        "api_dispatch_prepare_run_context",
        "top_level",
        async () => {
          return await Promise.all([
            get(runArgs$),
            get(runContext$),
            earlyStorage ? get(earlyStorage.storagePlan$) : undefined,
            get(shared.modelRoute$),
            get(shared.connectorContext$),
            get(shared.officialWorkflow$),
            set(observeExecution$, signal),
          ]);
        },
      );
      signal.throwIfAborted();
      if (!selected || "status" in selected) {
        return selected;
      }
      if (!context) {
        return null;
      }
      const contextInput = await get(contextInput$);
      signal.throwIfAborted();
      const { args, timing } = contextInput;
      if ("status" in context) {
        if (
          context.body.error.code === "PROVIDER_UNAVAILABLE" &&
          args.enforceBuiltInCredits &&
          isBuiltInModelProviderType(args.modelProviderType)
        ) {
          const failure = await set(
            checkUnavailableProviderCredits$,
            args,
            signal,
          );
          if (failure) {
            return failure;
          }
        }
        return context;
      }
      if (storagePlan && isRouteError(storagePlan)) {
        return storagePlan;
      }
      phaseTiming.checkpoint("api_dispatch_phase_prepare_context", now());
      return { args, context, contextInput, timing, phaseTiming };
    },
  );
}

function createPrepareQueuedAgentRunCommand(
  graph: ReturnType<typeof createSelectedAgentRunReadGraph>,
  context: ReturnType<typeof createSelectedRunContextObjects>,
  sources?: SelectedAgentRunGraphSources,
  earlyStorage?: ReturnType<typeof createSelectedStorageObjects>,
) {
  const { identityInput$, agentId$, agent$, shared } = graph;
  const authorize$ = createAuthorizeSelectedAgentRunCommand(
    identityInput$,
    agentId$,
    agent$,
  );
  const prepareReady$ = createPrepareReadySelectedRunCommand(
    graph,
    context,
    sources,
    earlyStorage,
  );
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<PreparedAgentRun | CreateRunErrorResult | null> => {
      if (sources && !(await get(sources.identityInput$))) {
        signal.throwIfAborted();
        return null;
      }
      signal.throwIfAborted();
      const authorization = await set(authorize$, signal);
      if (authorization) {
        return authorization;
      }
      const [prepared] = await Promise.all([
        set(prepareReady$, signal),
        get(shared.member$),
        get(shared.disabledPaidTools$),
        get(shared.environment$),
        get(shared.connectorSelection$),
        get(shared.connectorSnapshot$),
      ]);
      signal.throwIfAborted();
      return prepared;
    },
  );
}

export function createSelectedAgentRunObjects(
  sources?: SelectedAgentRunGraphSources,
) {
  const internalInput$ = createPreCreateInternalInput();
  const graph = createSelectedAgentRunReadGraph(internalInput$, sources);
  const earlyStorage = sources?.storageBody$
    ? createSelectedStorageObjects(graph, sources.storageBody$)
    : undefined;
  const context = createSelectedRunContextObjects(graph);
  const prepareQueuedAgentRun$ = createPrepareQueuedAgentRunCommand(
    graph,
    context,
    sources,
    earlyStorage,
  );
  const prepareSelectedAgentRun$ = command(
    async (
      { set },
      args: AnyCreateAgentRunCommandArgs,
      signal: AbortSignal,
    ) => {
      assertThreadBoundAgentRunHasQueueAssociation(args);
      set(internalInput$, {
        command: args,
        timing: serviceEntryTiming(args),
      });
      return await set(prepareQueuedAgentRun$, signal);
    },
  );
  const { createAtomicLaunchRun$ } = createLaunchObjects(
    earlyStorage?.storage,
    sources?.callbackInputs$,
  );
  const completeAgentRun$ = createCompleteAgentRunCommand(
    createAtomicLaunchRun$,
  );
  return {
    runArgs$: graph.runArgs$,
    bootstrap$: graph.bootstrap$,
    threadSession$: graph.threadSession$,
    runContext$: context.runContext$,
    prepareQueuedAgentRun$,
    prepareSelectedAgentRun$,
    completeAgentRun$,
  };
}
