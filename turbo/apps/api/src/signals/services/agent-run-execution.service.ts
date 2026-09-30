/**
 * Execution support for non-chat callers, plus shared pure transformations and
 * transaction primitives. Chat owns its claim graph and pending transaction in
 * claim-run-context.ts and pick-chat-run.service.ts.
 */
import { state, computed, command, type State, type Computed } from "ccstate";
import { settle, onRejection, tapError, safeSync } from "../utils";
import {
  conflict,
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import {
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
  type OfficialWorkflowRunObservation,
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
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensionsInput,
  measureApiDispatchTimingSync,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
  getAllFeatureStates,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  type SupportedFramework,
  getInstructionsFilename,
  isSupportedFramework,
} from "@okouai/core/frameworks";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  type SystemStoragePresignedUrlCacheStatus,
  type WorkflowSkillStoragePresignedUrlCacheStatus,
  type StorageManifestCacheEntryKind,
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
import { env, optionalEnv } from "../../lib/env";
import {
  getInstructionsStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  MEMORY_ARTIFACT_NAME,
  getSkillStorageName,
  getCustomSkillStorageName,
  getCustomConnectorSkillStorageName,
  getCustomConnectorSkillName,
} from "@okouai/core/storage-names";
import {
  expandVariablesInString,
  expandVariables,
  extractAndGroupVariables,
} from "@okouai/core/variable-expander";
import {
  PI_AGENT_DIR,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CLAUDE_CONFIG_DIR,
  type StoredStorageMountEntry,
  type PiModelConfig,
  type PiLaunchConfig,
  type PiMemoryRecallSelection,
  type StoredExecutionContext,
  type StorageMountEntry,
  type SecretConnectorMetadata,
  type PiModelConfigLegacy,
  type StoredConnectorPermissionBaseline,
  type ConnectorRuntimeTargetRegistration,
  piMemoryRecallSelectionSchema,
  PI_MEMORY_ROOT,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  type PiInstalledCliRequirement,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  PI_SKILLS_ROOT,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  AGENT_EXECUTION_TIMEOUT_SECONDS,
} from "@okouai/api-contracts/contracts/runners";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import {
  sql,
  and,
  eq,
  like,
  isNull,
  type WithSubquery,
  type SQL,
  type SQLWrapper,
  inArray,
  or,
  asc,
  desc,
  isNotNull,
  ne,
} from "drizzle-orm";
import {
  VERSION_ID_LENGTH,
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
} from "@okouai/core/version-id";
import { alias, unionAll } from "drizzle-orm/pg-core";
import {
  type RunContextResponse,
  runCreateBodySchema,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  createMemorySummaryProjectionObjects,
  type MemorySummaryProjectionReadInput,
} from "./memory-summary-projection.service";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import type {
  AgentRunFullLaunchSnapshot,
  AgentRunLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import {
  type ModelProviderType,
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderCredentialScope,
  isBuiltInModelProviderType,
  getFrameworkForType,
  MODEL_PROVIDER_TYPES,
  getSecretNameForType,
  getModelProviderFirewall,
  getModelProviderEnvBindings,
  getDefaultModel,
  type ModelProviderEnvBindings,
  getModelProviderCodexRuntimeConfig,
  getModelProviderCodexRuntimeCapabilities,
  getModelProviderCodexCatalogForModel,
  hasAuthMethods,
  getSecretsForAuthMethod,
  normalizeRunModelId,
  getModelImageInputSupport,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  type AgentExecutionConfig as agentRunCreateAgentExecutionConfig,
  type AgentExecutionDefinition,
  buildAgentExecutionConfig,
} from "./agent-execution-config";
import {
  type SessionExecutionIdentity,
  canReuseSession,
} from "./session-compatibility";
import { z } from "zod";
import {
  unifiedRunRequestSchema,
  type CreateRunResponse,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  type PiModelConfigV4,
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
} from "@okouai/api-contracts/contracts/pi-native";
import {
  type ExpandedFirewallConfig,
  type ExecutionFirewalls,
  type NetworkPolicies,
  FirewallBaseUrlResolutionError,
  type FirewallPolicies,
  type ExecutionFirewallEntry,
  type Firewall,
  canonicalizeFirewallBaseUrlVarsForExecution,
  type FirewallPolicy,
  extractSecretNamesFromApis,
} from "@okouai/connectors/firewall-types";
import {
  type BuiltInModelRuntimeRoute,
  isBuiltInModelRuntimeRoutePermitted,
  resolveBuiltInModelRuntimeRouteFromCatalog,
} from "./built-in-model-runtime-route.service";
import {
  catalogBuiltInCandidates,
  loadModelCatalog,
  loadSystemDefaultRunModel,
  catalogProviderUpstreamModel,
  type ModelCatalog,
} from "./model-catalog.service";
import {
  type ConnectorSlug,
  connectorSlugSchema,
  type ConnectorAuthMethodId,
} from "@okouai/api-contracts/contracts/connector-identity";
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
  personalModelProviderAccountById,
  readPersonalSubscriptionAccount,
  activePersonalModelProviderAccount,
  type MemberModelAccountSnapshot,
} from "./model-provider-account.service";
import type {
  RunCallback,
  DispatchFailedRunCallbacks,
  PersistProducerRunBinding,
  AgentRunModelPin,
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
} from "./agent-run-contracts";
import {
  type ChatThreadSessionResolution,
  type ChatThreadSessionResolutionAction,
  type ChatThreadExecutionSnapshot,
  type ChatThreadSessionRoute,
  chatThreadSessionSelection,
  chatThreadConversationRun,
  resolveChatThreadSessionSnapshot,
} from "./chat-session-continuity.service";
import {
  type RunWorkflowRef,
  type RunWorkflowSourceRow,
  workflowsForRunFromRows,
} from "./workflow-data.service";
import {
  type QueueFirstRunAssociation,
  type QueueFirstRunClaimResult,
  type QueueFirstRunSessionSnapshotState,
  type QueueFirstRunAdmission,
  resolveQueueFirstRunAdmission,
  claimQueueFirstRunAssociation,
} from "./chat-queued-event.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  type RunContextAxiomSnapshot,
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  networkPoliciesRecordToEntries,
  featureFlagsRecordToEntries,
} from "./run-context-snapshot.service";
import { generateOkouToken } from "../auth/tokens";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  encryptPersistentSecretsMap,
  encryptPersistentSecretValue,
  decryptStoredSecretValue,
} from "./crypto.utils";
import {
  resolvePiLangfuseDebugConfig,
  piLangfuseDebugPlatformEnvironment,
  isPiLangfuseDebugRunEnvironment,
} from "../../lib/pi-langfuse-debug";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import {
  type PiExecutionRoute,
  normalizePiExecutionRoute,
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
  assertPiNativeCredential,
  materializePiExecutionRoute,
} from "@okouai/pi-agent-runtime";
import { piPreparationObserver } from "./pi-preparation-timing.service";
import {
  startPiPreparationObservation,
  measurePiPreparation,
  measurePiPreparationSync,
} from "@okouai/pi-agent-runtime/api";
import { logger } from "../../lib/log";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";
import {
  type ImageModel,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_CONFIGS,
} from "@okouai/core/image-model-catalog";
import { randomUUID } from "node:crypto";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  type RunMetadataValues,
  normalizeRunMetadata,
} from "./agent-run-metadata-write.service";
import {
  AdmissionAttemptTiming,
  type AdmissionAttemptOutcome,
} from "./api-dispatch-admission-timing.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import type { Tx } from "../../lib/db-types";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import {
  isFreePlanForCreditAdmission,
  createRunAdmissionObjects,
  type RunAdmissionInput,
} from "./run-admission.service";
import { observePreparedLaunchPersistenceForTest } from "./prepared-launch-persistence-observer.service";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
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
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { ingestToAxiom, getDatasetName } from "../external/axiom";
import {
  type ConnectorRuntimeSelection,
  createConnectorRuntimeSelectionObjects,
  getConnectorRuntimeConnector,
  type ConnectorRuntimeMethod,
} from "./connector-catalog-runtime.service";
import {
  systemSkillStorageResolution$,
  type SystemSkillStorageResolution,
} from "../context/system-skill-storage-resolution";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  userFeatureSwitchOverridesFromRows,
  ORG_SENTINEL_USER_ID as agentRunsCreateORG_SENTINEL_USER_ID,
  type UserFeatureSwitchOverrideRow,
} from "./feature-switch-scope";
import { agents } from "@okouai/db/schema/agent";
import { conversations } from "@okouai/db/schema/conversation";
import { blobs } from "@okouai/db/schema/blob";
import {
  type CompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
  isCompressedSessionHistoryBlobEncoding,
} from "./session-history-blobs";
import { projectLegacyWritebackArtifacts } from "./storage-legacy-projection.service";
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
  observeStableContextCacheIdentityBuild,
  observeStableAgentPromptBuild,
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
import {
  OPENROUTER_US_ORIGIN,
  getOpenRouterBaseUrl,
} from "@okouai/api-contracts/contracts/openrouter-routing";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import { isPiNativeModel, isPiDeepSeekModel } from "@okouai/core/pi-execution";
import { resolvePiSandboxModelConfig } from "./pi-sandbox-config";
import { piNativeFirewall } from "@okouai/api-contracts/contracts/pi-native-firewall";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import {
  normaliseCustomConnectorRow,
  customConnectorValueMarkerKey,
  customConnectorManualAuthReferencesMemberField,
  customConnectorMissingRequiredFieldKeys,
} from "./custom-connector.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import {
  customConnectorPermissionBundleDependencySlug,
  type CustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import {
  type BuiltinConnectorCredentialAccess,
  resolveBuiltinConnectorCredentialAccess,
  builtinConnectorCredentialSecretReadCondition,
  type BuiltinConnectorCredentialReadGroup,
} from "./builtin-connector-credential-access.service";
import {
  type ConnectorRuntimeBindingEntry,
  connectorAuthMethodRuntimeMetadata,
} from "@okouai/connectors/connector-auth-method";
import {
  type ConnectorCredentialStatus,
  builtinConnectorRuntimeCredentialStatusWithMethod,
} from "./connector-credential-status.service";
import {
  type CustomConnectorRuntimeStorageRow,
  customConnectorRuntimeStorageSnapshot,
} from "./custom-connector-credential-access.service";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import {
  type ConnectorServerFirewallExecutionMetadata,
  type ConnectorServerFirewallPermissionIndex,
  expandConnectorServerFirewallPolicies,
} from "./connector-server-firewall-catalog.service";
import { defaultFirewallPolicyForPermissionIndex } from "./firewall-network-policy.service";
import { currentConnectorCatalogValidatorIdentity } from "./connector-catalog-validator-authority";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { isStaffOrg } from "@okouai/core/staff-org";
import { resolveSkillRef, parseGitHubTreeUrl } from "@okouai/core/github-url";
import { previewAutomationBypass$ } from "../context/hono";
import { VERCEL_AUTOMATION_BYPASS_ENV } from "../../lib/preview-automation-bypass";
import { isWebChatTriggerSource } from "./chat-trigger-source.service";
import type { AuthContext } from "../../types/auth";
import {
  type WebChatSessionPromptContext,
  type WebChatSessionPromptInput,
  createWebChatSessionPromptObjects,
} from "./web-chat-session-prompt.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { activeUserPermissionGrantCondition } from "./user-permission-grants.service";
import {
  type FirewallPermissionGrantAction,
  type FirewallPermissionGrant,
  permissionGrantsToFirewallPolicies,
} from "@okouai/connectors/firewall-metadata/policy";
import { userPermissionGrantActionSchema } from "@okouai/api-contracts/contracts/user-permission-grants";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { workflows } from "@okouai/db/schema/workflow";
import {
  type AgentConnectorScopeSnapshot,
  type AgentConnectorSlugRow,
  type AgentCustomConnectorRow,
  agentConnectorScopeFromRows,
  type CustomConnectorDefinitionVersion,
} from "./agent-connector-scope.service";
import { requestPiMemoryStage1DayForAdmittedRun } from "./pi-memory-stage1-schedule.service";
import {
  buildAgentToolsPromptInputs,
  buildAgentToolsPrompt,
} from "./agent-tools-prompt.service";
import { buildAgentIdentityPrompt } from "./agent-identity-prompt.service";
import { piStableContextVariantDigest } from "./pi-stable-context.service";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import {
  type CustomConnectorRuntimeContext,
  compactRecord,
  resolveCustomConnectorBaseUrlVars,
  loadEffectiveCustomConnectorPermissionBundle,
  type CustomConnectorRuntimeDataRows,
  type BuildCustomConnectorRuntimeContextArgs,
  orderedCustomConnectorRuntimeRows,
  buildCustomConnectorRuntimeContext,
  customConnectorRuntimeSkill,
  allAllowPolicyForPermissions,
  resolveConnectorNetworkPolicy,
  collectPermissionNames,
  customConnectorRuntimeFirewall,
  runtimeFirewall,
} from "./connector-runtime-preparation.service";

// Storage planning and explicit resource materialization.

type StorageManifestEntryKind = StorageManifestCacheEntryKind;

type StorageManifestSource =
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

type StorageManifestCountBucket =
  (typeof STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS)[number];

interface PresignCandidateInput {
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number;
  readonly filename: string | undefined;
  readonly usePublicEndpoint: boolean;
}

export interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: PersistedStorageMount["missingRootPolicy"];
}

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly baselineCandidate?: true;
  readonly expectedStorageId?: string;
}

interface VolumeConfig {
  readonly name: string;
  readonly version: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface AgentConfig {
  readonly framework?: string;
  readonly volumes?: readonly string[];
  readonly instructions?: unknown;
}

interface AgentExecutionConfig {
  readonly agent?: AgentConfig;
  readonly agents?: Record<string, AgentConfig | undefined>;
  readonly volumes?: Record<string, VolumeConfig | undefined>;
}

interface PrepareAgentRunStorageManifestArgs {
  readonly db: ReadonlyDb;
  readonly content: AgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
  readonly framework: SupportedFramework | "pi";
  /** Canonical session persistence replaces matching request writeback artifacts. */
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}

interface ResolvedVolume {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly vasVersion: string;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface StorageResolution {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly resolvedOrgId: string;
  readonly resolvedUserId: string;
}

interface StorageLookup {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface StorageRequest {
  readonly lookup: StorageLookup;
  readonly version: string | undefined;
}

interface StorageIndexRequest {
  readonly lookup: StorageLookup;
  readonly exactVersionId: string | null;
}

export interface StorageIndexRow {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
  readonly headId: string | null;
  readonly headS3Key: string | null;
  readonly headArchiveSize: number | null;
  readonly headFileCount: number | null;
  readonly exactId: string | null;
  readonly exactS3Key: string | null;
  readonly exactArchiveSize: number | null;
  readonly exactFileCount: number | null;
}

interface StorageVersionIndexEntry {
  readonly id: string;
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
}

export interface StorageIndexEntry {
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
  readonly headVersion: StorageVersionIndexEntry | null;
  readonly exactVersions: ReadonlyMap<string, StorageVersionIndexEntry>;
}

interface StorageManifestInputs {
  readonly artifacts: readonly ContextArtifact[];
  readonly composeVolumes: readonly ResolvedVolume[];
}

/** Internal resolved identity, before transport URLs exist. Never persisted. */
type StorageMountMetadata = Omit<StoredStorageMountEntry, "archiveUrl">;

interface PreparedReadOnlyStorageEntry<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storedMount: TMount;
  readonly persistedMount: PersistedStorageMount;
  readonly runContextVolume: RunContextResponse["volumes"][number];
}

interface PreparedWritebackStorageEntry<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storedMount: TMount;
  readonly persistedMount: PersistedStorageMount;
  readonly runContextArtifact: NonNullable<RunContextResponse["artifact"]>;
}

export interface PreparedStorageEntries<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly composeEntries: readonly PreparedReadOnlyStorageEntry<TMount>[];
  readonly additionalEntries: readonly PreparedReadOnlyStorageEntry<TMount>[];
  readonly writebackEntries: readonly PreparedWritebackStorageEntry<TMount>[];
  readonly resolvedComposeEntryCount: number;
  readonly resolvedAdditionalEntryCount: number;
}

interface RunContextStorageObservation {
  readonly volumes: RunContextResponse["volumes"];
  readonly artifact: RunContextResponse["artifact"];
}

interface PreparedAgentRunStorage<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storageMounts: readonly TMount[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: RunContextStorageObservation;
}

interface BuildStorageManifestEntriesArgs {
  readonly db: ReadonlyDb;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly composeVolumes: readonly ResolvedVolume[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}

type UnindexedStorageManifestEntriesArgs = Omit<
  BuildStorageManifestEntriesArgs,
  "storageIndex"
>;

interface PreparedRequestStorageResolution {
  readonly input: UnindexedStorageManifestEntriesArgs;
  readonly requests: readonly StorageRequest[];
}

interface StorageManifestEntryPhaseTimings {
  readonly compose: StorageManifestEntryPhaseTiming;
  readonly additional: StorageManifestEntryPhaseTiming;
  readonly artifact: StorageManifestEntryPhaseTiming;
}

export interface ResolvedStorageEntries {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly branch: StorageManifestCacheBranch;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
  readonly resolved: ResolvedStorageManifestEntryPlans;
}

/** One immutable selection per attempt, including canonical session writeback. */
interface ResolvedAgentRunStorage {
  readonly metadata: PreparedAgentRunStorage<StorageMountMetadata>;
  readonly requested: ResolvedStorageEntries;
  readonly sessionWriteback: ResolvedStorageEntries | undefined;
}

/** Read-only selection. Missing writeback roots are initialized by materialization. */
export interface AgentRunStoragePlan {
  readonly requested: ResolvedStorageEntries;
  readonly sessionWriteback: ResolvedStorageEntries | undefined;
  readonly missingArtifacts: readonly ContextArtifact[];
}

export interface MaterializedAgentRunStorage {
  readonly resolved: ResolvedAgentRunStorage;
  readonly prepared: PreparedAgentRunStorage;
}

interface ResolvedStorageManifestEntryPlans {
  readonly composePlans: readonly ResolvedManifestStoragePlan[];
  readonly additionalPlans: readonly ResolvedManifestStoragePlan[];
  readonly artifactInputs: readonly ResolvedManifestArtifactInput[];
}

interface ResolvedManifestStorageInput {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly resolved: StorageResolution;
}

interface ResolvedManifestArtifactInput {
  readonly artifact: ContextArtifact;
  readonly resolved: StorageResolution;
  readonly source: StorageManifestSource;
}

interface ResolvedManifestStoragePlan extends ResolvedManifestStorageInput {
  readonly entryKind: Extract<
    StorageManifestEntryKind,
    "compose" | "additional"
  >;
  readonly source: StorageManifestSource;
}

interface StorageManifestPhaseTimingWindow {
  startedAt: number | undefined;
  finishedAt: number | undefined;
}

/**
 * Pre-fetched (orgId, userId, name) -> storage row and requested exact-version
 * map. A single run resolves dozens to hundreds of volumes/artifacts; looking
 * each one up with its own database round-trip saturates the connection pool,
 * so the exact requested rows and full pinned versions are loaded once and
 * resolved from memory instead.
 */
type StorageIndex = ReadonlyMap<string, StorageIndexEntry>;

const STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

const STORAGE_MANIFEST_SOURCES = [
  "system_skill",
  "connector_skill",
  "custom_connector_skill",
  "official_workflow",
  "workflow_skill",
  "request_additional_volume",
  "compose_additional_volume",
  "compose_volume",
  "artifact",
  "unknown",
] as const satisfies readonly StorageManifestSource[];

type StorageManifestSourceCounts = Record<StorageManifestSource, number>;

type StorageManifestSourceCountsByKind = Record<
  StorageManifestEntryKind,
  StorageManifestSourceCounts
>;

function storageManifestCountBucket(count: number): StorageManifestCountBucket {
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

function emptyStorageManifestSourceCounts(): StorageManifestSourceCounts {
  return {
    system_skill: 0,
    connector_skill: 0,
    custom_connector_skill: 0,
    official_workflow: 0,
    workflow_skill: 0,
    request_additional_volume: 0,
    compose_additional_volume: 0,
    compose_volume: 0,
    artifact: 0,
    unknown: 0,
  };
}

function emptyStorageManifestSourceCountsByKind(): StorageManifestSourceCountsByKind {
  return {
    compose: emptyStorageManifestSourceCounts(),
    additional: emptyStorageManifestSourceCounts(),
    artifact: emptyStorageManifestSourceCounts(),
  };
}

export class StorageManifestBuildStats {
  private requestedComposeCount = 0;
  private requestedAdditionalCount = 0;
  private requestedArtifactCount = 0;
  private dedupedArtifactCount = 0;
  private resolvedComposeCount = 0;
  private resolvedAdditionalCount = 0;
  private resolvedArtifactCount = 0;
  private finalStorageCount = 0;
  private finalArtifactCount = 0;
  private droppedComposeCount = 0;
  private plannedComposePresignCount = 0;
  private plannedAdditionalPresignCount = 0;
  private plannedArtifactPresignCount = 0;
  private systemResolvedStorageCount = 0;
  private systemPresignCacheHitCount = 0;
  private systemPresignCacheMissCount = 0;
  private workflowSkillPresignCacheHitCount = 0;
  private workflowSkillPresignCacheMissCount = 0;
  private nonSystemPresignCount = 0;
  private readonly resolvedSourceCounts = emptyStorageManifestSourceCounts();
  private readonly plannedPresignSourceCounts =
    emptyStorageManifestSourceCounts();
  private readonly plannedPresignSourceCountsByKind =
    emptyStorageManifestSourceCountsByKind();
  private readonly nonSystemPresignSourceCounts =
    emptyStorageManifestSourceCounts();
  private readonly nonSystemPresignSourceCountsByKind =
    emptyStorageManifestSourceCountsByKind();
  private artifactEnsureAlreadyInitializedCount = 0;
  private artifactEnsureMissingStorageCount = 0;
  private artifactEnsureCreatedStorageCount = 0;
  private artifactEnsureLostCreateRaceCount = 0;
  private artifactEnsureMissingHeadVersionCount = 0;
  private artifactEnsureInitializedEmptyVersionCount = 0;
  private readonly presignCandidateCounts = new Map<string, number>();

  recordRequestedInputs(args: {
    readonly composeCount: number;
    readonly additionalCount: number;
    readonly artifactCount: number;
    readonly dedupedArtifactCount: number;
  }): void {
    this.requestedComposeCount = args.composeCount;
    this.requestedAdditionalCount = args.additionalCount;
    this.requestedArtifactCount = args.artifactCount;
    this.dedupedArtifactCount = args.dedupedArtifactCount;
  }

  recordResolvedEntry(
    kind: StorageManifestEntryKind,
    source: StorageManifestSource,
    count = 1,
  ): void {
    switch (kind) {
      case "compose": {
        this.resolvedComposeCount += count;
        break;
      }
      case "additional": {
        this.resolvedAdditionalCount += count;
        break;
      }
      case "artifact": {
        this.resolvedArtifactCount += count;
        break;
      }
    }
    this.resolvedSourceCounts[source] += count;
  }

  recordPresignCandidate(
    kind: StorageManifestEntryKind,
    source: StorageManifestSource,
    input: PresignCandidateInput,
  ): void {
    switch (kind) {
      case "compose": {
        this.plannedComposePresignCount += 1;
        break;
      }
      case "additional": {
        this.plannedAdditionalPresignCount += 1;
        break;
      }
      case "artifact": {
        this.plannedArtifactPresignCount += 1;
        break;
      }
    }
    this.plannedPresignSourceCounts[source] += 1;
    this.plannedPresignSourceCountsByKind[kind][source] += 1;

    const key = JSON.stringify([
      input.bucket,
      input.key,
      input.expiresIn,
      input.filename ?? "",
      input.usePublicEndpoint ? "public" : "private",
    ]);
    this.presignCandidateCounts.set(
      key,
      (this.presignCandidateCounts.get(key) ?? 0) + 1,
    );
  }

  recordSystemResolvedStorage(count = 1): void {
    this.systemResolvedStorageCount += count;
  }

  recordSystemPresignCacheResult(
    status: SystemStoragePresignedUrlCacheStatus,
  ): void {
    switch (status) {
      case "hit": {
        this.systemPresignCacheHitCount += 1;
        return;
      }
      case "miss": {
        this.systemPresignCacheMissCount += 1;
        return;
      }
    }
  }

  recordWorkflowSkillPresignCacheResult(
    status: WorkflowSkillStoragePresignedUrlCacheStatus,
  ): void {
    switch (status) {
      case "hit": {
        this.workflowSkillPresignCacheHitCount += 1;
        return;
      }
      case "miss": {
        this.workflowSkillPresignCacheMissCount += 1;
        return;
      }
    }
  }

  recordNonSystemPresign(
    kind: StorageManifestEntryKind,
    source: StorageManifestSource,
  ): void {
    this.nonSystemPresignCount += 1;
    this.nonSystemPresignSourceCounts[source] += 1;
    this.nonSystemPresignSourceCountsByKind[kind][source] += 1;
  }

  recordArtifactEnsureAlreadyInitialized(): void {
    this.artifactEnsureAlreadyInitializedCount += 1;
  }

  recordArtifactEnsureMissingStorage(): void {
    this.artifactEnsureMissingStorageCount += 1;
  }

  recordArtifactEnsureCreatedStorage(): void {
    this.artifactEnsureCreatedStorageCount += 1;
  }

  recordArtifactEnsureLostCreateRace(): void {
    this.artifactEnsureLostCreateRaceCount += 1;
  }

  recordArtifactEnsureMissingHeadVersion(): void {
    this.artifactEnsureMissingHeadVersionCount += 1;
  }

  recordArtifactEnsureInitializedEmptyVersion(): void {
    this.artifactEnsureInitializedEmptyVersionCount += 1;
  }

  recordFinalStorage(args: {
    readonly composeEntryCount: number;
    readonly additionalEntryCount: number;
    readonly finalReadOnlyEntryCount: number;
    readonly finalWritebackEntryCount: number;
    readonly resolvedComposeEntryCount?: number;
    readonly resolvedAdditionalEntryCount?: number;
  }): void {
    this.finalStorageCount = args.finalReadOnlyEntryCount;
    this.finalArtifactCount = args.finalWritebackEntryCount;
    this.droppedComposeCount =
      (args.resolvedComposeEntryCount ?? args.composeEntryCount) +
      (args.resolvedAdditionalEntryCount ?? args.additionalEntryCount) -
      args.finalReadOnlyEntryCount;
  }

  overallDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_requested_compose_count_bucket:
        storageManifestCountBucket(this.requestedComposeCount),
      storage_manifest_requested_additional_count_bucket:
        storageManifestCountBucket(this.requestedAdditionalCount),
      storage_manifest_requested_artifact_count_bucket:
        storageManifestCountBucket(this.requestedArtifactCount),
      storage_manifest_deduped_artifact_count_bucket:
        storageManifestCountBucket(this.dedupedArtifactCount),
      storage_manifest_resolved_compose_count_bucket:
        storageManifestCountBucket(this.resolvedComposeCount),
      storage_manifest_resolved_additional_count_bucket:
        storageManifestCountBucket(this.resolvedAdditionalCount),
      storage_manifest_resolved_artifact_count_bucket:
        storageManifestCountBucket(this.resolvedArtifactCount),
      storage_manifest_final_storage_count_bucket: storageManifestCountBucket(
        this.finalStorageCount,
      ),
      storage_manifest_final_artifact_count_bucket: storageManifestCountBucket(
        this.finalArtifactCount,
      ),
      storage_manifest_dropped_compose_count_bucket: storageManifestCountBucket(
        this.droppedComposeCount,
      ),
      storage_manifest_planned_presign_count_bucket: storageManifestCountBucket(
        this.plannedPresignCount(),
      ),
      storage_manifest_duplicate_presign_candidate_count_bucket:
        storageManifestCountBucket(this.duplicatePresignCandidateCount()),
      ...this.sourceDimensions({
        resolved: this.resolvedSourceCounts,
        plannedPresign: this.plannedPresignSourceCounts,
        nonSystemPresign: this.nonSystemPresignSourceCounts,
      }),
      ...this.systemPresignCacheDimensions(),
      ...this.workflowSkillPresignCacheDimensions(),
      ...this.artifactEnsureDimensions(),
    };
  }

  artifactEnsureDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_artifact_ensure_already_initialized_count_bucket:
        storageManifestCountBucket(this.artifactEnsureAlreadyInitializedCount),
      storage_manifest_artifact_ensure_missing_storage_count_bucket:
        storageManifestCountBucket(this.artifactEnsureMissingStorageCount),
      storage_manifest_artifact_ensure_created_storage_count_bucket:
        storageManifestCountBucket(this.artifactEnsureCreatedStorageCount),
      storage_manifest_artifact_ensure_lost_create_race_count_bucket:
        storageManifestCountBucket(this.artifactEnsureLostCreateRaceCount),
      storage_manifest_artifact_ensure_missing_head_version_count_bucket:
        storageManifestCountBucket(this.artifactEnsureMissingHeadVersionCount),
      storage_manifest_artifact_ensure_initialized_empty_version_count_bucket:
        storageManifestCountBucket(
          this.artifactEnsureInitializedEmptyVersionCount,
        ),
    };
  }

  buildEntriesDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_resolved_compose_count_bucket:
        storageManifestCountBucket(this.resolvedComposeCount),
      storage_manifest_resolved_additional_count_bucket:
        storageManifestCountBucket(this.resolvedAdditionalCount),
      storage_manifest_resolved_artifact_count_bucket:
        storageManifestCountBucket(this.resolvedArtifactCount),
      storage_manifest_planned_presign_count_bucket: storageManifestCountBucket(
        this.plannedPresignCount(),
      ),
      storage_manifest_duplicate_presign_candidate_count_bucket:
        storageManifestCountBucket(this.duplicatePresignCandidateCount()),
      ...this.sourceDimensions({
        resolved: this.resolvedSourceCounts,
        plannedPresign: this.plannedPresignSourceCounts,
        nonSystemPresign: this.nonSystemPresignSourceCounts,
      }),
      ...this.systemPresignCacheDimensions(),
      ...this.workflowSkillPresignCacheDimensions(),
    };
  }

  generateDimensions(
    kind: StorageManifestEntryKind,
  ): ApiDispatchTimingDimensions {
    switch (kind) {
      case "compose": {
        return {
          storage_manifest_compose_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedComposePresignCount),
          ...this.sourceDimensions({
            plannedPresign: this.plannedPresignSourceCountsByKind.compose,
            nonSystemPresign: this.nonSystemPresignSourceCountsByKind.compose,
          }),
        };
      }
      case "additional": {
        return {
          storage_manifest_additional_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedAdditionalPresignCount),
          ...this.sourceDimensions({
            plannedPresign: this.plannedPresignSourceCountsByKind.additional,
            nonSystemPresign:
              this.nonSystemPresignSourceCountsByKind.additional,
          }),
          ...this.workflowSkillPresignCacheDimensions(),
        };
      }
      case "artifact": {
        return {
          storage_manifest_artifact_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedArtifactPresignCount),
          ...this.sourceDimensions({
            plannedPresign: this.plannedPresignSourceCountsByKind.artifact,
            nonSystemPresign: this.nonSystemPresignSourceCountsByKind.artifact,
          }),
        };
      }
    }
  }

  assembleDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_final_storage_count_bucket: storageManifestCountBucket(
        this.finalStorageCount,
      ),
      storage_manifest_final_artifact_count_bucket: storageManifestCountBucket(
        this.finalArtifactCount,
      ),
      storage_manifest_dropped_compose_count_bucket: storageManifestCountBucket(
        this.droppedComposeCount,
      ),
    };
  }

  private plannedPresignCount(): number {
    return (
      this.plannedComposePresignCount +
      this.plannedAdditionalPresignCount +
      this.plannedArtifactPresignCount
    );
  }

  private duplicatePresignCandidateCount(): number {
    let count = 0;
    for (const candidateCount of this.presignCandidateCounts.values()) {
      count += Math.max(0, candidateCount - 1);
    }
    return count;
  }

  private sourceDimensions(args: {
    readonly resolved?: StorageManifestSourceCounts;
    readonly plannedPresign?: StorageManifestSourceCounts;
    readonly nonSystemPresign?: StorageManifestSourceCounts;
  }): ApiDispatchTimingDimensions {
    const dimensions: Record<string, string> = {};
    for (const source of STORAGE_MANIFEST_SOURCES) {
      if (args.resolved) {
        dimensions[`storage_manifest_source_${source}_resolved_count_bucket`] =
          storageManifestCountBucket(args.resolved[source]);
      }
      if (args.plannedPresign) {
        dimensions[
          `storage_manifest_source_${source}_planned_presign_count_bucket`
        ] = storageManifestCountBucket(args.plannedPresign[source]);
      }
      if (args.nonSystemPresign) {
        dimensions[
          `storage_manifest_source_${source}_non_system_presign_count_bucket`
        ] = storageManifestCountBucket(args.nonSystemPresign[source]);
      }
    }
    return dimensions;
  }

  private systemPresignCacheDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_system_resolved_storage_count_bucket:
        storageManifestCountBucket(this.systemResolvedStorageCount),
      storage_manifest_system_presign_cache_hit_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheHitCount),
      storage_manifest_system_presign_cache_miss_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheMissCount),
      storage_manifest_non_system_presign_count_bucket:
        storageManifestCountBucket(this.nonSystemPresignCount),
    };
  }

  private workflowSkillPresignCacheDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_workflow_skill_presign_cache_hit_count_bucket:
        storageManifestCountBucket(this.workflowSkillPresignCacheHitCount),
      storage_manifest_workflow_skill_presign_cache_miss_count_bucket:
        storageManifestCountBucket(this.workflowSkillPresignCacheMissCount),
    };
  }
}

class StorageManifestEntryPhaseTiming {
  private readonly resolveWindow: StorageManifestPhaseTimingWindow = {
    startedAt: undefined,
    finishedAt: undefined,
  };
  private readonly generateWindow: StorageManifestPhaseTimingWindow = {
    startedAt: undefined,
    finishedAt: undefined,
  };

  constructor(
    private readonly timing: ApiDispatchTimingCollector | undefined,
    private readonly resolveActionType: ApiDispatchTimingActionType,
    private readonly generateActionType: ApiDispatchTimingActionType,
    private readonly resolveDimensions:
      | ApiDispatchTimingDimensionsInput
      | undefined,
    private readonly generateDimensions:
      | ApiDispatchTimingDimensionsInput
      | undefined,
  ) {}

  async measureResolve<T>(operation: () => T | Promise<T>): Promise<T> {
    return await this.measure(this.resolveWindow, operation);
  }

  async measureGenerate<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.generateWindow, operation);
  }

  flushResolve(): void {
    this.record(
      this.resolveActionType,
      this.resolveWindow,
      this.resolveDimensions,
    );
  }

  flushGenerate(): void {
    this.record(
      this.generateActionType,
      this.generateWindow,
      this.generateDimensions,
    );
  }

  private async measure<T>(
    window: StorageManifestPhaseTimingWindow,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.timing) {
      return await operation();
    }

    const startedAt = now();
    window.startedAt =
      window.startedAt === undefined
        ? startedAt
        : Math.min(window.startedAt, startedAt);
    const invoke = async () => {
      return await operation();
    };
    return await invoke().finally(() => {
      const finishedAt = now();
      window.finishedAt =
        window.finishedAt === undefined
          ? finishedAt
          : Math.max(window.finishedAt, finishedAt);
    });
  }

  private record(
    actionType: ApiDispatchTimingActionType,
    window: StorageManifestPhaseTimingWindow,
    dimensions: ApiDispatchTimingDimensionsInput | undefined,
  ): void {
    if (!this.timing) {
      return;
    }

    const finishedAt = window.finishedAt ?? now();
    this.timing.recordElapsed(
      actionType,
      "nested",
      window.startedAt ?? finishedAt,
      finishedAt,
      dimensions,
    );
  }
}

function instructionsMountPath(framework: SupportedFramework | "pi"): string {
  if (framework === "pi") {
    return PI_AGENT_DIR;
  }
  return framework === "codex"
    ? CANONICAL_CODEX_HOME_DIR
    : CANONICAL_CLAUDE_CONFIG_DIR;
}

function instructionsFilename(framework: SupportedFramework | "pi"): string {
  return framework === "pi" ? "AGENTS.md" : getInstructionsFilename(framework);
}

function firstAgentEntry(
  content: AgentExecutionConfig,
): { readonly name: string | undefined; readonly agent: AgentConfig } | null {
  if (content.agent) {
    return { name: undefined, agent: content.agent };
  }

  const firstEntry = Object.entries(content.agents ?? {})[0];
  if (!firstEntry?.[1]) {
    return null;
  }
  return { name: firstEntry[0], agent: firstEntry[1] };
}

function parseVolumeDeclaration(declaration: string): {
  readonly name: string;
  readonly mountPath: string;
} {
  const [name, mountPath, extra] = declaration.split(":");
  if (extra !== undefined || !name?.trim() || !mountPath?.trim()) {
    throw new Error(
      `Invalid volume declaration: ${declaration}. Expected format: volume-name:/mount/path`,
    );
  }
  return { name: name.trim(), mountPath: mountPath.trim() };
}

function expandTemplate(
  value: string,
  vars: Record<string, string> | undefined,
  context: string,
): string {
  const { result, missingVars } = expandVariablesInString(value, {
    vars: vars ?? {},
  });
  if (missingVars.length > 0) {
    throw new Error(
      `${context} is missing required variables: ${missingVars
        .map((ref) => {
          return ref.name;
        })
        .join(", ")}`,
    );
  }
  return result;
}

function resolveComposeVolumes(args: {
  readonly content: AgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly framework: SupportedFramework | "pi";
}): readonly ResolvedVolume[] {
  const entry = firstAgentEntry(args.content);
  if (!entry) {
    return [];
  }

  const resolved: ResolvedVolume[] = [];
  for (const declaration of entry.agent.volumes ?? []) {
    const parsed = parseVolumeDeclaration(declaration);
    const config = args.content.volumes?.[parsed.name];
    if (!config) {
      throw new Error(
        `Volume "${parsed.name}" is not defined in the volumes section`,
      );
    }

    const versionOverride = args.volumeVersionOverrides?.[parsed.name];
    resolved.push({
      name: parsed.name,
      mountPath: parsed.mountPath,
      vasStorageName: expandTemplate(
        config.name,
        args.vars,
        `Volume "${parsed.name}" name`,
      ),
      vasVersion: expandTemplate(
        versionOverride ?? config.version,
        args.vars,
        `Volume "${parsed.name}" version`,
      ),
      optional: config.optional,
      system: config.system,
    });
  }

  if (entry.agent.instructions && entry.name) {
    const storageName = getInstructionsStorageName(entry.name);
    resolved.push({
      name: storageName,
      mountPath: instructionsMountPath(args.framework),
      vasStorageName: storageName,
      vasVersion: "latest",
      instructionsTargetFilename: instructionsFilename(args.framework),
    });
  }

  return resolved;
}

function dedupArtifacts(
  artifacts: readonly ContextArtifact[],
): readonly ContextArtifact[] {
  const byName = new Map<string, ContextArtifact>();
  for (const artifact of artifacts) {
    byName.set(artifact.name, artifact);
  }
  return [...byName.values()];
}

export function storageIndexKey(
  orgId: string,
  userId: string,
  name: string,
): string {
  return JSON.stringify([orgId, userId, name]);
}

function artifactStorageLookup(
  orgId: string,
  userId: string,
  name: string,
): StorageLookup {
  return { orgId, userId, name };
}

function isFullStorageVersionId(version: string): boolean {
  return version.length === VERSION_ID_LENGTH && isValidVersionPrefix(version);
}

export const headStorageVersions = alias(
  storageVersions,
  "head_storage_versions",
);

export const exactStorageVersions = alias(
  storageVersions,
  "exact_storage_versions",
);

export function uniqueStorageIndexRequests(
  requests: readonly StorageRequest[],
): readonly StorageIndexRequest[] {
  const requestsByKey = new Map<string, StorageIndexRequest>();
  for (const request of requests) {
    const exactVersionId =
      request.version !== undefined && isFullStorageVersionId(request.version)
        ? request.version
        : null;
    requestsByKey.set(
      JSON.stringify([
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
        exactVersionId,
      ]),
      { lookup: request.lookup, exactVersionId },
    );
  }
  return [...requestsByKey.values()];
}

export function buildStorageIndex(
  rows: readonly StorageIndexRow[],
): StorageIndex {
  const exactVersionsByStorageId = new Map<
    string,
    Map<string, StorageVersionIndexEntry>
  >();
  for (const row of rows) {
    if (
      row.exactId === null ||
      row.exactS3Key === null ||
      row.exactArchiveSize === null ||
      row.exactFileCount === null
    ) {
      continue;
    }
    const versions =
      exactVersionsByStorageId.get(row.storageId) ??
      new Map<string, StorageVersionIndexEntry>();
    versions.set(row.exactId, {
      id: row.exactId,
      s3Key: row.exactS3Key,
      archiveSize: row.exactArchiveSize,
      fileCount: row.exactFileCount,
    });
    exactVersionsByStorageId.set(row.storageId, versions);
  }

  const index = new Map<string, StorageIndexEntry>();
  for (const row of rows) {
    const key = storageIndexKey(row.orgId, row.userId, row.name);
    if (index.has(key)) {
      continue;
    }
    index.set(key, {
      storageId: row.storageId,
      headVersionId: row.headVersionId,
      s3Prefix: row.s3Prefix,
      headVersion:
        row.headId &&
        row.headS3Key &&
        row.headArchiveSize !== null &&
        row.headFileCount !== null
          ? {
              id: row.headId,
              s3Key: row.headS3Key,
              archiveSize: row.headArchiveSize,
              fileCount: row.headFileCount,
            }
          : null,
      exactVersions:
        exactVersionsByStorageId.get(row.storageId) ??
        new Map<string, StorageVersionIndexEntry>(),
    });
  }
  return index;
}

export interface StorageIndexInput {
  readonly db: ReadonlyDb;
  readonly requests: readonly StorageRequest[];
  readonly timing: ApiDispatchTimingCollector | undefined;
}

export interface StoragePrefixVersionRequest {
  readonly storageId: string;
  readonly version: string;
}

export interface StoragePrefixVersionRow extends StorageVersionIndexEntry {
  readonly storageId: string;
}

export function storagePrefixVersionRequests(
  requests: readonly StorageRequest[],
  index: StorageIndex,
): readonly StoragePrefixVersionRequest[] {
  const unique = new Map<string, StoragePrefixVersionRequest>();
  for (const request of requests) {
    const version = request.version;
    if (
      version === undefined ||
      version === "latest" ||
      isFullStorageVersionId(version)
    ) {
      continue;
    }
    const storage = index.get(
      storageIndexKey(
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
      ),
    );
    if (storage) {
      unique.set(JSON.stringify([storage.storageId, version]), {
        storageId: storage.storageId,
        version,
      });
    }
  }
  return [...unique.values()];
}

export function storageIndexWithPrefixVersions(
  index: StorageIndex,
  versions: readonly StoragePrefixVersionRow[],
): StorageIndex {
  if (versions.length === 0) {
    return index;
  }
  const byStorage = new Map<string, Map<string, StorageVersionIndexEntry>>();
  for (const version of versions) {
    const entries =
      byStorage.get(version.storageId) ??
      new Map<string, StorageVersionIndexEntry>();
    entries.set(version.id, version);
    byStorage.set(version.storageId, entries);
  }
  return new Map(
    [...index].map(([key, entry]) => {
      const added = byStorage.get(entry.storageId);
      return [
        key,
        added
          ? {
              ...entry,
              exactVersions: new Map([...entry.exactVersions, ...added]),
            }
          : entry,
      ];
    }),
  );
}

function storageIndexRequestColumns(requests: readonly StorageIndexRequest[]) {
  return {
    orgIds: requests.map((request) => {
      return request.lookup.orgId;
    }),
    userIds: requests.map((request) => {
      return request.lookup.userId;
    }),
    names: requests.map((request) => {
      return request.lookup.name;
    }),
    exactVersionIds: requests.map((request) => {
      return request.exactVersionId;
    }),
  };
}

function createStorageIndexObject(
  input$: Computed<Promise<StorageIndexInput>>,
): Computed<Promise<StorageIndex>> {
  return computed(async (get) => {
    const input = await get(input$);
    return await measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_load_storage_index",
      "nested",
      async () => {
        const uniqueRequests = uniqueStorageIndexRequests(input.requests);
        if (uniqueRequests.length === 0) {
          return new Map<string, StorageIndexEntry>();
        }

        const { orgIds, userIds, names, exactVersionIds } =
          storageIndexRequestColumns(uniqueRequests);
        // Raw array interpolation expands to a SQL tuple in Drizzle. Keep each
        // zipped array in one driver parameter so the statement shape stays fixed.
        const rows: StorageIndexRow[] = await input.db
          .select({
            orgId: storages.orgId,
            userId: storages.userId,
            name: storages.name,
            storageId: storages.id,
            headVersionId: storages.headVersionId,
            s3Prefix: storages.s3Prefix,
            headId: headStorageVersions.id,
            headS3Key: headStorageVersions.s3Key,
            headArchiveSize: headStorageVersions.archiveSize,
            headFileCount: headStorageVersions.fileCount,
            exactId: exactStorageVersions.id,
            exactS3Key: exactStorageVersions.s3Key,
            exactArchiveSize: exactStorageVersions.archiveSize,
            exactFileCount: exactStorageVersions.fileCount,
          })
          .from(storages)
          .innerJoin(
            sql`unnest(
        ${sql.param(orgIds)}::text[],
        ${sql.param(userIds)}::text[],
        ${sql.param(names)}::varchar(256)[],
        ${sql.param(exactVersionIds)}::varchar(64)[]
      ) AS requested(org_id, user_id, name, version_id)`,
            and(
              eq(storages.orgId, sql`requested.org_id`),
              eq(storages.userId, sql`requested.user_id`),
              eq(storages.name, sql`requested.name`),
            ),
          )
          .leftJoin(
            headStorageVersions,
            eq(storages.headVersionId, headStorageVersions.id),
          )
          .leftJoin(
            exactStorageVersions,
            and(
              eq(
                exactStorageVersions.id,
                sql`NULLIF(requested.version_id, ${storages.headVersionId})`,
              ),
              eq(exactStorageVersions.storageId, storages.id),
            ),
          );

        const index = buildStorageIndex(rows);
        const prefixes = storagePrefixVersionRequests(input.requests, index);
        const queries = prefixes.map((request) => {
          return input.db
            .select({
              storageId: storageVersions.storageId,
              id: storageVersions.id,
              s3Key: storageVersions.s3Key,
              archiveSize: storageVersions.archiveSize,
              fileCount: storageVersions.fileCount,
            })
            .from(storageVersions)
            .where(
              and(
                eq(storageVersions.storageId, request.storageId),
                or(
                  eq(storageVersions.id, request.version),
                  isValidVersionPrefix(request.version)
                    ? like(storageVersions.id, `${request.version}%`)
                    : undefined,
                ),
              ),
            )
            .orderBy(desc(eq(storageVersions.id, request.version)))
            .limit(2);
        });
        const [first, second, ...remaining] = queries;
        const versions = first
          ? await (second ? unionAll(first, second, ...remaining) : first)
          : [];
        return storageIndexWithPrefixVersions(index, versions);
      },
    );
  });
}

function resolveLatestVersion(
  index: StorageIndex,
  lookup: StorageLookup,
): StorageResolution {
  const entry = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );

  if (!entry) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }
  if (!entry.headVersionId) {
    throw new Error(`Storage "${lookup.name}" has no HEAD version`);
  }
  if (!entry.headVersion) {
    throw new Error(`Storage "${lookup.name}" HEAD version not found`);
  }

  return storageResolutionFromVersion(entry, lookup, entry.headVersion);
}

function storageResolutionFromVersion(
  storage: StorageIndexEntry,
  lookup: StorageLookup,
  version: StorageVersionIndexEntry,
): StorageResolution {
  return {
    storageId: storage.storageId,
    versionId: version.id,
    s3Prefix: storage.s3Prefix,
    s3Key: version.s3Key,
    archiveSize: version.archiveSize,
    fileCount: version.fileCount,
    resolvedOrgId: lookup.orgId,
    resolvedUserId: lookup.userId,
  };
}

function resolvePreloadedExactVersion(
  storage: StorageIndexEntry,
  lookup: StorageLookup,
  version: string,
): StorageResolution | null {
  const match =
    storage.headVersion?.id === version
      ? storage.headVersion
      : storage.exactVersions.get(version);
  return match ? storageResolutionFromVersion(storage, lookup, match) : null;
}

function resolvePinnedVersion(
  index: StorageIndex,
  lookup: StorageLookup,
  version: string,
): StorageResolution {
  const storage = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }
  const exactMatch = resolvePreloadedExactVersion(storage, lookup, version);
  if (exactMatch) {
    return exactMatch;
  }
  if (isFullStorageVersionId(version)) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  if (!isValidVersionPrefix(version)) {
    throw new Error(
      `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
    );
  }
  const versions = new Map(storage.exactVersions);
  if (storage.headVersion) {
    versions.set(storage.headVersion.id, storage.headVersion);
  }
  const matches = [...versions.values()].filter((candidate) => {
    return candidate.id.startsWith(version);
  });
  if (matches.length === 0) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous version prefix "${version}" for storage "${lookup.name}". Please use more characters.`,
    );
  }
  const match = matches[0];
  if (!match) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  return storageResolutionFromVersion(storage, lookup, match);
}

function resolveStorageVersion(
  index: StorageIndex,
  lookup: StorageLookup,
  version: string | undefined,
): StorageResolution {
  return version === undefined || version === "latest"
    ? resolveLatestVersion(index, lookup)
    : resolvePinnedVersion(index, lookup, version);
}

function isMissingStorageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("not found in database") ||
      error.message.includes("has no HEAD version"))
  );
}

function volumeStorageName(volume: ResolvedVolume | AdditionalVolume): string {
  return "vasStorageName" in volume ? volume.vasStorageName : volume.name;
}

function volumeVersion(
  volume: ResolvedVolume | AdditionalVolume,
): string | undefined {
  return "vasVersion" in volume ? volume.vasVersion : volume.version;
}

function volumeStorageLookup(
  orgId: string,
  volume: ResolvedVolume | AdditionalVolume,
): StorageLookup {
  return {
    orgId,
    userId: VOLUME_ORG_USER_ID,
    name: volumeStorageName(volume),
  };
}

function resolveVolumeStorage(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly volume: ResolvedVolume | AdditionalVolume;
  readonly primaryOrgId: string;
  readonly allowSystemFallback: boolean;
}): StorageResolution | null {
  if (args.allowSystemFallback && args.volume.system) {
    const systemResult = safeSync(() => {
      return resolveStorageVersion(
        args.index,
        volumeStorageLookup(SYSTEM_ORG_ID, args.volume),
        volumeVersion(args.volume),
      );
    });
    if ("ok" in systemResult) {
      return systemResult.ok;
    }
    if (!isMissingStorageError(systemResult.error)) {
      throw systemResult.error;
    }
  }

  return resolveStorageVersion(
    args.index,
    volumeStorageLookup(args.primaryOrgId, args.volume),
    volumeVersion(args.volume),
  );
}

function resolveComposeStorageInput(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
}): ResolvedManifestStorageInput | null {
  const resolvedResult = safeSync(() => {
    return resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.agentOrgId,
      allowSystemFallback: true,
    });
  });
  if ("error" in resolvedResult) {
    if (args.volume.optional && isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.ok) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.vasStorageName,
    instructionsTargetFilename: args.volume.instructionsTargetFilename,
    optional: args.volume.optional,
    resolved: resolvedResult.ok,
  };
}

function resolveAdditionalStorageInput(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
}): ResolvedManifestStorageInput | null {
  const { source } = args;
  if (source === "connector_skill" || source === "custom_connector_skill") {
    return resolveConnectorSkillStorageInput({
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      volume: args.volume,
      source,
    });
  }
  if (source === "official_workflow") {
    return resolveOfficialWorkflowStorageInput({
      index: args.index,
      volume: args.volume,
    });
  }
  if (args.volume.expectedStorageId !== undefined) {
    throw new Error("Exact Storage identity is unavailable for this source");
  }
  const resolvedResult = safeSync(() => {
    return resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.runtimeOrgId,
      allowSystemFallback: true,
    });
  });
  if ("error" in resolvedResult) {
    if (isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.ok) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    ...(args.volume.baselineCandidate === true
      ? { baselineCandidate: args.volume.baselineCandidate }
      : {}),
    resolved: resolvedResult.ok,
  };
}

const CONNECTOR_SKILL_REGISTRATION_ERROR =
  "Connector skill registration is unavailable";

const CUSTOM_CONNECTOR_SKILL_REGISTRATION_ERROR =
  "Custom connector skill registration is unavailable";

export class OfficialWorkflowArtifactResolutionError extends Error {
  constructor() {
    super("Official Workflow artifact registration is unavailable");
    this.name = "OfficialWorkflowArtifactResolutionError";
  }
}

type ConnectorSkillStorageSource = Extract<
  StorageManifestSource,
  "connector_skill" | "custom_connector_skill"
>;

function connectorSkillRegistrationError(
  source: ConnectorSkillStorageSource,
): Error {
  return new Error(
    source === "connector_skill"
      ? CONNECTOR_SKILL_REGISTRATION_ERROR
      : CUSTOM_CONNECTOR_SKILL_REGISTRATION_ERROR,
  );
}

function resolveConnectorSkillStorageInput(args: {
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: ConnectorSkillStorageSource;
}): ResolvedManifestStorageInput {
  const version = args.volume.version;
  if (
    (args.source === "connector_skill") !== (args.volume.system === true) ||
    version === undefined ||
    !/^[a-f0-9]{64}$/u.test(version)
  ) {
    throw connectorSkillRegistrationError(args.source);
  }

  const ownerOrgId =
    args.source === "connector_skill" ? SYSTEM_ORG_ID : args.runtimeOrgId;
  const lookup = volumeStorageLookup(ownerOrgId, args.volume);
  const storage = args.index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage) {
    throw connectorSkillRegistrationError(args.source);
  }
  const resolved = resolvePreloadedExactVersion(storage, lookup, version);
  if (!resolved) {
    throw connectorSkillRegistrationError(args.source);
  }

  const expectedKey = `${resolved.s3Prefix}/${version}`;
  if (
    resolved.s3Key !== expectedKey ||
    (args.source === "connector_skill" &&
      resolved.s3Prefix !== `${SYSTEM_ORG_ID}/volume/${args.volume.name}`)
  ) {
    throw connectorSkillRegistrationError(args.source);
  }

  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved,
  };
}

function resolveOfficialWorkflowStorageInput(args: {
  readonly index: StorageIndex;
  readonly volume: AdditionalVolume;
}): ResolvedManifestStorageInput {
  const version = args.volume.version;
  const expectedStorageId = args.volume.expectedStorageId;
  if (
    args.volume.system !== true ||
    expectedStorageId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      expectedStorageId,
    ) ||
    version === undefined ||
    !/^[a-f0-9]{64}$/u.test(version)
  ) {
    throw new OfficialWorkflowArtifactResolutionError();
  }

  const lookup = volumeStorageLookup(SYSTEM_ORG_ID, args.volume);
  const storage = args.index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage || storage.storageId !== expectedStorageId) {
    throw new OfficialWorkflowArtifactResolutionError();
  }
  const resolved = resolvePreloadedExactVersion(storage, lookup, version);
  if (!resolved || resolved.storageId !== expectedStorageId) {
    throw new OfficialWorkflowArtifactResolutionError();
  }

  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved,
  };
}

export function resolveArtifactStorageInput(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifact: ContextArtifact;
  readonly source: StorageManifestSource;
}): ResolvedManifestArtifactInput {
  const resolved = resolveStorageVersion(
    args.index,
    artifactStorageLookup(args.runtimeOrgId, args.userId, args.artifact.name),
    args.artifact.version,
  );
  return { artifact: args.artifact, resolved, source: args.source };
}

function storageArchiveKey(resolved: StorageResolution): string {
  return `${resolved.s3Key}/archive.tar.gz`;
}

function knownArchiveSize(resolved: StorageResolution): number | undefined {
  return Number.isSafeInteger(resolved.archiveSize) && resolved.archiveSize > 0
    ? resolved.archiveSize
    : undefined;
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

function readOnlyStorageEntryMetadata(args: {
  readonly plan: ResolvedManifestStoragePlan;
}): PreparedReadOnlyStorageEntry<StorageMountMetadata> {
  const archiveSize = knownArchiveSize(args.plan.resolved);
  return {
    storedMount: {
      orgId: args.plan.resolved.resolvedOrgId,
      userId: args.plan.resolved.resolvedUserId,
      name: args.plan.vasStorageName,
      storageId: args.plan.resolved.storageId,
      versionId: args.plan.resolved.versionId,
      mountPath: args.plan.mountPath,
      ...(archiveSize === undefined ? {} : { archiveSize }),
      ...(args.plan.baselineCandidate === true
        ? { baselineCandidate: args.plan.baselineCandidate }
        : {}),
      ...(args.plan.instructionsTargetFilename
        ? {
            instructionsTargetFilename: args.plan.instructionsTargetFilename,
          }
        : {}),
    },
    persistedMount: {
      orgId: args.plan.resolved.resolvedOrgId,
      userId: args.plan.resolved.resolvedUserId,
      name: args.plan.vasStorageName,
      storageId: args.plan.resolved.storageId,
      version: args.plan.resolved.versionId,
      mountPath: args.plan.mountPath,
      ...(args.plan.optional === undefined
        ? {}
        : { optional: args.plan.optional }),
      ...(args.plan.instructionsTargetFilename === undefined
        ? {}
        : {
            instructionsTargetFilename: args.plan.instructionsTargetFilename,
          }),
    },
    runContextVolume: {
      name: args.plan.name,
      mountPath: args.plan.mountPath,
      vasStorageName: args.plan.vasStorageName,
      vasVersionId: args.plan.resolved.versionId,
    },
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

function writebackStorageEntryMetadata(
  input: ResolvedManifestArtifactInput,
): PreparedWritebackStorageEntry<StorageMountMetadata> {
  const { artifact, resolved } = input;
  const storedMountBase = {
    orgId: resolved.resolvedOrgId,
    userId: resolved.resolvedUserId,
    name: artifact.name,
    storageId: resolved.storageId,
    versionId: resolved.versionId,
    mountPath: artifact.mountPath,
    ...(artifact.missingRootPolicy === undefined
      ? {}
      : { missingRootPolicy: artifact.missingRootPolicy }),
    writeback: true as const,
  };
  const preparedBase = {
    persistedMount: {
      orgId: resolved.resolvedOrgId,
      userId: resolved.resolvedUserId,
      name: artifact.name,
      storageId: resolved.storageId,
      version: resolved.versionId,
      mountPath: artifact.mountPath,
      writeback: true as const,
      ...(artifact.missingRootPolicy === undefined
        ? {}
        : { missingRootPolicy: artifact.missingRootPolicy }),
    },
    runContextArtifact: {
      mountPath: artifact.mountPath,
      vasStorageName: artifact.name,
      vasVersionId: resolved.versionId,
    },
  };
  if (resolved.fileCount === 0) {
    return {
      ...preparedBase,
      storedMount: {
        ...storedMountBase,
        empty: true,
      },
    };
  }

  const archiveSize = knownArchiveSize(resolved);
  return {
    ...preparedBase,
    storedMount: {
      ...storedMountBase,
      ...(archiveSize === undefined ? {} : { archiveSize }),
    },
  };
}

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

async function buildComposeStorageEntry(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
  readonly phaseTiming: StorageManifestEntryPhaseTiming;
  readonly stats?: StorageManifestBuildStats;
}): Promise<ResolvedManifestStoragePlan | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveComposeStorageInput({
      db: args.db,
      index: args.index,
      agentOrgId: args.agentOrgId,
      volume: args.volume,
    });
  });
  if (input) {
    args.stats?.recordResolvedEntry("compose", "compose_volume");
  }
  return input
    ? { ...input, entryKind: "compose", source: "compose_volume" }
    : null;
}

async function buildAdditionalStorageEntry(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
  readonly phaseTiming: StorageManifestEntryPhaseTiming;
  readonly stats?: StorageManifestBuildStats;
}): Promise<ResolvedManifestStoragePlan | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveAdditionalStorageInput({
      db: args.db,
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      volume: args.volume,
      source: args.source,
    });
  });
  if (input) {
    args.stats?.recordResolvedEntry("additional", args.source);
  }
  return input
    ? { ...input, entryKind: "additional", source: args.source }
    : null;
}

function mergeStorageEntries<TEntry>(args: {
  readonly composeEntries: readonly TEntry[];
  readonly additionalEntries: readonly TEntry[];
  readonly mountPath: (entry: TEntry) => string;
}): readonly TEntry[] {
  const additionalMountPaths = new Set(
    args.additionalEntries.map((entry) => {
      return args.mountPath(entry);
    }),
  );
  return [
    ...args.composeEntries.filter((entry) => {
      return !additionalMountPaths.has(args.mountPath(entry));
    }),
    ...args.additionalEntries,
  ];
}

function additionalVolumeSourceAt(
  sources: readonly StorageManifestSource[] | undefined,
  index: number,
): StorageManifestSource {
  return sources?.[index] ?? "unknown";
}

function normalizeAdditionalVolumeSources(args: {
  readonly volumes: readonly AdditionalVolume[] | undefined;
  readonly sources: readonly StorageManifestSource[] | undefined;
}): readonly StorageManifestSource[] | undefined {
  if (!args.sources) {
    return undefined;
  }
  if (args.sources.length !== (args.volumes?.length ?? 0)) {
    throw new Error(
      "Additional volume source count must match additional volume count",
    );
  }
  return args.sources;
}

export async function resolveStorageManifestInputs(
  args: PrepareAgentRunStorageManifestArgs,
): Promise<StorageManifestInputs> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_resolve_inputs",
    "nested",
    () => {
      return {
        artifacts: dedupArtifacts(args.artifacts),
        composeVolumes: resolveComposeVolumes({
          content: args.content,
          vars: args.vars,
          volumeVersionOverrides: args.volumeVersionOverrides,
          framework: args.framework,
        }),
      };
    },
  );
}

function storageManifestRequests(args: {
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly composeVolumes: readonly ResolvedVolume[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
  readonly artifacts: readonly ContextArtifact[];
}): readonly StorageRequest[] {
  const requests: StorageRequest[] = [];

  for (const volume of args.composeVolumes) {
    const version = volumeVersion(volume);
    if (volume.system) {
      requests.push({
        lookup: volumeStorageLookup(SYSTEM_ORG_ID, volume),
        version,
      });
    }
    requests.push({
      lookup: volumeStorageLookup(args.agentOrgId, volume),
      version,
    });
  }
  for (const [index, volume] of (args.additionalVolumes ?? []).entries()) {
    const version = volumeVersion(volume);
    const source = additionalVolumeSourceAt(
      args.additionalVolumeSources,
      index,
    );
    if (
      source === "connector_skill" ||
      source === "custom_connector_skill" ||
      source === "official_workflow"
    ) {
      requests.push({
        lookup: volumeStorageLookup(
          source === "connector_skill" || source === "official_workflow"
            ? SYSTEM_ORG_ID
            : args.runtimeOrgId,
          volume,
        ),
        version,
      });
      continue;
    }
    if (volume.system) {
      requests.push({
        lookup: volumeStorageLookup(SYSTEM_ORG_ID, volume),
        version,
      });
    }
    requests.push({
      lookup: volumeStorageLookup(args.runtimeOrgId, volume),
      version,
    });
  }
  for (const artifact of args.artifacts) {
    requests.push({
      lookup: artifactStorageLookup(
        args.runtimeOrgId,
        args.userId,
        artifact.name,
      ),
      version: artifact.version,
    });
  }

  return requests;
}

function createStorageManifestEntryPhaseTimings(args: {
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): StorageManifestEntryPhaseTimings {
  return {
    compose: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_compose_versions",
      "api_dispatch_prepare_storage_manifest_generate_compose_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("compose");
      },
    ),
    additional: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_additional_versions",
      "api_dispatch_prepare_storage_manifest_generate_additional_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("additional");
      },
    ),
    artifact: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_artifact_versions",
      "api_dispatch_prepare_storage_manifest_generate_artifact_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("artifact");
      },
    ),
  };
}

function isResolvedManifestStoragePlan(
  plan: ResolvedManifestStoragePlan | null,
): plan is ResolvedManifestStoragePlan {
  return plan !== null;
}

async function resolveStorageManifestEntryPlans(args: {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
}): Promise<ResolvedStorageManifestEntryPlans> {
  const input = args.input;
  const [composePlans, additionalPlans, artifactInputs] = await Promise.all([
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_compose_entries",
      "nested",
      async () => {
        return await Promise.all(
          input.composeVolumes.map((volume) => {
            return buildComposeStorageEntry({
              db: input.db,
              index: input.storageIndex,
              agentOrgId: input.agentOrgId,
              volume,
              phaseTiming: args.phaseTimings.compose,
              stats: input.stats,
            });
          }),
        );
      },
    ),
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_additional_entries",
      "nested",
      async () => {
        return await Promise.all(
          (input.additionalVolumes ?? []).map((volume, index) => {
            return buildAdditionalStorageEntry({
              db: input.db,
              index: input.storageIndex,
              runtimeOrgId: input.runtimeOrgId,
              volume,
              source: additionalVolumeSourceAt(
                input.additionalVolumeSources,
                index,
              ),
              phaseTiming: args.phaseTimings.additional,
              stats: input.stats,
            });
          }),
        );
      },
    ),
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_artifact_entries",
      "nested",
      async () => {
        return await Promise.all(
          input.artifacts.map((artifact) => {
            return args.phaseTimings.artifact.measureResolve(() => {
              return resolveArtifactStorageInput({
                db: input.db,
                index: input.storageIndex,
                runtimeOrgId: input.runtimeOrgId,
                userId: input.userId,
                artifact,
                source: "artifact",
              });
            });
          }),
        );
      },
    ),
  ]);

  input.stats?.recordResolvedEntry(
    "artifact",
    "artifact",
    artifactInputs.length,
  );

  return {
    composePlans: composePlans.filter(isResolvedManifestStoragePlan),
    additionalPlans: additionalPlans.filter(isResolvedManifestStoragePlan),
    artifactInputs,
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

export async function resolveStorageEntries(
  input: BuildStorageManifestEntriesArgs,
  branch: StorageManifestCacheBranch,
): Promise<ResolvedStorageEntries> {
  const phaseTimings = createStorageManifestEntryPhaseTimings(input);
  const resolved = await resolveStorageManifestEntryPlans({
    input,
    phaseTimings,
  }).finally(() => {
    phaseTimings.compose.flushResolve();
    phaseTimings.additional.flushResolve();
    phaseTimings.artifact.flushResolve();
  });
  return { input, branch, phaseTimings, resolved };
}

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

/** Assemble runner mounts from immutable version plans and already signed URLs. */
export function buildSignedStorageEntries(
  plan: ResolvedStorageEntries,
  urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>,
): PreparedStorageEntries {
  const { composePlans, additionalPlans } = finalStorageManifestPlans(
    plan.resolved,
  );
  const entries = (plans: readonly ResolvedManifestStoragePlan[]) => {
    return plans.map((entry) => {
      const args = {
        bucket: plan.input.bucket,
        plan: entry,
        urlsByCacheKey,
        stats: plan.input.stats,
      };
      if (isSystemOwnedStoragePlan(entry)) {
        plan.input.stats?.recordSystemResolvedStorage(1);
        return buildSystemStorageEntry(args);
      }
      return isWorkflowSkillStoragePlan(entry)
        ? buildWorkflowSkillStorageEntry(args)
        : buildReadOnlyStorageEntry(args);
    });
  };
  return {
    composeEntries: entries(composePlans),
    additionalEntries: entries(additionalPlans),
    writebackEntries: preparedWritebackStorageEntries({
      bucket: plan.input.bucket,
      inputs: plan.resolved.artifactInputs,
      urlsByCacheKey,
      stats: plan.input.stats,
    }),
    resolvedComposeEntryCount: plan.resolved.composePlans.length,
    resolvedAdditionalEntryCount: plan.resolved.additionalPlans.length,
  };
}

export function storageEntriesMetadata(
  plan: ResolvedStorageEntries,
): PreparedStorageEntries<StorageMountMetadata> {
  const finalPlans = mergeStorageEntries({
    composeEntries: plan.resolved.composePlans,
    additionalEntries: plan.resolved.additionalPlans,
    mountPath: (entry) => {
      return entry.mountPath;
    },
  });
  return {
    composeEntries: finalPlans
      .filter((entry) => {
        return entry.entryKind === "compose";
      })
      .map((entry) => {
        return readOnlyStorageEntryMetadata({ plan: entry });
      }),
    additionalEntries: finalPlans
      .filter((entry) => {
        return entry.entryKind === "additional";
      })
      .map((entry) => {
        return readOnlyStorageEntryMetadata({ plan: entry });
      }),
    writebackEntries: plan.resolved.artifactInputs.map(
      writebackStorageEntryMetadata,
    ),
    resolvedComposeEntryCount: plan.resolved.composePlans.length,
    resolvedAdditionalEntryCount: plan.resolved.additionalPlans.length,
  };
}

function persistedMountIdentity(
  mount: Pick<PersistedStorageMount, "name" | "mountPath">,
): string {
  return JSON.stringify([mount.name, mount.mountPath]);
}

export function assertUniquePersistedMountPaths(
  mounts: readonly PersistedStorageMount[],
): void {
  const paths = new Set<string>();
  for (const mount of mounts) {
    if (paths.has(mount.mountPath)) {
      throw new Error(`Duplicate Storage mount path "${mount.mountPath}"`);
    }
    paths.add(mount.mountPath);
  }
}

export function persistedStorageMountRequests(
  mounts: readonly PersistedStorageMount[],
): readonly StorageRequest[] {
  return mounts.map((mount) => {
    return {
      lookup: {
        orgId: mount.orgId,
        userId: mount.userId,
        name: mount.name,
      },
      version: mount.version,
    };
  });
}

function resolvePersistedStorageMounts(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
}): ResolvedStorageManifestEntryPlans {
  const additionalPlans: ResolvedManifestStoragePlan[] = [];
  const artifactInputs: ResolvedManifestArtifactInput[] = [];

  for (const mount of args.mounts) {
    if (mount.writeback && mount.orgId === SYSTEM_ORG_ID) {
      throw new Error("System Storage cannot be mounted with writeback");
    }
    const lookup: StorageLookup = {
      orgId: mount.orgId,
      userId: mount.userId,
      name: mount.name,
    };
    const storage = args.index.get(
      storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
    );
    if (!storage) {
      if (mount.optional) {
        continue;
      }
      throw new Error(`Storage "${mount.name}" not found in database`);
    }
    if (storage.storageId !== mount.storageId) {
      throw new Error(`Storage "${mount.name}" identity does not match`);
    }

    const resolvedResult = safeSync(() => {
      return resolveStorageVersion(args.index, lookup, mount.version);
    });
    if ("error" in resolvedResult) {
      if (mount.optional && isMissingStorageError(resolvedResult.error)) {
        continue;
      }
      throw resolvedResult.error;
    }
    const resolved = resolvedResult.ok;

    if (mount.writeback) {
      artifactInputs.push({
        artifact: {
          name: mount.name,
          version: mount.version,
          mountPath: mount.mountPath,
          ...(mount.missingRootPolicy === undefined
            ? {}
            : { missingRootPolicy: mount.missingRootPolicy }),
        },
        resolved,
        source: "artifact",
      });
      continue;
    }

    additionalPlans.push({
      name: mount.name,
      vasStorageName: mount.name,
      mountPath: mount.mountPath,
      ...(mount.optional === undefined ? {} : { optional: mount.optional }),
      ...(mount.instructionsTargetFilename === undefined
        ? {}
        : {
            instructionsTargetFilename: mount.instructionsTargetFilename,
          }),
      resolved,
      entryKind: "additional",
      source: "unknown",
    });
  }

  return { composePlans: [], additionalPlans, artifactInputs };
}

export function resolveValidatedPersistedStorageMounts(args: {
  readonly db: ReadonlyDb;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
  readonly branch: Extract<
    StorageManifestCacheBranch,
    "session_writeback" | "captured"
  >;
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): ResolvedStorageEntries {
  const phaseTimings = createStorageManifestEntryPhaseTimings(args);
  const result = safeSync(() => {
    const input: BuildStorageManifestEntriesArgs = {
      db: args.db,
      bucket: args.bucket,
      storageIndex: args.storageIndex,
      agentOrgId: "",
      runtimeOrgId: "",
      userId: "",
      composeVolumes: [],
      additionalVolumes: undefined,
      additionalVolumeSources: undefined,
      artifacts: [],
      timing: args.timing,
      stats: args.stats,
    };
    const resolved = resolvePersistedStorageMounts({
      db: args.db,
      index: args.storageIndex,
      mounts: args.mounts,
    });
    args.stats?.recordResolvedEntry(
      "additional",
      "unknown",
      resolved.additionalPlans.length,
    );
    args.stats?.recordResolvedEntry(
      "artifact",
      "artifact",
      resolved.artifactInputs.length,
    );
    return { input, branch: args.branch, phaseTimings, resolved };
  });
  phaseTimings.compose.flushResolve();
  phaseTimings.additional.flushResolve();
  phaseTimings.artifact.flushResolve();
  if ("error" in result) {
    throw result.error;
  }
  return result.ok;
}

export function resolveSessionWritebackStorageMounts(args: {
  readonly db: ReadonlyDb;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): ResolvedStorageEntries {
  assertUniquePersistedMountPaths(args.mounts);
  return resolveValidatedPersistedStorageMounts({
    ...args,
    branch: "session_writeback",
  });
}

export function combinePreparedStorageEntries<
  TMount extends StorageMountMetadata,
>(args: {
  readonly requested: PreparedStorageEntries<TMount>;
  readonly sessionWriteback: PreparedStorageEntries<TMount>;
}): PreparedStorageEntries<TMount> {
  return {
    composeEntries: args.requested.composeEntries,
    additionalEntries: [
      ...args.requested.additionalEntries,
      ...args.sessionWriteback.additionalEntries,
    ],
    writebackEntries: [
      ...args.requested.writebackEntries,
      ...args.sessionWriteback.writebackEntries,
    ],
    resolvedComposeEntryCount: args.requested.resolvedComposeEntryCount,
    resolvedAdditionalEntryCount:
      args.requested.resolvedAdditionalEntryCount +
      args.sessionWriteback.resolvedAdditionalEntryCount,
  };
}

export async function finalizePreparedStorage<
  TMount extends StorageMountMetadata,
>(args: {
  readonly entries: PreparedStorageEntries<TMount>;
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): Promise<PreparedAgentRunStorage<TMount>> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_assemble",
    "nested",
    () => {
      const readOnlyEntries = mergeStorageEntries({
        composeEntries: args.entries.composeEntries,
        additionalEntries: args.entries.additionalEntries,
        mountPath(entry) {
          return entry.storedMount.mountPath;
        },
      });
      args.stats?.recordFinalStorage({
        composeEntryCount: args.entries.composeEntries.length,
        additionalEntryCount: args.entries.additionalEntries.length,
        finalReadOnlyEntryCount: readOnlyEntries.length,
        finalWritebackEntryCount: args.entries.writebackEntries.length,
        resolvedComposeEntryCount: args.entries.resolvedComposeEntryCount,
        resolvedAdditionalEntryCount: args.entries.resolvedAdditionalEntryCount,
      });
      const writebackEntry = args.entries.writebackEntries[0];
      return {
        runContextStorage: {
          volumes: readOnlyEntries.map((entry) => {
            return entry.runContextVolume;
          }),
          artifact: writebackEntry?.runContextArtifact ?? null,
        },
        storageMounts: normalizeMountOverlay([
          ...readOnlyEntries.map((entry) => {
            return entry.storedMount;
          }),
          ...args.entries.writebackEntries.map((entry) => {
            return entry.storedMount;
          }),
        ]),
        persistedStorageMounts: normalizeMountOverlay([
          ...readOnlyEntries.map((entry) => {
            return entry.persistedMount;
          }),
          ...args.entries.writebackEntries.map((entry) => {
            return entry.persistedMount;
          }),
        ]),
      };
    },
    () => {
      return args.stats?.assembleDimensions();
    },
  );
}

interface SessionStorageOverlay {
  readonly canonicalWritebackMounts: readonly PersistedStorageMount[];
  readonly remainingArtifacts: readonly ContextArtifact[];
}

export function resolveSessionStorageOverlay(args: {
  readonly artifacts: readonly ContextArtifact[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[] | undefined;
}): SessionStorageOverlay {
  const canonicalWritebackByIdentity = new Map(
    (args.persistedStorageMounts ?? []).map((mount) => {
      if (!mount.writeback) {
        throw new Error(
          "Session Storage persistence may only contain writeback mounts",
        );
      }
      return [persistedMountIdentity(mount), mount] as const;
    }),
  );
  const canonicalWritebackMounts = args.artifacts.flatMap((artifact) => {
    const mount = canonicalWritebackByIdentity.get(
      persistedMountIdentity(artifact),
    );
    if (!mount) {
      return [];
    }
    const {
      version: _storedVersion,
      missingRootPolicy: _storedMissingRootPolicy,
      ...mountBase
    } = mount;
    return [
      {
        ...mountBase,
        ...(artifact.version === undefined
          ? {}
          : { version: artifact.version }),
        ...(artifact.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: artifact.missingRootPolicy }),
      },
    ];
  });
  const remainingArtifacts = args.artifacts.filter((artifact) => {
    return !canonicalWritebackByIdentity.has(persistedMountIdentity(artifact));
  });
  return { canonicalWritebackMounts, remainingArtifacts };
}

export function prepareRequestStorageResolution(
  args: PrepareAgentRunStorageManifestArgs,
  bucket: string,
  composeVolumes: readonly ResolvedVolume[],
  artifacts: readonly ContextArtifact[],
): PreparedRequestStorageResolution {
  const additionalVolumeSources = normalizeAdditionalVolumeSources({
    volumes: args.additionalVolumes,
    sources: args.additionalVolumeSources,
  });
  args.stats?.recordRequestedInputs({
    composeCount: composeVolumes.length,
    additionalCount: args.additionalVolumes?.length ?? 0,
    artifactCount: args.artifacts.length,
    dedupedArtifactCount: artifacts.length,
  });

  const input: UnindexedStorageManifestEntriesArgs = {
    db: args.db,
    bucket,
    agentOrgId: args.agentOrgId,
    runtimeOrgId: args.runtimeOrgId,
    userId: args.userId,
    composeVolumes,
    additionalVolumes: args.additionalVolumes,
    additionalVolumeSources,
    artifacts,
    timing: args.timing,
    stats: args.stats,
  };
  return {
    input,
    requests: storageManifestRequests(input),
  };
}

interface CapturedAgentRunStorageArgs {
  readonly db: ReadonlyDb;
  readonly mounts: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}

export type AgentRunStorageInput =
  | {
      readonly kind: "requested";
      readonly args: PrepareAgentRunStorageManifestArgs;
    }
  | { readonly kind: "captured"; readonly args: CapturedAgentRunStorageArgs };

export type AgentRunStorageSelection =
  | {
      readonly kind: "requested";
      readonly args: PrepareAgentRunStorageManifestArgs;
      readonly bucket: string;
      readonly request: PreparedRequestStorageResolution;
      readonly remainingArtifacts: readonly ContextArtifact[];
      readonly canonicalWritebackMounts: readonly PersistedStorageMount[];
      readonly requests: readonly StorageRequest[];
    }
  | {
      readonly kind: "captured";
      readonly args: CapturedAgentRunStorageArgs;
      readonly bucket: string;
      readonly requests: readonly StorageRequest[];
    };

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

// Execution context, launch preparation and pending atomic commit.

const AUTO_MEMORY_ARTIFACT_NAME = MEMORY_ARTIFACT_NAME;

type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;

const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";

export const ORG_SENTINEL_USER_ID = "__org__";

export const L: ReturnType<typeof logger> = logger("AgentRunCreate");

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";

const CONNECTOR_VAR_REF_PREFIX = "$vars.";

const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

const EAGER_STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY = 4;

const COUNT_BUCKET_DIMENSIONS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

type CreateRunBody = Omit<
  z.infer<typeof unifiedRunRequestSchema>,
  "triggerSource"
> & {
  readonly triggerSource: TriggerSource;
};

type DbTransaction = Tx;

const CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT =
  "If you use the built-in image generation tool and it saves generated output image file(s) to local paths, upload each output file you intend to show with `okou web upload-file -f <path>` before telling the web chat user the image is available. Quote the path when needed. Do not provide only sandbox-local paths, because users cannot open local files.";

const IMAGE_RECOGNITION_PROMPT =
  '# Image Recognition Fallback\n\nThis run\'s selected model cannot inspect images directly. To inspect one local PNG, JPEG, or WebP image up to 20 MB, run `okou image-recognition --file <image-path> --prompt "<instruction>"`.';

const RESTRICTED_EXPLICIT_CONTENT_PROMPT = [
  "# Restricted Explicit Content",
  "",
  "Do not create, continue, rewrite, transform, or facilitate any of the following:",
  "- Pornography, explicit sexual acts, sexualized nudity, erotic roleplay, or other content intended for sexual arousal.",
  "- Any sexual depiction or sexualization of minors.",
  "- Graphic violence or gore, including detailed depictions of severe injury, torture, or dismemberment.",
  "- Instructions, methods, or encouragement for suicide or self-harm.",
  "",
  "These rules apply to direct responses and to files, prompts, code, links, or tool calls used to generate text, images, video, or audio, regardless of user or custom instructions.",
  "",
  "You may assist with non-graphic news, medical, educational, historical, safety, moderation, or ordinary fictional contexts. When a request crosses these boundaries, refuse briefly and offer a safe, non-explicit or non-graphic alternative.",
].join("\n");

const MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT = 20;

function buildMcpConnectorPrompt(
  connectorSlugs: readonly string[],
): string | undefined {
  if (connectorSlugs.length === 0) {
    return undefined;
  }
  const sortedSlugs = [...connectorSlugs].sort();
  const listedSlugs = sortedSlugs.slice(
    0,
    MCP_CONNECTOR_PROMPT_INVENTORY_LIMIT,
  );
  const omittedCount = sortedSlugs.length - listedSlugs.length;
  const inventory = listedSlugs.map((slug) => {
    return `- \`${slug}\``;
  });
  if (omittedCount > 0) {
    inventory.push(
      `- ${omittedCount} additional admitted MCP connector${omittedCount === 1 ? " was" : "s were"} omitted from this prompt`,
    );
  }

  return [
    "# MCP Connectors",
    "",
    "The following MCP connectors were admitted when this Run started:",
    ...inventory,
    "",
    "Use the Okou CLI to discover and invoke their tools:",
    "1. Run `okou mcp list --json` to check current connector metadata and availability.",
    "2. Before choosing a tool, run `okou mcp list-tools <connector-slug> --json`.",
    "3. Invoke the exact returned tool name with `okou mcp call <connector-slug> <tool-name> --input '<json>' --json`, providing JSON that matches its input schema.",
    "",
    "Current connector authorization or configuration may differ from this Run-start snapshot. Runner enforcement is authoritative; if discovery or invocation reports that a connector is unavailable, do not bypass it and start a new Run after authorization is updated.",
  ].join("\n");
}

function withOkouTokenSecret(
  body: CreateRunBody,
  okouToken: string,
): CreateRunBody {
  return {
    ...body,
    secrets: {
      ...withoutLegacyAgentRunEnvironmentEntries(body.secrets),
      OKOU_TOKEN: okouToken,
    },
  };
}

function withPendingOkouTokenSecret(body: CreateRunBody): CreateRunBody {
  return { ...body, secrets: pendingOkouTokenSecrets(body.secrets) };
}

export function pendingOkouTokenSecrets(secrets: CreateRunBody["secrets"]) {
  return {
    ...withoutLegacyAgentRunEnvironmentEntries(secrets),
    OKOU_TOKEN: "__pending_okou_token__",
  };
}

function builtInImageModelPrompt(model: ImageModel): string {
  const alias = IMAGE_MODEL_CONFIGS[model].alias;
  return [
    "# Built-in image model",
    "",
    `Built-in image generation uses \`${alias}\`, from the user's image model setting in Settings › Built-in tools.`,
    "- The model cannot be changed per request. Do not pass `--model` to image generation commands.",
    "- If the user asks for a different built-in image model, tell them to change it in Settings › Built-in tools.",
    "- Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.",
  ].join("\n");
}

function withFinalRunAppendSystemPrompt(args: {
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly chatThreadId: string | undefined;
  readonly imageRecognitionAvailable: boolean;
  readonly mcpConnectorSlugs: readonly string[];
  readonly selectedImageModel: ImageModel;
  readonly cliAvailable: boolean;
}): CreateRunBody {
  const appendedParts: string[] = [];
  if (args.cliAvailable) {
    const mcpConnectorPrompt = buildMcpConnectorPrompt(args.mcpConnectorSlugs);
    if (mcpConnectorPrompt) {
      appendedParts.push(mcpConnectorPrompt);
    }
  }
  if (args.imageRecognitionAvailable) {
    appendedParts.push(IMAGE_RECOGNITION_PROMPT);
  }
  if (
    args.framework === "codex" &&
    isWebChatTriggerSource(args.body.triggerSource) &&
    args.chatThreadId
  ) {
    appendedParts.push(CODEX_WEB_IMAGE_GENERATION_UPLOAD_PROMPT);
  }
  appendedParts.push(builtInImageModelPrompt(args.selectedImageModel));
  // Keep this policy last so custom and integration prompts cannot override it.
  appendedParts.push(RESTRICTED_EXPLICIT_CONTENT_PROMPT);

  return {
    ...args.body,
    appendSystemPrompt: [args.body.appendSystemPrompt, ...appendedParts]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
  };
}

interface AgentRunCreateContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

interface RunArtifacts {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
}

interface AgentRunCreateAdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly baselineCandidate?: true;
  readonly expectedStorageId?: string;
}

type AdditionalVolumeSources = readonly StorageManifestSource[] | undefined;

interface PreparedAdditionalVolume {
  readonly volume: AgentRunCreateAdditionalVolume;
  readonly source: StorageManifestSource;
}

interface PreparedAdditionalVolumes {
  readonly volumes: readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly sources: AdditionalVolumeSources;
}

interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

interface ResolvedAgentExecution {
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

type ResolvedRunExecution = ResolvedAgentExecution | ResolvedUnboundExecution;

interface ProductAgentExecutionPlan {
  readonly identity: "agent" | "no-agent";
  readonly content: agentRunCreateAgentExecutionConfig;
}

interface ProductResolutionOptions {
  readonly executionPlan: ProductAgentExecutionPlan;
  readonly timing?: ApiDispatchTimingCollector;
  readonly sessionSnapshot?: ChatThreadExecutionSnapshot;
}

interface AgentExecutionRequestObservation {
  readonly requestUserId: string;
  readonly requestOrgId: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly agentOrgId: string;
}

interface ResolveAgentExecutionOptions {
  readonly agentObservation?: RunAgentObservation;
  readonly productAgentExecutionPlan?: ProductAgentExecutionPlan;
  readonly testOnlyResolveDirectRun?: TestOnlyDirectRunResolver;
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  readonly timing?: ApiDispatchTimingCollector;
  readonly resetNativeSession?: boolean;
  readonly sessionSnapshot?: ChatThreadExecutionSnapshot;
}

type TestOnlyDirectRunResolver = (args: {
  readonly db: ReadonlyDb;
  readonly body: CreateRunBody;
  readonly userId: string;
  readonly orgId: string;
  readonly timing?: ApiDispatchTimingCollector;
}) => Promise<ResolvedAgentExecution | CreateRunErrorResult>;

type ConnectorScopeSource = "explicit" | "stored_agent" | "empty";

export interface EffectiveConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants:
    | readonly AgentCustomConnectorGrant[]
    | undefined;
  readonly source: ConnectorScopeSource;
}

export interface ThreadConnectorSelectionIds {
  /** Candidates are ordered from run-scoped source to persisted preference. */
  readonly connectorIdCandidatesBySlug: ReadonlyMap<
    ConnectorSlug,
    readonly string[]
  >;
  readonly connectorIdCandidatesByCustomConnectorId: ReadonlyMap<
    string,
    readonly string[]
  >;
}

export type RunConnectorCatalogSelection =
  | { readonly kind: "empty" }
  | {
      readonly kind: "scoped";
      readonly selection: ConnectorRuntimeSelection;
    };

export function isEmptyRunConnectorScope(scope: {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}): boolean {
  return (
    scope.allowedConnectorSlugs.length === 0 &&
    scope.allowedCustomConnectorIds.length === 0
  );
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

function runnerReuseKey(chatThreadId: string | undefined): string | null {
  return chatThreadId ? `thread:${chatThreadId}` : null;
}

interface RunnerJobPayload {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly executionContext: StoredExecutionContext;
}

function runnerJobPayload(args: {
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

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
  readonly status: "pending";
}

interface LaunchRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
}

type LaunchRunStatus = "pending" | "failed";

type ThreadSessionBindingAction = ChatThreadSessionResolutionAction;

interface ThreadSessionBindingWrite {
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly action: ThreadSessionBindingAction;
}

interface PersistedAtomicLaunchRows {
  readonly kind: "pending";
  readonly run: RunRecord;
  readonly runnerJobCreatedAt: Date;
  readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
}

interface PreparedRunnerLaunch {
  readonly runnerJobPayload: RunnerJobPayload;
  readonly runContextSnapshot: RunContextAxiomSnapshot;
  readonly runStorageMounts: readonly PersistedStorageMount[];
  readonly sessionStorageMounts: readonly PersistedStorageMount[];
}

type AgentRunCallbackInsert = typeof agentRunCallbacks.$inferInsert;

type QueueFirstRunClaimed = Extract<
  QueueFirstRunClaimResult,
  { readonly kind: "claimed" }
>;

interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

const validatedThreadSessionTransaction = Symbol(
  "validatedThreadSessionTransaction",
);

interface ValidatedThreadSessionSnapshot {
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

type AtomicLaunchCommitAttempt =
  | AtomicLaunchCommitResult
  | CreateRunErrorResult;

export interface AtomicLaunchCommitCompletion {
  readonly result: AtomicLaunchCommitAttempt;
  readonly transactionReturnedAt: number;
}

type CommittedAtomicLaunchResult = Exclude<
  AtomicLaunchCommitResult,
  QueueFirstRunClaimLost
>;

type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
};

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

export type PendingThreadSessionResolution = Pick<
  ChatThreadSessionResolution,
  "action" | "resetNativeSession" | "expected"
>;
export type PendingRunArguments = Pick<
  CreateAgentRunArgs,
  | "userId"
  | "orgId"
  | "body"
  | "apiStartTime"
  | "chatThreadId"
  | "agentRunMetadata"
  | "agentRunModelPin"
  | "codexServiceTier"
  | "queueFirstAssociation"
  | "timingDimensions"
  | "persistProducerRunBinding"
> & { readonly threadSessionResolution?: PendingThreadSessionResolution };

export interface CommitPreparedLaunchArgs {
  readonly db: Db;
  readonly createArgs: PendingRunArguments;
  readonly enforceBuiltInCredits: boolean;
  readonly context: Pick<
    FinalizedPreparedRunContext,
    "body" | "selectedImageModel" | "launchSnapshot" | "officialWorkflowRun"
  > & {
    readonly resolved: Pick<
      ResolvedRunExecution,
      "agentId" | "continuedFromAgentSessionId"
    >;
    readonly modelProvider: Pick<
      ResolvedModelProviderEnvironment,
      | "credentialOwner"
      | "id"
      | "type"
      | "selectedModel"
      | "builtInModelRuntimeRoute"
    > | null;
  };
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

type BuiltinRuntimeTargetRegistration = Extract<
  ConnectorRuntimeTargetRegistration,
  { readonly kind: "builtin" }
>;

interface PermissionManifest {
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  readonly builtinRuntimeTargets?: readonly BuiltinRuntimeTargetRegistration[];
  readonly connectorPermissionBaseline?: StoredConnectorPermissionBaseline;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly billableFirewalls: readonly string[];
}

interface ModelUsageContext {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
}

interface StoredExecutionSecrets {
  // Runtime secret namespace encrypted into executionContext.encryptedSecrets.
  // Keys are the `NAME` in `${{ secrets.NAME }}`; connector/model-provider
  // entries use env aliases, not backing storage secret names.
  readonly secrets: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | null;
  readonly secretConnectorMetadataMap: Record<
    string,
    SecretConnectorMetadata
  > | null;
}

interface BuiltStoredExecutionContext {
  readonly context: StoredExecutionContext;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: PreparedAgentRunStorage["runContextStorage"];
  readonly secretNames: readonly string[];
  // Plain secret values used for run-context redaction; values, not names.
  readonly secretValues: readonly string[];
}

type BuiltStoredExecutionContextDraft = Omit<
  BuiltStoredExecutionContext,
  "context" | "persistedStorageMounts" | "runContextStorage"
> & {
  readonly context: Omit<StoredExecutionContext, "storageMounts">;
};

type ApiErrorResponse<Status extends number, Code extends string> = {
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

function assertThreadBoundRunHasQueueAssociation(
  args: CreateAgentRunArgs,
): void {
  if (args.chatThreadId !== undefined && !args.queueFirstAssociation) {
    throw new Error("Thread-bound run requires a queue-first association");
  }
}

interface BuiltinConnectorRuntimeContext {
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

export interface PersistedRunEnvironmentSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly userId: string;
}

export interface PersistedRunEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

interface PersistedRunEnvironmentSnapshot {
  readonly secrets: readonly PersistedRunEnvironmentSecret[];
  readonly variables: readonly PersistedRunEnvironmentVariable[];
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

export function emptyCustomConnectorRuntimeContext(): CustomConnectorRuntimeContext {
  return {
    firewalls: [],
    reservedSecretAliases: undefined,
    permissionPolicies: undefined,
    targets: [],
    customConnectorIdByFirewallName: {},
    customConnectorSourceIdByFirewallName: {},
    mcpConnectorSlugs: [],
    skills: [],
  };
}

function forbidden(message: string): ApiErrorResponse<403, "FORBIDDEN"> {
  return {
    status: 403,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

export function insufficientCredits(): ApiErrorResponse<
  402,
  "INSUFFICIENT_CREDITS"
> {
  return {
    status: 402,
    body: {
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    },
  };
}

function mergeAdditionalVolumes(args: {
  readonly prepend: readonly PreparedAdditionalVolume[] | undefined;
  readonly base: readonly PreparedAdditionalVolume[] | undefined;
}): PreparedAdditionalVolumes {
  const prepared =
    args.prepend || args.base
      ? [...(args.prepend ?? []), ...(args.base ?? [])]
      : undefined;
  return {
    volumes: prepared?.map((item) => {
      return item.volume;
    }),
    sources: prepared?.map((item) => {
      return item.source;
    }),
  };
}

function prepareAdditionalVolumesWithSource(
  volumes: readonly AgentRunCreateAdditionalVolume[] | undefined,
  source: StorageManifestSource,
): readonly PreparedAdditionalVolume[] | undefined {
  return volumes?.map((volume) => {
    return { volume, source };
  });
}

function frameworkSkillsMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? `${CANONICAL_CODEX_HOME_DIR}/skills`
    : `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`;
}

function skillMountPath(skillsRoot: string, skillName: string): string {
  return `${skillsRoot}/${skillName}`;
}

type ConnectorSkillVolumeSource = Extract<
  StorageManifestSource,
  "connector_skill" | "custom_connector_skill"
>;

function buildExactConnectorSkillVolume(args: {
  readonly name: string;
  readonly version: string;
  readonly mountPath: string;
  readonly source: ConnectorSkillVolumeSource;
}): PreparedAdditionalVolume {
  return {
    volume: {
      name: args.name,
      version: args.version,
      mountPath: args.mountPath,
      ...(args.source === "connector_skill" ? { system: true } : {}),
    },
    source: args.source,
  };
}

// Legacy CLI runs use the framework resolved from the model provider, never
// the framework declared in the compose. Eligible Pi runs instead receive the
// fixed Pi root before Storage resolves any versions or overlays.
function buildLegacySystemSkillVolumes(
  skillNames: readonly string[],
  skillsRoot: string,
  storageResolution: SystemSkillStorageResolution,
): readonly AgentRunCreateAdditionalVolume[] {
  return [...new Set(skillNames)].flatMap((skillName) => {
    const url = resolveSkillRef(skillName);
    const parsed = parseGitHubTreeUrl(url);
    if (!parsed) {
      return [];
    }
    return [
      {
        name:
          storageResolution[skillName] ?? getSkillStorageName(parsed.fullPath),
        mountPath: skillMountPath(skillsRoot, parsed.skillName),
        system: true,
      },
    ];
  });
}

function buildConnectorSkillVolumes(
  connectorSlugs: readonly ConnectorSlug[],
  snapshot: ConnectorRuntimeSelection,
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] {
  return connectorSlugs.flatMap((connectorSlug) => {
    const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
    if (connector === undefined) {
      throw new Error("Accepted connector skill metadata is unavailable");
    }
    if (connector.skill.kind === "none") {
      return [];
    }
    const prepared = buildExactConnectorSkillVolume({
      name: connector.skill.storageName,
      version: connector.skill.versionId,
      mountPath: skillMountPath(skillsRoot, connectorSlug),
      source: "connector_skill",
    });
    return [prepared];
  });
}

function mountedWorkflowRefs(
  workflows: readonly RunWorkflowRef[],
): readonly RunWorkflowRef[] {
  return workflows.filter((workflow) => {
    return !SEED_SKILLS.includes(workflow.name);
  });
}

export function officialWorkflowRunCandidates(
  workflows: readonly RunWorkflowRef[],
  skillsRoot: string,
  requiredWorkflowIds: readonly string[],
): readonly {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly definitionName: string;
  readonly mountPath: string;
}[] {
  for (const workflow of workflows) {
    if (
      workflow.officialDefinitionName !== null &&
      SEED_SKILLS.includes(workflow.name)
    ) {
      throw new OfficialWorkflowRunAdmissionError();
    }
  }
  const candidates = mountedWorkflowRefs(workflows).flatMap((workflow) => {
    return workflow.officialDefinitionName === null
      ? []
      : [
          {
            workflowId: workflow.workflowId,
            workflowName: workflow.name,
            definitionName: workflow.officialDefinitionName,
            mountPath: skillMountPath(skillsRoot, workflow.name),
          },
        ];
  });
  const candidateWorkflowIds = new Set(
    candidates.map((candidate) => {
      return candidate.workflowId;
    }),
  );
  if (
    new Set(requiredWorkflowIds).size !== requiredWorkflowIds.length ||
    requiredWorkflowIds.some((workflowId) => {
      return !candidateWorkflowIds.has(workflowId);
    })
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  return candidates;
}

function buildWorkflowSkillVolumes(
  workflows: readonly RunWorkflowRef[],
  skillsRoot: string,
  officialWorkflowRun: OfficialWorkflowRunObservation | undefined,
): readonly PreparedAdditionalVolume[] {
  return mountedWorkflowRefs(workflows).map((workflow) => {
    if (workflow.officialDefinitionName !== null) {
      const definition = officialWorkflowRun?.definitions.find((candidate) => {
        return candidate.workflowId === workflow.workflowId;
      });
      if (!definition) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      return {
        volume: {
          name: definition.artifact.storageName,
          version: definition.artifact.storageVersion,
          mountPath: definition.mountPath,
          system: true,
          expectedStorageId: definition.artifact.storageId,
        },
        source: "official_workflow" as const,
      };
    }
    return {
      volume: {
        // The volume is keyed by the workflow id; it mounts at the slug.
        name: getCustomSkillStorageName(workflow.workflowId),
        mountPath: skillMountPath(skillsRoot, workflow.name),
      },
      source: "workflow_skill" as const,
    };
  });
}

function buildCustomConnectorSkillVolumes(
  skills: CustomConnectorRuntimeContext["skills"],
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] {
  return skills.map((skill) => {
    return buildExactConnectorSkillVolume({
      name: getCustomConnectorSkillStorageName(skill.connectorId),
      version: skill.versionId,
      mountPath: skillMountPath(
        skillsRoot,
        getCustomConnectorSkillName(skill.connectorSlug, skill.connectorId),
      ),
      source: "custom_connector_skill",
    });
  });
}

function buildInjectedSkillVolumes(
  args: {
    readonly injectSkillVolumes: CreateAgentRunArgs["injectSkillVolumes"];
    readonly systemSkillStorageResolution: SystemSkillStorageResolution;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[];
    readonly connectorCatalogSelection: RunConnectorCatalogSelection;
    readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  },
  skillsRoot: string,
): readonly PreparedAdditionalVolume[] | undefined {
  if (!args.injectSkillVolumes) {
    return undefined;
  }
  // Connector rollout switches govern discovery only. Once a connector slug is
  // part of a run, its accepted catalog skill remains executable and mountable.
  const systemSkillVolumes = [
    ...(prepareAdditionalVolumesWithSource(
      buildLegacySystemSkillVolumes(
        SEED_SKILLS,
        skillsRoot,
        args.systemSkillStorageResolution,
      ).map((volume) => {
        return { ...volume, baselineCandidate: true };
      }),
      "system_skill",
    ) ?? []),
    ...(args.connectorCatalogSelection.kind === "scoped"
      ? buildConnectorSkillVolumes(
          args.allowedConnectorSlugs,
          args.connectorCatalogSelection.selection,
          skillsRoot,
        )
      : []),
  ];
  return [
    ...systemSkillVolumes,
    ...buildWorkflowSkillVolumes(
      args.injectSkillVolumes.workflows,
      skillsRoot,
      args.officialWorkflowRun,
    ),
  ];
}

export function isRouteError(value: unknown): value is CreateRunErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { readonly status: unknown }).status === "number" &&
    (value as { readonly status: number }).status !== 201
  );
}

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

function firstAgent(
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

function resolveFramework(
  content: agentRunCreateAgentExecutionConfig,
): SupportedFramework | null {
  const framework = firstAgent(content)?.framework;
  if (!isSupportedFramework(framework)) {
    return null;
  }
  return framework;
}

export function modelProviderFramework(
  modelProvider: ResolvedModelProviderEnvironment,
): SupportedFramework {
  return getFrameworkForType(modelProvider.concreteType ?? modelProvider.type);
}

export function frameworkForProviderSelection(
  catalog: ModelCatalog,
  providerType: ModelProviderType,
  selectedModel: string | null | undefined,
): SupportedFramework | null {
  if (!isBuiltInModelProviderType(providerType)) {
    return getFrameworkForType(providerType);
  }
  // The Built-in framework follows the primary catalog candidate's concrete
  // provider protocol.
  const [primary] = catalogBuiltInCandidates(
    catalog,
    selectedModel ?? catalog.systemDefaultModel,
  );
  const concrete = primary?.concreteProviderType;
  return concrete !== undefined && isModelProviderType(concrete)
    ? getFrameworkForType(concrete)
    : null;
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

export function frameworkApiKeyEnv(framework: SupportedFramework): string {
  return framework === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function autoMemoryMountPath(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  if (piSandbox !== undefined) {
    return PI_MEMORY_ROOT;
  }
  return framework === "codex"
    ? CANONICAL_CODEX_MEMORY_MOUNT_PATH
    : CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
}

function autoMemoryArtifact(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): AgentRunCreateContextArtifact {
  return withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: autoMemoryMountPath(framework, piSandbox),
  });
}

function isCanonicalAutoMemoryArtifact(
  artifact: AgentRunCreateContextArtifact,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME &&
    artifact.mountPath === autoMemoryMountPath(framework, piSandbox)
  );
}

function withAutoMemoryMissingRootPolicy(
  artifact: AgentRunCreateContextArtifact,
): AgentRunCreateContextArtifact {
  return {
    ...artifact,
    missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
  };
}

function withCanonicalAutoMemoryMissingRootPolicy(
  artifacts: readonly AgentRunCreateContextArtifact[],
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): readonly AgentRunCreateContextArtifact[] {
  return artifacts.map((artifact) => {
    return isCanonicalAutoMemoryArtifact(artifact, framework, piSandbox)
      ? withAutoMemoryMissingRootPolicy(artifact)
      : artifact;
  });
}

function claimsAutoMemorySlot(
  artifact: AgentRunCreateContextArtifact,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
    artifact.mountPath === autoMemoryMountPath(framework, piSandbox)
  );
}

function withoutSupersededAutoMemoryArtifacts(
  artifacts: readonly AgentRunCreateContextArtifact[],
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
  slotOwnerIndex: number,
): readonly AgentRunCreateContextArtifact[] {
  return artifacts.filter((artifact, index) => {
    return (
      index >= slotOwnerIndex ||
      !isCanonicalAutoMemoryArtifact(artifact, framework, piSandbox)
    );
  });
}

function withPinnedPiContinuationMemory(
  artifacts: readonly AgentRunCreateContextArtifact[],
  previousRunStorageMounts: readonly PersistedStorageMount[] | undefined,
): readonly AgentRunCreateContextArtifact[] {
  const previousMemoryMount = previousRunStorageMounts?.find((mount) => {
    return (
      mount.name === AUTO_MEMORY_ARTIFACT_NAME &&
      mount.mountPath === PI_MEMORY_ROOT &&
      mount.version !== undefined
    );
  });
  if (!previousMemoryMount?.version) {
    return artifacts;
  }
  const pinnedMemoryArtifact = withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    version: previousMemoryMount.version,
    mountPath: PI_MEMORY_ROOT,
  });
  let slotOwnerIndex: number | undefined;
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (
      artifact &&
      (artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
        artifact.mountPath === PI_MEMORY_ROOT)
    ) {
      slotOwnerIndex = index;
      break;
    }
  }
  if (slotOwnerIndex === undefined) {
    return [...artifacts, pinnedMemoryArtifact];
  }
  const slotOwner = artifacts[slotOwnerIndex]!;
  if (
    slotOwner.name !== AUTO_MEMORY_ARTIFACT_NAME ||
    slotOwner.mountPath !== PI_MEMORY_ROOT
  ) {
    return artifacts;
  }
  return artifacts.map((artifact, index) => {
    return index === slotOwnerIndex ? pinnedMemoryArtifact : artifact;
  });
}

function artifactsForRun(args: {
  readonly resolved: Pick<
    ResolvedRunExecution,
    "agentSessionId" | "artifacts" | "previousRunStorageMounts"
  >;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly includeAutoMemory: boolean;
  readonly pinnedMemoryVersionId: string | undefined;
}): RunArtifacts {
  const isContinuation = Boolean(args.resolved.agentSessionId);
  const baseArtifacts =
    isContinuation && args.piSandbox !== undefined && args.includeAutoMemory
      ? withPinnedPiContinuationMemory(
          args.resolved.artifacts,
          args.resolved.previousRunStorageMounts,
        )
      : args.resolved.artifacts;
  // A producer-pinned memory baseline claims the auto-memory slot last.
  const artifacts =
    args.pinnedMemoryVersionId === undefined
      ? baseArtifacts
      : [
          ...baseArtifacts,
          {
            ...autoMemoryArtifact(args.framework, args.piSandbox),
            version: args.pinnedMemoryVersionId,
          },
        ];
  if (!args.includeAutoMemory) {
    return {
      artifacts: artifacts.filter((artifact) => {
        return (
          artifact.name !== AUTO_MEMORY_ARTIFACT_NAME &&
          artifact.mountPath !== PI_MEMORY_ROOT
        );
      }),
    };
  }

  let autoMemorySlotArtifactIndex: number | undefined;
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (
      artifact &&
      claimsAutoMemorySlot(artifact, args.framework, args.piSandbox)
    ) {
      autoMemorySlotArtifactIndex = index;
      break;
    }
  }
  if (autoMemorySlotArtifactIndex === undefined) {
    return {
      artifacts: [
        ...artifacts,
        autoMemoryArtifact(args.framework, args.piSandbox),
      ],
    };
  }

  const slotOwner = artifacts[autoMemorySlotArtifactIndex]!;
  if (
    !isCanonicalAutoMemoryArtifact(slotOwner, args.framework, args.piSandbox)
  ) {
    return {
      artifacts: withoutSupersededAutoMemoryArtifacts(
        artifacts,
        args.framework,
        args.piSandbox,
        autoMemorySlotArtifactIndex,
      ),
    };
  }

  return {
    artifacts: withCanonicalAutoMemoryMissingRootPolicy(
      artifacts,
      args.framework,
      args.piSandbox,
    ),
  };
}

function runnerGroup(
  content: agentRunCreateAgentExecutionConfig,
): string | null {
  return firstAgent(content)?.experimental_runner?.group ?? null;
}

function runnerProfile(content: agentRunCreateAgentExecutionConfig): string {
  return firstAgent(content)?.experimental_profile ?? DEFAULT_PROFILE;
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
}

function connectorEnvironmentTemplate(
  envName: string,
  valueRef: string,
): string {
  if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
    return `\${{ secrets.${envName} }}`;
  }
  if (valueRef.startsWith(CONNECTOR_VAR_REF_PREFIX)) {
    return `\${{ vars.${envName} }}`;
  }
  return valueRef;
}

function addConnectorEnvironmentTemplate(
  environment: Record<string, string>,
  envName: string,
  valueRef: string,
): void {
  if (envName in environment) {
    return;
  }
  environment[envName] = connectorEnvironmentTemplate(envName, valueRef);
}

function environmentTemplates(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly additionalEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const environment = firstAgent(args.content)?.environment;
  return mergeRecords(args.additionalEnvironment, environment);
}

function expandEnvironment(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): Record<string, string> | null {
  const storedConnectorEnvironment = expandStoredConnectorEnvironment({
    environment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const mergedEnvironment = environmentTemplates({
    content: args.content,
    additionalEnvironment: args.additionalEnvironment,
  });
  if (!mergedEnvironment) {
    return storedConnectorEnvironment ?? null;
  }

  const { result } = expandVariables(mergedEnvironment, {
    vars: args.vars,
    secrets: {
      ...args.secrets,
      ...args.environmentSecretPlaceholders,
    },
  });
  return mergeRecords(result, storedConnectorEnvironment) ?? null;
}

function effectiveStoredConnectorEnvironment(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  if (!args.storedConnectorEnvironment) {
    return undefined;
  }

  const overrides = mergeRecords(
    args.additionalEnvironment,
    firstAgent(args.content)?.environment,
  );
  if (!overrides) {
    return args.storedConnectorEnvironment;
  }

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.storedConnectorEnvironment)) {
    if (overrides[key] === undefined) {
      environment[key] = value;
    }
  }
  return compactRecord(environment);
}

function expandStoredConnectorEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): Record<string, string> | undefined {
  if (!args.environment) {
    return undefined;
  }

  const expanded: Record<string, string> = {};
  const secretSources = mergeRecords(
    args.secrets,
    args.environmentSecretPlaceholders,
  );
  for (const [key, value] of Object.entries(args.environment)) {
    const expansion = expandVariablesInString(value, {
      vars: args.vars,
      secrets: secretSources,
    });
    if (expansion.missingVars.length > 0) {
      throw new Error(
        `Stored connector environment is missing required values: ${formatMissingReferences(expansion.missingVars)}`,
      );
    }
    expanded[key] = expansion.result;
  }
  return compactRecord(expanded);
}

function formatMissingReferences(
  refs: readonly { readonly source: string; readonly name: string }[],
): string {
  return refs
    .map((ref) => {
      return `${ref.source}.${ref.name}`;
    })
    .join(", ");
}

function firewallSecretPlaceholdersFromFirewalls(
  firewalls: readonly ExpandedFirewallConfig[] | undefined,
): Record<string, string> | undefined {
  if (!firewalls || firewalls.length === 0) {
    return undefined;
  }

  const placeholders: Record<string, string> = {};
  for (const firewall of firewalls) {
    const secretNames = extractSecretNamesFromApis(firewall.apis);
    for (const name of secretNames) {
      placeholders[name] = DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
    }
    for (const [name, value] of Object.entries(firewall.placeholders ?? {})) {
      placeholders[name] = value;
    }
  }

  return Object.keys(placeholders).length > 0 ? placeholders : undefined;
}

function missingEnvironmentReferences(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): string[] {
  assertStoredConnectorEnvironmentReferences({
    environment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const environment = environmentTemplates({
    content: args.content,
    additionalEnvironment: args.additionalEnvironment,
  });
  const environmentMissing = missingReferencesInEnvironment({
    environment,
    vars: args.vars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  return environmentMissing;
}

function missingReferencesInEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): string[] {
  if (!args.environment) {
    return [];
  }
  const grouped = extractAndGroupVariables(args.environment);
  const missingVars = grouped.vars
    .filter((ref) => {
      return args.vars?.[ref.name] === undefined;
    })
    .map((ref) => {
      return `vars.${ref.name}`;
    });
  const missingSecrets = grouped.secrets
    .filter((ref) => {
      return (
        args.secrets?.[ref.name] === undefined &&
        args.environmentSecretPlaceholders?.[ref.name] === undefined
      );
    })
    .map((ref) => {
      return `secrets.${ref.name}`;
    });
  return [...missingVars, ...missingSecrets];
}

function assertStoredConnectorEnvironmentReferences(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): void {
  const missing = missingReferencesInEnvironment(args);
  if (missing.length > 0) {
    throw new Error(
      `Stored connector environment is missing required values: ${missing.join(", ")}`,
    );
  }
}

export function hasExplicitFrameworkApiKey(
  content: agentRunCreateAgentExecutionConfig,
  framework: SupportedFramework,
): boolean {
  return (
    firstAgent(content)?.environment?.[frameworkApiKeyEnv(framework)] !==
    undefined
  );
}

export function isModelProviderType(type: string): type is ModelProviderType {
  return Object.hasOwn(MODEL_PROVIDER_TYPES, type);
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

function envBindingsRequireModel(
  envBindings: ModelProviderEnvBindings,
): boolean {
  return Object.values(envBindings).some((value) => {
    return value.includes("$model");
  });
}

function resolveModelProviderModel(args: {
  readonly type: ModelProviderType;
  readonly selectedModel: string | null;
  readonly defaultModel: string | undefined;
  readonly envBindings: ModelProviderEnvBindings | undefined;
}): string | null {
  let model = args.selectedModel;
  if (model === null && args.defaultModel !== undefined) {
    model = args.defaultModel;
  }
  if (
    args.envBindings &&
    envBindingsRequireModel(args.envBindings) &&
    !model &&
    args.defaultModel !== ""
  ) {
    throw new Error(`Missing model for model provider ${args.type}`);
  }
  return model === "" ? null : model;
}

function modelProviderEnvironmentSecretValue(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
): string {
  return getModelProviderFirewall(type)
    ? `\${{ secrets.${secretName} }}`
    : secretValue;
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

function resolveModelProviderCodexRuntimeConfig(args: {
  readonly type: ModelProviderType;
  readonly logicalModel: string | null;
  readonly runtimeModel: string;
  readonly environment: Readonly<Record<string, string>>;
}): ModelProviderCodexRuntimeConfig | undefined {
  const providerConfig = getModelProviderCodexRuntimeConfig(args.type);
  if (providerConfig) {
    return providerConfig;
  }
  const providerCapabilities = getModelProviderCodexRuntimeCapabilities(
    args.type,
  );
  if (!providerCapabilities) {
    return undefined;
  }
  const modelCatalog = args.logicalModel
    ? getModelProviderCodexCatalogForModel(
        args.logicalModel,
        args.runtimeModel,
        args.type,
      )
    : undefined;
  const baseUrl = args.environment.OPENAI_BASE_URL;
  if (!baseUrl) {
    throw new Error(`Missing OPENAI_BASE_URL for Codex provider ${args.type}`);
  }
  return {
    providerId: args.type,
    name: MODEL_PROVIDER_TYPES[args.type].label,
    baseUrl,
    envKey: "OPENAI_API_KEY",
    requiresOpenaiAuth: false,
    wireApi: "responses",
    supportsWebsockets: providerCapabilities.supportsWebsockets,
    ...(modelCatalog ? { modelCatalog } : {}),
  };
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

function providerEnvironmentFromSecretRefs(
  type: ModelProviderType,
  secretName: string,
  secretValue: string,
  selectedModel: string | null,
): Record<string, string> {
  const envBindings = getModelProviderEnvBindings(type);
  if (!envBindings) {
    return {
      [secretName]: modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      ),
    };
  }

  const model = resolveModelProviderModel({
    type,
    selectedModel,
    defaultModel: getDefaultModel(type),
    envBindings,
  });
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(envBindings)) {
    if (value === "$secret") {
      environment[key] = modelProviderEnvironmentSecretValue(
        type,
        secretName,
        secretValue,
      );
    } else if (value === "$model") {
      if (model) {
        environment[key] = model;
      }
    } else if (value.startsWith("$secrets.")) {
      const referencedSecret = value.slice("$secrets.".length);
      if (referencedSecret === secretName) {
        environment[key] = modelProviderEnvironmentSecretValue(
          type,
          referencedSecret,
          secretValue,
        );
      }
    } else {
      environment[key] = value;
    }
  }
  return environment;
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
      !isCloudModelMappingValid(args.type, selectedModel, runtimeModel))
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
  resolvedRoute?: BuiltInModelRuntimeRoute,
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

export interface ResolveModelProviderEnvironmentArgs {
  /** Loaded once per run and shared by every candidate route. */
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly framework: SupportedFramework;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly retainedRunId?: string;
  readonly piExecution: boolean;
  readonly featureSwitchContext: FeatureSwitchContext;
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
      (await loadSystemDefaultRunModel(db));
    const provider = await builtInModelProviderEnvironment(
      db,
      args.catalog,
      selectedModel,
      args.featureSwitchContext,
      args.builtInModelRuntimeRoute,
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
      args.selectedModelOverride ?? (await loadSystemDefaultRunModel(db)),
      args.featureSwitchContext,
      args.builtInModelRuntimeRoute,
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
      secretNames: runEnvironmentSecretNames(content),
    };
  });
  return createRunEnvironmentSnapshotObject(readInput$);
}

export function runEnvironmentSecretNames(
  content: agentRunCreateAgentExecutionConfig,
) {
  const environment = firstAgent(content)?.environment;
  return [
    ...new Set(
      environment
        ? extractAndGroupVariables(environment).secrets.map((ref) => {
            return ref.name;
          })
        : [],
    ),
  ].sort();
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

export function buildMergedVariables(args: {
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly runVars: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.persistedEnvironment.variables) {
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  const merged = { ...orgVars, ...userVars, ...args.runVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function buildReferencedSecrets(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly runSecrets: Record<string, string> | undefined;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<Record<string, string> | undefined> {
  const environment = firstAgent(args.content)?.environment;
  const referencedNames = environment
    ? extractAndGroupVariables(environment).secrets.map((ref) => {
        return ref.name;
      })
    : [];
  if (referencedNames.length === 0) {
    return args.runSecrets;
  }

  const orgSecrets: Record<string, string> = {};
  const userSecrets: Record<string, string> = {};
  for (const row of args.persistedEnvironment.secrets) {
    const target =
      row.userId === ORG_SENTINEL_USER_ID ? orgSecrets : userSecrets;
    target[row.name] = await decryptStoredSecretValue(
      row.encryptedValue,
      args.featureSwitchContext,
    );
  }

  const merged = { ...orgSecrets, ...userSecrets, ...args.runSecrets };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeRecords<T>(
  ...records: readonly (Record<string, T> | undefined)[]
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
  for (const record of records) {
    if (record) {
      Object.assign(merged, record);
    }
  }
  return compactRecord(merged);
}

export function withoutLegacyAgentRunEnvironmentEntries<T>(
  values: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (!values) {
    return undefined;
  }
  const canonical: Record<string, T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("ZERO_")) {
      canonical[key] = value;
    }
  }
  return compactRecord(canonical);
}

function withoutOkouNamespaceEntries<T>(
  values: Readonly<Record<string, T>> | null,
): Record<string, T> | null {
  if (!values) {
    return null;
  }
  const untrusted: Record<string, T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("OKOU_")) {
      untrusted[key] = value;
    }
  }
  return compactRecord(untrusted) ?? null;
}

function filterSecretConnectorMap(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly overriddenSecrets: readonly (
    | Readonly<Record<string, unknown>>
    | undefined
  )[];
}): Record<string, string> | undefined {
  if (!args.secretConnectorMap) {
    return undefined;
  }

  const overridden = new Set<string>();
  for (const secrets of args.overriddenSecrets) {
    for (const key of Object.keys(secrets ?? {})) {
      overridden.add(key);
    }
  }
  const filtered = Object.fromEntries(
    Object.entries(args.secretConnectorMap).filter(([key]) => {
      return !overridden.has(key);
    }),
  );
  return compactRecord(filtered);
}

function filterSecretConnectorMetadataMap(args: {
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
}): Record<string, SecretConnectorMetadata> | undefined {
  if (!args.secretConnectorMetadataMap || !args.secretConnectorMap) {
    return undefined;
  }

  const filtered: Record<string, SecretConnectorMetadata> = {};
  for (const key of Object.keys(args.secretConnectorMap)) {
    const metadata = args.secretConnectorMetadataMap[key];
    if (metadata) {
      filtered[key] = metadata;
    }
  }
  return compactRecord(filtered);
}

interface StoredConnectorRuntimeRow {
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly access: BuiltinConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly isMcp: boolean;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface StoredConnectorRuntimeRowCandidate {
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly connectorStateRevision: bigint;
  readonly needsReconnect: boolean;
  readonly orgId: string;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly userId: string;
}

export interface StoredConnectorMaterializationSnapshotRow extends StoredConnectorRuntimeRowCandidate {
  readonly secretNames: readonly string[];
  readonly variableValues: Readonly<Record<string, string>>;
}

export const storedConnectorSecretNamesDecoder = zodDriverValueDecoder(
  z.array(z.string()),
);

export const storedConnectorVariableValuesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.string()),
);

interface ConnectorEnvBindingSet {
  readonly access: BuiltinConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
  readonly isMcp: boolean;
}

interface StoredConnectorRequirements {
  readonly secretNames: Set<string>;
  readonly variableNames: Set<string>;
}

interface StoredConnectorMaterializationPlan {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
}

interface StoredConnectorSecretRow {
  readonly name: string;
}

export interface StoredConnectorEncryptedSecretRow extends StoredConnectorSecretRow {
  readonly encryptedValue: string;
}

export interface StoredConnectorMaterializationSnapshot {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly secretRows: readonly StoredConnectorSecretRow[];
  readonly variableValues: Record<string, string>;
}

interface ResolvedStoredConnectorMetadata {
  readonly vars: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap: Record<string, SecretConnectorMetadata>;
  readonly environment: Record<string, string>;
}

function emptyBuiltinConnectorRuntimeContext(): BuiltinConnectorRuntimeContext {
  return {
    secrets: undefined,
    vars: undefined,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: [],
    mcpConnectorSlugs: [],
    connectorSourceIdBySlug: {},
    storedEnvironment: undefined,
  };
}

export function allowedStoredConnectorRows(
  rows: readonly StoredConnectorRuntimeRowCandidate[],
  allowedConnectorSlugs: readonly ConnectorSlug[],
  snapshot: ConnectorRuntimeSelection,
  now: Date,
): readonly StoredConnectorRuntimeRow[] {
  const validRows = rows.flatMap((row) => {
    const accessResult = resolveBuiltinConnectorCredentialAccess({
      snapshot,
      stored: {
        automaticAuthType: row.automaticAuthType,
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId: row.orgId,
        storageVersion: row.storageVersion,
        userId: row.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      return [];
    }
    const { access } = accessResult;
    return [
      {
        access,
        connectorSlug: access.runtimeMethod.connectorSlug,
        connectorStateRevision: row.connectorStateRevision,
        authMethod: access.runtimeMethod.authMethodId,
        automaticAuthType: row.automaticAuthType,
        runtimeMethod: access.runtimeMethod,
        isMcp:
          getConnectorRuntimeConnector(snapshot, row.connectorSlug)
            ?.catalogConnector.mcp !== undefined,
        needsReconnect: row.needsReconnect,
        tokenExpiresAt: row.tokenExpiresAt,
      },
    ];
  });
  return validRows.filter((row) => {
    return (
      allowedConnectorSlugs.includes(row.connectorSlug) &&
      storedConnectorRuntimeCredentialStatus(row, now) === "available"
    );
  });
}

function storedConnectorRuntimeCredentialStatus(
  row: StoredConnectorRuntimeRow,
  now: Date,
): ConnectorCredentialStatus {
  return builtinConnectorRuntimeCredentialStatusWithMethod({
    method: row.runtimeMethod.method,
    automaticAuthType: row.automaticAuthType,
    storedNeedsReconnect: row.needsReconnect,
    tokenExpiresAt: row.tokenExpiresAt,
    now,
  });
}

function connectorEnvBindingSets(
  rows: readonly StoredConnectorRuntimeRow[],
): readonly ConnectorEnvBindingSet[] {
  return rows.map((row) => {
    const metadata = connectorAuthMethodRuntimeMetadata(
      row.runtimeMethod.method,
    );
    return {
      access: row.access,
      connectorSlug: row.connectorSlug,
      connectorStateRevision: row.connectorStateRevision,
      authMethod: row.authMethod,
      runtimeBindings: metadata.runtimeBindings,
      isMcp: row.isMcp,
    };
  });
}

function storedConnectorCredentialNames(args: {
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly string[] {
  return [
    ...new Set(
      args.runtimeBindings.flatMap(({ source }) => {
        if (
          (args.kind === "secret" && source.kind !== "connector-secret") ||
          (args.kind === "variable" && source.kind !== "connector-variable") ||
          (args.names !== undefined && !args.names.has(source.name))
        ) {
          return [];
        }
        return [source.name];
      }),
    ),
  ];
}

function storedConnectorRequirementsByConnector(
  bindingSets: readonly ConnectorEnvBindingSet[],
): ReadonlyMap<string, StoredConnectorRequirements> {
  return new Map(
    bindingSets.map((bindingSet) => {
      return [
        bindingSet.access.connectorId,
        {
          secretNames: new Set(
            storedConnectorCredentialNames({
              runtimeBindings: bindingSet.runtimeBindings,
              kind: "secret",
            }),
          ),
          variableNames: new Set(
            storedConnectorCredentialNames({
              runtimeBindings: bindingSet.runtimeBindings,
              kind: "variable",
            }),
          ),
        },
      ] as const;
    }),
  );
}

export function storedConnectorCredentialReadGroups(args: {
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly BuiltinConnectorCredentialReadGroup[] {
  return args.bindingSets.flatMap((bindingSet) => {
    const names = storedConnectorCredentialNames({
      runtimeBindings: bindingSet.runtimeBindings,
      kind: args.kind,
      ...(args.names === undefined ? {} : { names: args.names }),
    });
    return names.length === 0
      ? []
      : [
          {
            access: bindingSet.access,
            connectorStateRevision: bindingSet.connectorStateRevision,
            names,
          },
        ];
  });
}

async function mapWithBoundedConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (values.length === 0) {
    return [];
  }

  const indexedValues = values.map((value, index) => {
    return { index, value };
  });
  const results: ({ readonly value: TOutput } | undefined)[] = Array.from({
    length: values.length,
  });
  const workerCount = Math.min(Math.max(1, concurrency), indexedValues.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const item = indexedValues[nextIndex];
      nextIndex += 1;
      if (!item) {
        return;
      }

      const value = await onRejection(mapper(item.value, item.index), () => {
        stopped = true;
      });
      results[item.index] = { value };
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      await worker();
    }),
  );

  return indexedValues.map((item) => {
    const result = results[item.index];
    if (!result) {
      throw new Error("Missing bounded concurrency result");
    }
    return result.value;
  });
}

export async function decryptStoredConnectorSecretRows(
  rows: readonly StoredConnectorEncryptedSecretRow[],
  args: {
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<Record<string, string>> {
  if (rows.length === 0) {
    return {};
  }

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_decrypt_stored_connector_secrets",
    "nested",
    async () => {
      const decryptedRows = await mapWithBoundedConcurrency(
        rows,
        EAGER_STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY,
        async (row) => {
          return {
            name: row.name,
            value: await decryptStoredSecretValue(
              row.encryptedValue,
              args.featureSwitchContext,
            ),
          };
        },
      );
      return Object.fromEntries(
        decryptedRows.map((row) => {
          return [row.name, row.value];
        }),
      );
    },
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(rows.length),
    },
  );
}

function storedConnectorRuntimeVariables(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorVariables: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const { runtimeBindings } of bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      if (source.kind !== "connector-variable") {
        continue;
      }
      const value = connectorVariables[source.name];
      if (value !== undefined) {
        vars[envName] = value;
      }
    }
  }
  return vars;
}

function connectorSourceIdsBySlug(
  bindingSets: readonly ConnectorEnvBindingSet[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    bindingSets.map((bindingSet) => {
      return [bindingSet.connectorSlug, bindingSet.access.connectorId];
    }),
  );
}

export function resolveStoredConnectorSecrets(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorSecrets: Record<string, string>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const { runtimeBindings } of bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      if (source.kind !== "connector-secret") {
        continue;
      }
      const secretValue = connectorSecrets[source.name];
      if (secretValue !== undefined) {
        secrets[envName] = secretValue;
      }
    }
  }
  return secrets;
}

function resolveStoredConnectorMetadata(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorVariables: Record<string, string>,
  availableSecretNames: ReadonlySet<string>,
): ResolvedStoredConnectorMetadata {
  const vars: Record<string, string> = {};
  const secretConnectorMap: Record<string, string> = {};
  const secretConnectorMetadataMap: Record<string, SecretConnectorMetadata> =
    {};
  const environment: Record<string, string> = {};

  for (const { access, connectorSlug, runtimeBindings, isMcp } of bindingSets) {
    if (isMcp) {
      // Resolve MCP bindings from the matched account at the firewall boundary.
      // Global aliases could otherwise collide with another connector or a
      // caller-owned sandbox secret.
      continue;
    }
    for (const { envName, valueRef, optional, source } of runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          if (availableSecretNames.has(source.name) || !optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          }
          break;
        }
        case "connector-variable": {
          const variableValue = connectorVariables[source.name];
          if (variableValue !== undefined) {
            vars[envName] = variableValue;
          }
          if (variableValue !== undefined || !optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          }
          break;
        }
        case "platform-secret": {
          break;
        }
      }
    }

    // Firewall auth templates can only reference env aliases from envBindings;
    // store the alias that points at the connector runtime secret, not the
    // backing secret name. Refreshability is resolved later from access metadata.
    for (const { envName, source } of runtimeBindings) {
      if (source.kind === "connector-secret") {
        secretConnectorMap[envName] = connectorSlug;
        secretConnectorMetadataMap[envName] = {
          sourceType: "connector",
          sourceId: access.connectorId,
        };
      } else if (source.kind === "platform-secret") {
        secretConnectorMap[envName] = connectorSlug;
        secretConnectorMetadataMap[envName] = { sourceType: "platform-secret" };
      }
    }
  }

  return {
    vars,
    secretConnectorMap,
    secretConnectorMetadataMap,
    environment,
  };
}

export function storedConnectorContextFromSnapshot(
  snapshot: StoredConnectorMaterializationSnapshot | null,
): BuiltinConnectorRuntimeContext {
  if (!snapshot) {
    return emptyBuiltinConnectorRuntimeContext();
  }
  return {
    secrets: undefined,
    vars: compactRecord(
      storedConnectorRuntimeVariables(
        snapshot.bindingSets,
        snapshot.variableValues,
      ),
    ),
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: snapshot.allowedConnectorRows.map((row) => {
      return row.connectorSlug;
    }),
    mcpConnectorSlugs: snapshot.allowedConnectorRows.flatMap((row) => {
      return row.isMcp ? [row.connectorSlug] : [];
    }),
    connectorSourceIdBySlug: connectorSourceIdsBySlug(snapshot.bindingSets),
    storedEnvironment: undefined,
  };
}

function availableStoredConnectorSecretNames(
  rows: readonly StoredConnectorSecretRow[],
): ReadonlySet<string> {
  return new Set(
    rows.map((row) => {
      return row.name;
    }),
  );
}

export function storedConnectorExecutionContextFromSnapshot(
  snapshot: StoredConnectorMaterializationSnapshot | null,
): BuiltinConnectorRuntimeContext {
  if (!snapshot) {
    return emptyBuiltinConnectorRuntimeContext();
  }
  const resolved = resolveStoredConnectorMetadata(
    snapshot.bindingSets,
    snapshot.variableValues,
    availableStoredConnectorSecretNames(snapshot.secretRows),
  );
  return {
    ...storedConnectorContextFromSnapshot(snapshot),
    vars: compactRecord(resolved.vars),
    secretConnectorMap: compactRecord(resolved.secretConnectorMap),
    secretConnectorMetadataMap: compactRecord(
      resolved.secretConnectorMetadataMap,
    ),
    storedEnvironment: compactRecord(resolved.environment),
  };
}

export function overriddenRuntimeSecretAliases(
  records: readonly (Record<string, string> | undefined)[],
): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      aliases.add(key);
    }
  }
  return aliases;
}

function referencedEnvironmentSecretAliases(
  environment: Record<string, string> | undefined,
): ReadonlySet<string> {
  if (!environment) {
    return new Set();
  }
  return new Set(
    extractAndGroupVariables(environment).secrets.map((ref) => {
      return ref.name;
    }),
  );
}

export function eagerStoredConnectorSecretNames(args: {
  readonly snapshot: StoredConnectorMaterializationSnapshot;
  readonly storedEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly overriddenSecretAliases: ReadonlySet<string>;
}): ReadonlySet<string> {
  const names = new Set<string>();

  for (const { runtimeBindings, isMcp } of args.snapshot.bindingSets) {
    if (isMcp) {
      continue;
    }
    for (const { envName, source } of runtimeBindings) {
      const isNeededByStoredEnvironment =
        args.storedEnvironment?.[envName] !== undefined;
      const isNeededByExplicitEnvironment =
        args.referencedEnvironmentSecretAliases.has(envName);
      if (
        source.kind !== "connector-secret" ||
        (!isNeededByStoredEnvironment && !isNeededByExplicitEnvironment) ||
        args.environmentSecretPlaceholders?.[envName] !== undefined ||
        args.overriddenSecretAliases.has(envName)
      ) {
        continue;
      }
      names.add(source.name);
    }
  }
  return names;
}

export function eagerStoredConnectorSecretInputs(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
}): {
  readonly eagerStoredEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
} {
  const additionalEnvironment = args.modelProvider?.environment;
  return {
    eagerStoredEnvironment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
    }),
    referencedEnvironmentSecretAliases: referencedEnvironmentSecretAliases(
      environmentTemplates({
        content: args.content,
        additionalEnvironment,
      }),
    ),
  };
}

function buildStoredConnectorMaterializationPlan(args: {
  readonly connectorRows: readonly StoredConnectorRuntimeRowCandidate[];
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
}): StoredConnectorMaterializationPlan | null {
  const allowedConnectorRows = allowedStoredConnectorRows(
    args.connectorRows,
    args.allowedConnectorSlugs,
    args.connectorCatalogSnapshot,
    nowDate(),
  );
  if (allowedConnectorRows.length === 0) {
    return null;
  }

  const bindingSets = connectorEnvBindingSets(allowedConnectorRows);
  return {
    allowedConnectorRows,
    bindingSets,
  };
}

export function materializeStoredConnectorSnapshotRows(
  args: {
    readonly rows: readonly StoredConnectorMaterializationSnapshotRow[];
    readonly allowedConnectorSlugs: readonly ConnectorSlug[];
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): StoredConnectorMaterializationSnapshot | null {
  const startedAt = now();
  const result = safeSync(() => {
    const plan = buildStoredConnectorMaterializationPlan({
      connectorRows: args.rows,
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    });
    if (!plan) {
      return null;
    }

    const requirementsByConnector = storedConnectorRequirementsByConnector(
      plan.bindingSets,
    );
    const secretRows: StoredConnectorSecretRow[] = [];
    const variableValues: Record<string, string> = {};
    for (const row of args.rows) {
      const requirements = requirementsByConnector.get(row.connectorId);
      if (!requirements) {
        continue;
      }
      for (const name of row.secretNames) {
        if (requirements.secretNames.has(name)) {
          secretRows.push({ name });
        }
      }
      for (const [name, value] of Object.entries(row.variableValues)) {
        if (requirements.variableNames.has(name)) {
          variableValues[name] = value;
        }
      }
    }

    return {
      allowedConnectorRows: plan.allowedConnectorRows,
      bindingSets: plan.bindingSets,
      secretRows,
      variableValues,
    } satisfies StoredConnectorMaterializationSnapshot;
  });
  if ("error" in result) {
    timing?.recordElapsed(
      "api_dispatch_prepare_context_materialize_stored_connector_snapshot",
      "nested",
      startedAt,
      now(),
      {
        ...args.timingDimensions,
        stored_connector_candidate_count_bucket: countBucket(args.rows.length),
      },
    );
    throw result.error;
  }
  const snapshot = result.ok;
  timing?.recordElapsed(
    "api_dispatch_prepare_context_materialize_stored_connector_snapshot",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_candidate_count_bucket: countBucket(args.rows.length),
      stored_connector_count_bucket: countBucket(
        snapshot?.allowedConnectorRows.length ?? 0,
      ),
      stored_connector_secret_count_bucket: countBucket(
        snapshot?.secretRows.length ?? 0,
      ),
    },
  );
  return snapshot;
}

interface StoredConnectorMaterializationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorIdCandidatesBySlug:
    | ReadonlyMap<ConnectorSlug, readonly string[]>
    | undefined;
  readonly scopeSource: ConnectorScopeSource;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
}

function customConnectorRequiredMemberCredentialsAreComplete(
  row: CustomConnectorRuntimeDataRows[number],
): boolean {
  return (
    customConnectorMissingRequiredFieldKeys({
      fields: row.connector.fields,
      markers: row.values,
    }).length === 0
  );
}

export function customConnectorNewRunRowIsAdmissible(
  row: CustomConnectorRuntimeDataRows[number],
): boolean {
  return (
    row.credentialAccess.kind === "current" &&
    row.credentialAccess.runtimeAvailable &&
    (row.connector.authMode !== "manual" ||
      customConnectorManualAuthReferencesMemberField(row.connector)) &&
    customConnectorRequiredMemberCredentialsAreComplete(row)
  );
}

export async function buildNewRunCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  const orderedRows = orderedCustomConnectorRuntimeRows(args.rows);
  // Active targets call the shared builder directly so credential loss does
  // not remove their pinned firewall. Only new runs apply this admission gate.
  const context = await buildCustomConnectorRuntimeContext({
    ...args,
    rows: orderedRows.filter(customConnectorNewRunRowIsAdmissible),
  });
  return {
    ...context,
    skills: orderedRows.flatMap((row) => {
      const skill = customConnectorRuntimeSkill(row);
      return skill ? [skill] : [];
    }),
  };
}

async function loadRequiredFirewallPermissionIndex(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
}): Promise<ConnectorServerFirewallPermissionIndex> {
  const index = await args.snapshot.serverFirewalls.loadPermissionIndex(
    args.connectorSlug,
  );
  if (!index) {
    throw new Error(
      `Missing connector server firewall permission metadata: ${args.connectorSlug}`,
    );
  }
  return index;
}

function getRequiredFirewallExecutionMetadata(
  snapshot: ConnectorRuntimeSelection,
  connectorSlug: string,
): ConnectorServerFirewallExecutionMetadata {
  const metadata = snapshot.serverFirewalls.getExecutionMetadata(connectorSlug);
  if (!metadata) {
    throw new Error(
      `Missing connector server firewall execution metadata: ${connectorSlug}`,
    );
  }
  return metadata;
}

const BASE_URL_VAR_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const BASE_URL_VALIDATION_SECRET_TEMPLATE = [
  "$",
  "{{ secrets.__OKOU_FIREWALL_BASE_URL_VALIDATION }}",
].join("");

function builtinFirewallEntry(
  firewall: ExpandedFirewallConfig,
  vars: Record<string, string> | undefined,
): ExecutionFirewallEntry {
  const names = new Set<string>();
  for (const api of firewall.apis) {
    for (const match of api.base.matchAll(BASE_URL_VAR_PATTERN)) {
      names.add(match[1]!);
    }
  }
  if (names.size === 0) {
    return { kind: "builtin", name: firewall.name };
  }

  const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
    [runtimeFirewall(firewall)],
    vars,
  );
  return { kind: "builtin", name: firewall.name, baseUrlVars };
}

function baseUrlValidationAuth(
  credentialed: boolean,
): Firewall["apis"][number]["auth"] {
  return credentialed
    ? {
        headers: {
          Authorization: `Bearer ${BASE_URL_VALIDATION_SECRET_TEMPLATE}`,
        },
      }
    : {};
}

function builtinFirewallEntryForMetadata(
  metadata: ConnectorServerFirewallExecutionMetadata,
  vars: Record<string, string> | undefined,
  sourceId: string,
): ExecutionFirewallEntry {
  if (metadata.baseUrlVarNames.length === 0) {
    return {
      kind: "builtin",
      name: metadata.connectorSlug,
      sourceId,
    };
  }

  const validationFirewall: Firewall = {
    name: metadata.connectorSlug,
    apis: metadata.baseUrlTemplates.map((template) => {
      return {
        base: template.base,
        ...(template.hostPolicy !== undefined
          ? { hostPolicy: template.hostPolicy }
          : {}),
        auth: baseUrlValidationAuth(template.credentialed),
        permissions: [],
      };
    }),
  };
  const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
    [validationFirewall],
    vars,
  );
  return {
    kind: "builtin",
    name: metadata.connectorSlug,
    baseUrlVars,
    sourceId,
  };
}

function inlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
): ExecutionFirewallEntry {
  return { kind: "inline", firewall: runtimeFirewall(firewall) };
}

function customConnectorInlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
  customConnectorIdByFirewallName: Readonly<Record<string, string>>,
  customConnectorSourceIdByFirewallName: Readonly<Record<string, string>>,
): ExecutionFirewallEntry {
  const customConnectorId = customConnectorIdByFirewallName[firewall.name];
  if (!customConnectorId) {
    throw new Error("Missing Custom connector identity for inline firewall");
  }
  return {
    kind: "inline",
    customConnectorId,
    ...(customConnectorSourceIdByFirewallName[firewall.name] === undefined
      ? {}
      : { sourceId: customConnectorSourceIdByFirewallName[firewall.name] }),
    firewall: customConnectorRuntimeFirewall(firewall),
  };
}

function applyConnectorPolicies(
  connectorFirewalls: readonly ExpandedFirewallConfig[],
  policies: FirewallPolicies | undefined,
  entryForFirewall: (
    firewall: ExpandedFirewallConfig,
  ) => ExecutionFirewallEntry,
  defaultPolicyForFirewall: (
    firewall: ExpandedFirewallConfig,
    permissionNames: readonly string[],
  ) => FirewallPolicy,
): Pick<PermissionManifest, "firewalls" | "networkPolicies"> {
  const firewalls: ExecutionFirewalls = [];
  const networkPolicies: NetworkPolicies = {};

  for (const firewall of connectorFirewalls) {
    const policy = policies?.[firewall.name];
    const permissionNames = collectPermissionNames(firewall.apis);
    const defaultPolicy = defaultPolicyForFirewall(firewall, permissionNames);
    firewalls.push(entryForFirewall(firewall));

    networkPolicies[firewall.name] = resolveConnectorNetworkPolicy({
      permissionNames,
      defaultPolicy,
      policy,
    });
  }

  return { firewalls, networkPolicies };
}

function modelProviderPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment | null,
  vars: Record<string, string> | undefined,
): PermissionManifest | undefined {
  if (!modelProvider) {
    return undefined;
  }

  const firewall =
    modelProvider.firewall ??
    getModelProviderFirewall(modelProvider.concreteType ?? modelProvider.type);
  if (!firewall) {
    return undefined;
  }

  const permissionNames = collectPermissionNames(firewall.apis);
  const denySet = new Set(firewall.defaultPolicies?.deny ?? []);
  const askSet = new Set(firewall.defaultPolicies?.ask ?? []);
  return {
    firewalls: [
      // A name-only entry would lose the endpoint selected for this run.
      modelProvider.firewall !== undefined
        ? inlineFirewallEntry(firewall)
        : builtinFirewallEntry(firewall, vars),
    ],
    environmentSecretPlaceholders: firewallSecretPlaceholdersFromFirewalls([
      firewall,
    ]),
    billableFirewalls: [],
    networkPolicies: {
      [firewall.name]: {
        allow: permissionNames.filter((name) => {
          return !denySet.has(name) && !askSet.has(name);
        }),
        deny: [...denySet],
        ask: [...askSet],
        unknownPolicy: firewall.defaultPolicies?.unknownPolicy ?? "allow",
      },
    },
  };
}

interface BuiltinConnectorManifestSource {
  readonly metadata: ConnectorServerFirewallExecutionMetadata;
  readonly permissionIndex: ConnectorServerFirewallPermissionIndex;
  readonly isMcp: boolean;
}

function buildConnectorPermissionBaseline(
  snapshot: ConnectorRuntimeSelection,
  sources: readonly BuiltinConnectorManifestSource[],
): StoredConnectorPermissionBaseline {
  const validationAuthority = currentConnectorCatalogValidatorIdentity();
  return {
    version: 1,
    catalogIdentity: snapshot.catalogIdentity,
    validationAuthority: {
      backendVersion: validationAuthority.validatorVersion,
      buildCommitSha: validationAuthority.buildCommitSha,
    },
    connectors: Object.fromEntries(
      sources.map((source) => {
        const defaultPolicy = source.permissionIndex.defaultPolicy;
        const permissionOverrides = defaultPolicy.permissionOverrides;
        return [
          source.metadata.connectorSlug,
          {
            permissionNames: [...source.permissionIndex.permissionNames],
            defaultPolicy: {
              permissionDefault: defaultPolicy.permissionDefault,
              ...(permissionOverrides
                ? {
                    permissionOverrides: {
                      ...(permissionOverrides.allow
                        ? { allow: [...permissionOverrides.allow] }
                        : {}),
                      ...(permissionOverrides.deny
                        ? { deny: [...permissionOverrides.deny] }
                        : {}),
                      ...(permissionOverrides.ask
                        ? { ask: [...permissionOverrides.ask] }
                        : {}),
                    },
                  }
                : {}),
              unknownPolicy: defaultPolicy.unknownPolicy,
            },
          },
        ];
      }),
    ),
  };
}

function applyBuiltinConnectorMetadataPolicies(
  sources: readonly BuiltinConnectorManifestSource[],
  policies: FirewallPolicies | undefined,
  vars: Record<string, string> | undefined,
  connectorSourceIdBySlug: Readonly<Record<string, string>>,
): PermissionManifest {
  const firewalls: ExecutionFirewalls = [];
  const networkPolicies: NetworkPolicies = {};
  const environmentSecretPlaceholders: Record<string, string> = {};
  const billableFirewalls: string[] = [];

  for (const source of sources) {
    const name = source.metadata.connectorSlug;
    const permissionNames = [...source.permissionIndex.permissionNames];
    const defaultPolicy = defaultFirewallPolicyForPermissionIndex(
      source.permissionIndex,
    );
    const policy = policies?.[name];
    const sourceId = connectorSourceIdBySlug[name];
    if (sourceId === undefined) {
      throw new Error("Missing built-in connector source identity");
    }
    firewalls.push(
      builtinFirewallEntryForMetadata(source.metadata, vars, sourceId),
    );
    if (!source.isMcp) {
      Object.assign(
        environmentSecretPlaceholders,
        source.metadata.placeholderValues,
      );
    }
    if (source.metadata.billable) {
      billableFirewalls.push(name);
    }

    networkPolicies[name] = resolveConnectorNetworkPolicy({
      permissionNames,
      defaultPolicy,
      policy,
    });
  }

  return {
    firewalls,
    networkPolicies,
    environmentSecretPlaceholders: compactRecord(environmentSecretPlaceholders),
    billableFirewalls,
  };
}

function builtinRuntimeTargetRegistration(
  firewall: ExecutionFirewallEntry,
): BuiltinRuntimeTargetRegistration {
  if (firewall.kind !== "builtin") {
    throw new Error("Builtin connector manifest contains an inline firewall");
  }
  return {
    kind: "builtin",
    connectorSlug: connectorSlugSchema.parse(firewall.name),
    ...(firewall.baseUrlVars === undefined
      ? {}
      : { baseUrlVars: { ...firewall.baseUrlVars } }),
    ...(firewall.sourceId === undefined ? {} : { sourceId: firewall.sourceId }),
  };
}

function mergePermissionManifests(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly builtinSources: readonly BuiltinConnectorManifestSource[];
  readonly connectorManifest: PermissionManifest;
  readonly customConnectorManifest: Pick<
    PermissionManifest,
    "firewalls" | "networkPolicies"
  >;
  readonly providerManifest: PermissionManifest | undefined;
  readonly customConnectorFirewalls: readonly ExpandedFirewallConfig[];
}): PermissionManifest | undefined {
  const builtinRuntimeTargets = args.connectorManifest.firewalls.map(
    builtinRuntimeTargetRegistration,
  );
  const firewalls = [
    ...(args.providerManifest?.firewalls ?? []),
    ...args.connectorManifest.firewalls,
    ...args.customConnectorManifest.firewalls,
  ];

  if (firewalls.length === 0) {
    return undefined;
  }

  const connectorPermissionBaseline = (() => {
    if (args.builtinSources.length === 0) {
      return undefined;
    }
    if (args.connectorCatalogSelection.kind === "empty") {
      throw new Error("Builtin connector sources require a catalog selection");
    }
    return buildConnectorPermissionBaseline(
      args.connectorCatalogSelection.selection,
      args.builtinSources,
    );
  })();

  return {
    firewalls,
    builtinRuntimeTargets,
    ...(connectorPermissionBaseline ? { connectorPermissionBaseline } : {}),
    environmentSecretPlaceholders: mergeRecords(
      args.providerManifest?.environmentSecretPlaceholders,
      args.connectorManifest.environmentSecretPlaceholders,
      firewallSecretPlaceholdersFromFirewalls(args.customConnectorFirewalls),
    ),
    billableFirewalls: [
      ...(args.providerManifest?.billableFirewalls ?? []),
      ...args.connectorManifest.billableFirewalls,
    ],
    networkPolicies: {
      ...args.providerManifest?.networkPolicies,
      ...args.connectorManifest.networkPolicies,
      ...args.customConnectorManifest.networkPolicies,
    },
  };
}

interface BuildPermissionManifestArgs {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly connectorVars?: Record<string, string>;
  readonly connectorSlugs?: readonly ConnectorSlug[];
  readonly connectorSourceIdBySlug?: Readonly<Record<string, string>>;
  readonly customConnectorFirewalls?: readonly ExpandedFirewallConfig[];
  readonly customConnectorPermissionPolicies?: FirewallPolicies;
  readonly customConnectorIdByFirewallName?: Readonly<Record<string, string>>;
  readonly customConnectorSourceIdByFirewallName?: Readonly<
    Record<string, string>
  >;
  readonly timing?: ApiDispatchTimingCollector;
}

async function buildPermissionManifest(
  args: BuildPermissionManifestArgs,
): Promise<PermissionManifest | undefined> {
  const connectorBaseUrlVars = mergeRecords(args.vars, args.connectorVars);
  const customConnectorFirewalls = args.customConnectorFirewalls ?? [];

  const builtinSources = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_load_builtin_permission_indexes",
    "nested",
    async () => {
      if (args.connectorCatalogSelection.kind === "empty") {
        return [];
      }
      const snapshot = args.connectorCatalogSelection.selection;
      const builtinConnectorSlugs = (
        args.connectorSlugs ?? Object.keys(args.permissionPolicies ?? {})
      ).filter((connectorSlug) => {
        return snapshot.serverFirewalls.has(connectorSlug);
      });
      return await Promise.all(
        builtinConnectorSlugs.map(async (connectorSlug) => {
          const metadata = getRequiredFirewallExecutionMetadata(
            snapshot,
            connectorSlug,
          );
          const permissionIndex = await loadRequiredFirewallPermissionIndex({
            snapshot,
            connectorSlug,
          });
          return {
            metadata,
            permissionIndex,
            isMcp: snapshot.serverFirewalls.isMcp(connectorSlug),
          };
        }),
      );
    },
  );

  const connectorManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_builtin_permission_policies",
    "nested",
    () => {
      return Promise.resolve(
        applyBuiltinConnectorMetadataPolicies(
          builtinSources,
          args.permissionPolicies,
          connectorBaseUrlVars,
          args.connectorSourceIdBySlug ?? {},
        ),
      );
    },
  );
  const customConnectorManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_custom_permission_policies",
    "nested",
    () => {
      return Promise.resolve(
        applyConnectorPolicies(
          customConnectorFirewalls,
          mergeRecords(
            args.permissionPolicies,
            args.customConnectorPermissionPolicies,
          ),
          (firewall) => {
            return customConnectorInlineFirewallEntry(
              firewall,
              args.customConnectorIdByFirewallName ?? {},
              args.customConnectorSourceIdByFirewallName ?? {},
            );
          },
          (_firewall, permissionNames) => {
            return allAllowPolicyForPermissions(permissionNames);
          },
        ),
      );
    },
  );
  const providerManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_model_provider_permission_policy",
    "nested",
    () => {
      return Promise.resolve(
        modelProviderPermissionManifest(args.modelProvider, args.vars),
      );
    },
  );

  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_merge_permission_manifest",
    "nested",
    () => {
      return Promise.resolve(
        mergePermissionManifests({
          connectorCatalogSelection: args.connectorCatalogSelection,
          builtinSources,
          connectorManifest,
          customConnectorManifest,
          providerManifest,
          customConnectorFirewalls,
        }),
      );
    },
  );
}

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

export interface RunAgentObservation {
  readonly agentId: string;
  readonly agentOrgId: string;
  readonly agentOwner: string;
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

function resolveAgentObservation(
  row: RunAgentObservation | undefined,
  options: ProductResolutionOptions,
): ResolvedAgentExecution | CreateRunErrorResult {
  if (!row) {
    return notFound("Agent not found");
  }
  return {
    agentId: row.agentId,
    ownerUserId: row.agentOwner,
    orgId: row.agentOrgId,
    content: options.executionPlan.content,
    artifacts: [],
  };
}

interface ResumeSessionSnapshot {
  readonly runId: string;
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistory: string | null;
  readonly cliAgentSessionHistoryHash: string | null;
  readonly sessionHistoryBlobEncoding: string | null;
}

function resumeSessionFromSnapshot(
  snapshot: ResumeSessionSnapshot,
): StoredExecutionContext["resumeSession"] | undefined {
  const hash = snapshot.cliAgentSessionHistoryHash;
  let encoding: CompressedSessionHistoryBlobEncoding | undefined;
  if (snapshot.sessionHistoryBlobEncoding !== null) {
    const parsedEncoding = normalizeSessionHistoryBlobEncoding(
      snapshot.sessionHistoryBlobEncoding,
    );
    if (isCompressedSessionHistoryBlobEncoding(parsedEncoding)) {
      encoding = parsedEncoding;
    }
  }
  if (hash) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      historyGenerationRunId: snapshot.runId,
      historyRef: {
        kind: "blob",
        hash,
        ...(encoding ? { encoding } : {}),
      },
    };
  }
  if (snapshot.cliAgentSessionHistory) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      sessionHistory: snapshot.cliAgentSessionHistory,
    };
  }
  return undefined;
}

function resolvedSessionStorage(session: {
  readonly id: string;
  readonly storageMounts: readonly PersistedStorageMount[] | null;
}): Pick<ResolvedAgentExecution, "artifacts" | "persistedStorageMounts"> {
  if (session.storageMounts === null) {
    throw new Error(
      `Agent session "${session.id}" is missing canonical Storage mounts`,
    );
  }
  return {
    artifacts: projectLegacyWritebackArtifacts(session.storageMounts),
    persistedStorageMounts: session.storageMounts,
  };
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

async function resolveSessionExecution(
  snapshot: ChatThreadExecutionSnapshot | undefined,
  options: ProductResolutionOptions,
): Promise<ResolvedAgentExecution | CreateRunErrorResult> {
  if (!snapshot) {
    return notFound("Agent session not found");
  }
  if (!snapshot.agent) {
    return notFound("Agent not found");
  }

  const conversation = snapshot.conversation;
  const resumeSession = conversation
    ? await measureApiDispatchTiming(
        options.timing,
        "api_dispatch_resolve_agent_execution_resolve_session_history",
        "nested",
        (): StoredExecutionContext["resumeSession"] | undefined => {
          return resumeSessionFromSnapshot({
            ...conversation,
            sessionHistoryBlobEncoding: snapshot.historyBlob?.encoding ?? null,
          });
        },
      )
    : undefined;

  return {
    agentId: snapshot.agent.id,
    ownerUserId: snapshot.agent.owner,
    orgId: snapshot.agent.orgId,
    content: options.executionPlan.content,
    ...resolvedSessionStorage(snapshot.session),
    previousRunStorageMounts: snapshot.previousRun?.storageMounts ?? undefined,
    vars:
      (snapshot.previousRun?.vars as Record<string, string> | null) ??
      undefined,
    agentSessionId: snapshot.session.id,
    continuedFromAgentSessionId: snapshot.session.id,
    resumeSession,
    resumeSessionIdentity: {
      selectedModel: snapshot.previousRun?.selectedModel ?? null,
      cliAgentType: conversation?.cliAgentType ?? null,
    },
  };
}

function requireResolvedAgentIdMatch(
  resolved: ResolvedAgentExecution | CreateRunErrorResult,
  agentId: string | undefined,
): ResolvedAgentExecution | CreateRunErrorResult {
  if (
    !isRouteError(resolved) &&
    agentId !== undefined &&
    resolved.agentId !== agentId
  ) {
    return badRequestMessage("agentId does not match sessionId");
  }
  return resolved;
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

  const productAgentExecutionPlan = options.productAgentExecutionPlan;
  if (productAgentExecutionPlan === undefined) {
    throw new Error(
      "Product Agent execution plan is required for canonical resolution",
    );
  }
  if (productAgentExecutionPlan.identity === "no-agent") {
    return {
      agentId: null,
      ownerUserId: userId,
      orgId,
      content: productAgentExecutionPlan.content,
      artifacts: [],
    };
  }
  if (body.sessionId) {
    const resolved = await measureApiDispatchTiming(
      options.timing,
      "api_dispatch_resolve_agent_execution_by_session_id",
      "nested",
      async () => {
        return await resolveSessionExecution(options.sessionSnapshot, {
          executionPlan: productAgentExecutionPlan,
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
  if (!body.agentId) {
    return badRequestMessage("Missing agentId or sessionId");
  }
  const agentId = body.agentId;
  const preloadedAgent = options.preloadedAgentExecutionObservation;
  if (
    preloadedAgent &&
    preloadedAgent.requestUserId === userId &&
    preloadedAgent.requestOrgId === orgId &&
    preloadedAgent.agentId === agentId &&
    preloadedAgent.agentOrgId === orgId
  ) {
    return {
      agentId,
      ownerUserId: preloadedAgent.ownerUserId,
      orgId: preloadedAgent.agentOrgId,
      content: productAgentExecutionPlan.content,
      artifacts: [],
    };
  }
  return await measureApiDispatchTiming(
    options.timing,
    "api_dispatch_resolve_agent_execution_by_agent_id",
    "nested",
    () => {
      return resolveAgentObservation(options.agentObservation, {
        executionPlan: productAgentExecutionPlan,
        timing: options.timing,
      });
    },
  );
}

export function enforceCaptureNetworkBodiesGate(
  orgId: string,
  captureNetworkBodies: boolean | undefined,
): CreateRunErrorResult | null {
  if (!captureNetworkBodies || env("ENV") !== "production") {
    return null;
  }

  if (!isStaffOrg(orgId)) {
    return forbidden("captureNetworkBodies is restricted to internal accounts");
  }
  return null;
}

export function validateCompose(
  content: agentRunCreateAgentExecutionConfig,
  vars: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
  options?: {
    readonly validateEnvironmentReferences?: boolean;
    readonly environmentSecretPlaceholders?: Readonly<Record<string, string>>;
    readonly additionalEnvironment?: Record<string, string>;
    readonly storedConnectorEnvironment?: Record<string, string>;
    readonly connectorVars?: Record<string, string>;
  },
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  const framework = resolveFramework(content);
  if (!framework) {
    return badRequestMessage(
      "Agent must have a supported framework configured",
    );
  }

  if (options?.validateEnvironmentReferences !== false) {
    const missing = missingEnvironmentReferences({
      content,
      vars,
      secrets,
      environmentSecretPlaceholders: options?.environmentSecretPlaceholders,
      additionalEnvironment: options?.additionalEnvironment,
      storedConnectorEnvironment: options?.storedConnectorEnvironment,
      connectorVars: options?.connectorVars,
    });
    if (missing.length > 0) {
      return badRequestMessage(
        `Missing required values: ${missing.join(", ")}`,
      );
    }
  }

  return { framework };
}

export function initialRunBody(args: CreateAgentRunArgs): CreateRunBody {
  return args.includeOkouTokenSecret
    ? withPendingOkouTokenSecret(args.body)
    : args.body;
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

function prepareLaunchRunIdentity(args: {
  readonly resolved: ResolvedRunExecution;
}): LaunchRunIdentity {
  return {
    runId: randomUUID(),
    sessionId: args.resolved.agentSessionId ?? randomUUID(),
    shouldCreateSession: !args.resolved.agentSessionId,
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

interface LaunchRunRowsArgs {
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

function launchSessionValues(args: LaunchRunRowsArgs): LaunchSessionValues {
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

function launchRunValues(
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

function launchRunMetadataValues(args: LaunchRunRowsArgs): RunMetadataValues {
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

function storedConnectorRuntimeTargets(args: {
  readonly permissionManifest: PermissionManifest | undefined;
  readonly customTargets: readonly ConnectorRuntimeTargetRegistration[];
}): ConnectorRuntimeTargetRegistration[] {
  return [
    ...(args.permissionManifest?.builtinRuntimeTargets ?? []),
    ...args.customTargets,
  ];
}

function buildStoredPlatformEnvironment(args: {
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly canonicalOkouRuntime: boolean;
}): Record<string, string> {
  const platformEnvironment = {
    ...args.platformEnvironment,
    CLI_PKG_URL: env("CLI_PKG_URL"),
  };
  return args.canonicalOkouRuntime
    ? (withoutLegacyAgentRunEnvironmentEntries(platformEnvironment) ?? {})
    : platformEnvironment;
}

function buildStoredUntrustedEnvironment(args: {
  readonly expandedEnvironment: Record<string, string> | null;
  readonly canonicalOkouRuntime: boolean;
}): Record<string, string> | null {
  if (!args.canonicalOkouRuntime) {
    return args.expandedEnvironment;
  }
  return (
    withoutLegacyAgentRunEnvironmentEntries(
      args.expandedEnvironment ?? undefined,
    ) ?? null
  );
}

function assertNativeCredentialOverrides(
  provider: ResolvedModelProviderEnvironment | null,
  bodySecrets: Record<string, string> | undefined,
): void {
  const native = provider?.piModelConfig;
  if (
    native &&
    "schemaVersion" in native &&
    native.schemaVersion === 4 &&
    native.credentialBindings.some((binding) => {
      return bodySecrets?.[binding.secretName] !== undefined;
    })
  ) {
    throw new PiNativeConfigurationError(
      "Native Pi credentials cannot be overridden after route capture",
    );
  }
}

function capturedPiExecutionRoute(
  provider: ResolvedModelProviderEnvironment | null,
): PiExecutionRoute | undefined {
  return provider?.piModelConfig
    ? normalizePiExecutionRoute(provider.piModelConfig)
    : undefined;
}

function nativeCredentialEnvironment(
  route: PiExecutionRoute | undefined,
): Record<string, string> {
  return route &&
    (route.dialect === "anthropic-messages" ||
      route.dialect === "bedrock-converse-stream")
    ? Object.fromEntries(
        route.credentialBindings.map((binding) => {
          return [binding.environment, PI_NATIVE_CREDENTIAL_PLACEHOLDER];
        }),
      )
    : {};
}

function assertNativeEnvironment(
  provider: ResolvedModelProviderEnvironment | null,
  effectiveEnvironment: Record<string, string>,
): void {
  const nativeConfig = provider?.piModelConfig;
  if (
    nativeConfig &&
    "schemaVersion" in nativeConfig &&
    nativeConfig.schemaVersion === 4
  ) {
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_PROFILE",
      "AWS_DEFAULT_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY",
      "OKOU_MODEL_PROVIDER_API_KEY",
    ]) {
      if (effectiveEnvironment[key]) {
        throw new PiNativeConfigurationError(
          "Native Pi context cannot carry ambient provider authentication",
        );
      }
    }
  }
}

function piLangfuseExecutionEnvironment(args: {
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly piSandbox: PiModelConfig | undefined;
  readonly userId: string;
}): {
  readonly platformEnvironment?: Readonly<Record<string, string>>;
} {
  if (!args.includeOkouTokenSecret || args.piSandbox === undefined) {
    return {};
  }
  const config = resolvePiLangfuseDebugConfig(args.featureSwitchContext);
  if (!config) {
    return {};
  }
  return {
    platformEnvironment: piLangfuseDebugPlatformEnvironment({
      userId: args.userId,
    }),
  };
}

export function buildStoredExecutionContextDraft(
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly chatThreadId: string | undefined;
    readonly resolved: ResolvedRunExecution;
    readonly body: CreateRunBody;
    readonly framework: SupportedFramework;
    readonly piSandbox: PiModelConfig | undefined;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly connectorContext: BuiltinConnectorRuntimeContext;
    readonly customConnectorContext: CustomConnectorRuntimeContext;
    readonly permissionManifest: PermissionManifest | undefined;
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly apiStartTime: number;
    readonly additionalVolumes:
      | readonly AgentRunCreateAdditionalVolume[]
      | undefined;
    readonly platformEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly includeOkouTokenSecret: boolean | undefined;
  },
  encryptedSecrets: BuiltStoredExecutionContextDraft["context"]["encryptedSecrets"],
): BuiltStoredExecutionContextDraft {
  const permissions = args.permissionManifest;
  const langfuseEnvironment = piLangfuseExecutionEnvironment(args);
  assertNativeCredentialOverrides(args.modelProvider, args.body.secrets);
  const executionSecrets = buildStoredExecutionSecrets({
    connectorContext: args.connectorContext,
    modelProvider: args.modelProvider,
    bodySecrets: args.body.secrets,
    customConnectorContext: args.customConnectorContext,
  });
  const secretNames = executionSecrets.secrets
    ? Object.keys(executionSecrets.secrets)
    : [];
  const secretValues = executionSecrets.secrets
    ? Object.values(executionSecrets.secrets)
    : [];
  const connectorRuntimeTargets = storedConnectorRuntimeTargets({
    permissionManifest: permissions,
    customTargets: args.customConnectorContext.targets,
  });
  // Newly constructed API context: remove the reserved namespace from the
  // fully expanded untrusted/content environment before the trusted overlay.
  const expandedEnvironment = withoutOkouNamespaceEntries(
    expandEnvironment({
      content: args.resolved.content,
      vars: args.body.vars,
      secrets: executionSecrets.secrets,
      additionalEnvironment: args.modelProvider?.environment,
      environmentSecretPlaceholders: permissions?.environmentSecretPlaceholders,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    }),
  );
  const nativeEnvironment = nativeCredentialEnvironment(
    capturedPiExecutionRoute(args.modelProvider),
  );
  const platformEnvironment = buildStoredPlatformEnvironment({
    platformEnvironment: {
      ...args.platformEnvironment,
      ...nativeEnvironment,
      ...langfuseEnvironment.platformEnvironment,
    },
    canonicalOkouRuntime: args.includeOkouTokenSecret === true,
  });
  const untrustedEnvironment = buildStoredUntrustedEnvironment({
    expandedEnvironment,
    canonicalOkouRuntime: args.includeOkouTokenSecret === true,
  });
  const environment =
    Object.keys(nativeEnvironment).length > 0
      ? { ...untrustedEnvironment, ...nativeEnvironment }
      : untrustedEnvironment;
  const effectiveEnvironment = {
    ...environment,
    ...platformEnvironment,
  };
  assertNativeEnvironment(args.modelProvider, effectiveEnvironment);
  const environmentKeyByValue = new Map<string, string>();
  for (const [key, value] of Object.entries(effectiveEnvironment)) {
    if (!environmentKeyByValue.has(value)) {
      environmentKeyByValue.set(value, key);
    }
  }
  const secretValueEnvironmentKeys = executionSecrets.secrets
    ? secretValues.flatMap((value) => {
        const key = environmentKeyByValue.get(value);
        return key === undefined ? [] : [key];
      })
    : null;
  return {
    context: {
      environment,
      platformEnvironment,
      secretValueEnvironmentKeys,
      vars: args.connectorContext.vars ?? null,
      resumeSession: args.resolved.resumeSession ?? null,
      encryptedSecrets,
      secretConnectorMap: executionSecrets.secretConnectorMap,
      secretConnectorMetadataMap: executionSecrets.secretConnectorMetadataMap,
      cliAgentType: args.framework,
      realAgentInPreview: args.body.realAgentInPreview || undefined,
      captureNetworkBodies: args.body.captureNetworkBodies || undefined,
      apiStartTime: args.apiStartTime,
      userTimezone: args.userTimezone,
      firewalls: permissions?.firewalls,
      networkPolicies: permissions?.networkPolicies,
      connectorRuntimeTargets,
      connectorPermissionBaseline: permissions?.connectorPermissionBaseline,
      disallowedTools: args.body.disallowedTools,
      tools: args.body.tools,
      settings: args.body.settings,
      featureFlags: getAllFeatureStates(args.featureSwitchContext),
      billableFirewalls: [...args.billableFirewalls],
      modelUsageProvider: args.modelUsageProvider,
      codexRuntimeConfig: args.modelProvider?.codexRuntimeConfig ?? null,
    },
    secretNames,
    secretValues,
  };
}

function resolveBuiltStoredExecutionContext(
  preparedStorage: PreparedAgentRunStorage,
  builtContextDraft: BuiltStoredExecutionContextDraft,
): BuiltStoredExecutionContext {
  return {
    ...builtContextDraft,
    persistedStorageMounts: [...preparedStorage.persistedStorageMounts],
    runContextStorage: preparedStorage.runContextStorage,
    context: {
      ...builtContextDraft.context,
      storageMounts: [...preparedStorage.storageMounts],
    },
  };
}

function sanitizeEnvironment(
  environment: Record<string, string> | null | undefined,
  secretValues: readonly string[],
): Record<string, string> {
  const secrets = new Set(secretValues);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    sanitized[key] = secrets.has(value) ? "***" : value;
  }
  return sanitized;
}

function buildRunContextSnapshot(args: {
  readonly runId: string;
  readonly userId: string;
  readonly body: CreateRunBody;
  readonly builtContext: BuiltStoredExecutionContext;
}): RunContextAxiomSnapshot {
  const storedContext = args.builtContext.context;
  const sanitizedEnvironment = sanitizeEnvironment(
    {
      ...storedContext.environment,
      ...storedContext.platformEnvironment,
    },
    args.builtContext.secretValues,
  );
  const cliAgentSessionId =
    storedContext.piSessionId ?? storedContext.resumeSession?.sessionId ?? null;
  const snapshot: RunContextAxiomSnapshot = {
    _time: nowDate().toISOString(),
    runId: args.runId,
    userId: args.userId,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    sessionId: cliAgentSessionId,
    cliAgentType: storedContext.cliAgentType,
    ...piModelConfigObservation(
      storedContext.cliAgentType,
      storedContext.piModelConfig,
    ),
    secretNames: [...args.builtContext.secretNames],
    environmentEntries: environmentRecordToEntries(sanitizedEnvironment),
    firewalls: executionFirewallsToAxiomEntries(storedContext.firewalls),
    networkPolicyEntries: networkPoliciesRecordToEntries(
      storedContext.networkPolicies,
    ),
    volumes: args.builtContext.runContextStorage.volumes,
    artifact: args.builtContext.runContextStorage.artifact,
    featureFlagEntries: featureFlagsRecordToEntries(storedContext.featureFlags),
  };
  return snapshot;
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

export function buildStoredExecutionSecrets(args: {
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly bodySecrets: Record<string, string> | undefined;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}): StoredExecutionSecrets {
  const filteredConnectorMap = filterSecretConnectorMap({
    secretConnectorMap: args.connectorContext.secretConnectorMap,
    overriddenSecrets: [
      args.modelProvider?.secrets,
      args.modelProvider?.secretConnectorMap,
      args.bodySecrets,
      args.customConnectorContext.reservedSecretAliases,
    ],
  });
  const filteredModelProviderMap = filterSecretConnectorMap({
    secretConnectorMap: args.modelProvider?.secretConnectorMap,
    overriddenSecrets: [
      args.bodySecrets,
      args.customConnectorContext.reservedSecretAliases,
    ],
  });
  const filteredConnectorMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap:
      args.connectorContext.secretConnectorMetadataMap,
    secretConnectorMap: filteredConnectorMap,
  });
  const filteredModelProviderMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap: args.modelProvider?.secretConnectorMetadataMap,
    secretConnectorMap: filteredModelProviderMap,
  });
  const secretConnectorMap =
    mergeRecords(filteredConnectorMap, filteredModelProviderMap) ?? null;
  const secretConnectorMetadataMap =
    mergeRecords(
      filteredConnectorMetadataMap,
      filteredModelProviderMetadataMap,
    ) ?? null;
  const secrets = mergeRecords(
    args.connectorContext.secrets,
    args.modelProvider?.secrets,
    args.bodySecrets,
  );
  // The merged map is the runtime `secrets.NAME` namespace consumed by firewall
  // auth and environment expansion. Stored connectors and model providers enter
  // this map under env binding aliases; raw DB storage names stay behind the
  // access metadata used during refresh/lookup.
  return {
    // An explicitly empty namespace still supports dynamic firewall secrets.
    secrets:
      secrets ??
      (args.bodySecrets !== undefined || secretConnectorMap ? {} : undefined),
    secretConnectorMap,
    secretConnectorMetadataMap,
  };
}

function billableFirewallsForPermissions(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissions: PermissionManifest | undefined;
}): string[] {
  const firewalls = args.permissions?.firewalls ?? [];
  const firewallNames = firewalls.map((firewall) => {
    return firewall.kind === "builtin" ? firewall.name : firewall.firewall.name;
  });
  const modelFirewalls = isBuiltInModelProviderType(args.modelProvider?.type)
    ? firewallNames.filter(isModelProviderFirewallName)
    : [];
  const connectorFirewalls = args.permissions?.billableFirewalls ?? [];

  return [...modelFirewalls, ...connectorFirewalls];
}

export function countBucket(
  count: number,
): (typeof COUNT_BUCKET_DIMENSIONS)[number] {
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

export function storedConnectorTimingDimensions(args: {
  readonly scopeSource: ConnectorScopeSource;
  readonly connectorCount?: number;
}): ApiDispatchTimingDimensions {
  return {
    connector_scope_source: args.scopeSource,
    ...(args.connectorCount !== undefined
      ? { stored_connector_count_bucket: countBucket(args.connectorCount) }
      : {}),
  };
}

function isModelProviderFirewallName(name: string): boolean {
  return name.startsWith("model-provider:");
}

function validateModelUsageProviderInvariant(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
}): CreateRunErrorResult | null {
  if (!isBuiltInModelProviderType(args.modelProvider?.type)) {
    return null;
  }
  if (!args.billableFirewalls.some(isModelProviderFirewallName)) {
    return null;
  }
  if (args.modelUsageProvider) {
    return null;
  }
  return providerUnavailable(
    "Built-in model provider did not resolve a supported model for usage reporting",
  );
}

export function prepareModelUsageContext(args: {
  readonly catalog: ModelCatalog;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionManifest: PermissionManifest | undefined;
}): ModelUsageContext | CreateRunErrorResult {
  const billableFirewalls = billableFirewallsForPermissions({
    modelProvider: args.modelProvider,
    permissions: args.permissionManifest,
  });
  const modelUsageProvider = modelUsageProviderForContext(
    args.catalog,
    args.modelProvider,
  );
  const validation = validateModelUsageProviderInvariant({
    modelProvider: args.modelProvider,
    billableFirewalls,
    modelUsageProvider,
  });

  return validation ?? { billableFirewalls, modelUsageProvider };
}

function modelUsageProviderForContext(
  catalog: ModelCatalog,
  modelProvider: ResolvedModelProviderEnvironment | null,
): string | undefined {
  // Usage is reported per catalog model; a provider-only model ID (for
  // example a BYOK provider default) has no catalog pricing identity.
  if (!modelProvider?.selectedModel) {
    return undefined;
  }
  const model = normalizeRunModelId(modelProvider.selectedModel);
  return catalog.byModel.has(model) ? model : undefined;
}

function sessionStorageMountsForPersistence(args: {
  readonly resolvedMounts: readonly PersistedStorageMount[];
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
}): readonly PersistedStorageMount[] {
  const artifactsByName = new Map<string, AgentRunCreateContextArtifact>();
  for (const artifact of args.artifacts) {
    artifactsByName.set(artifact.name, artifact);
  }

  return args.resolvedMounts.flatMap((mount) => {
    if (!mount.writeback) {
      return [];
    }
    const artifact = artifactsByName.get(mount.name);
    if (!artifact || artifact.mountPath !== mount.mountPath) {
      throw new Error(
        `Resolved writeback Storage "${mount.name}" has no source declaration`,
      );
    }
    const {
      version: _resolvedVersion,
      missingRootPolicy: _resolvedMissingRootPolicy,
      ...mountBase
    } = mount;
    return [
      {
        ...mountBase,
        ...(artifact.version === undefined
          ? {}
          : { version: artifact.version }),
        ...(artifact.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: artifact.missingRootPolicy }),
      },
    ];
  });
}

interface BuildRunnerJobPayloadInput {
  readonly disabledPaidTools: readonly string[];
  readonly capturedStorageMounts?: readonly PersistedStorageMount[];
  readonly deferredPiResources?: PreparedPiLaunchResources;
  readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly framework: SupportedFramework;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly apiStartTime: number;
  readonly additionalVolumes:
    | readonly AgentRunCreateAdditionalVolume[]
    | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly okouTokenComputerUseHostId: string | undefined;
  readonly okouTokenCloudBrowserEnabled: boolean | undefined;
  readonly imageRecognitionAvailable: boolean;
  readonly chatThreadId: string | undefined;
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly piLaunchConfig: CreateAgentRunArgs["piLaunchConfig"];
  readonly artifactMissingRootPolicy: ArtifactMissingRootPolicy | undefined;
}

export interface PreparedPiLaunchResources {
  readonly modelConfig: PiModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly sessionId: string;
}

export function canonicalPiMemoryMount<
  T extends { readonly name: string; readonly mountPath: string },
>(mounts: readonly T[] | undefined): T | undefined {
  return mounts?.find((mount) => {
    return (
      mount.name === AUTO_MEMORY_ARTIFACT_NAME &&
      mount.mountPath === PI_MEMORY_ROOT
    );
  });
}

export function noContentPiMemoryRecall(args: {
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
}): PiMemoryRecallSelection {
  return { ...args, status: "no-content" };
}

interface PriorPiMemoryRecall {
  readonly recall: PiMemoryRecallSelection;
  readonly mismatchReason?: "identity_mismatch" | "invalid_epoch";
}

export function priorPiMemoryRecall(args: {
  readonly currentMemoryMount: Pick<
    StorageMountMetadata,
    "storageId" | "versionId"
  >;
  readonly previousRunStorageMounts:
    | readonly PersistedStorageMount[]
    | undefined;
  readonly persistedStorageMounts: readonly PersistedStorageMount[] | undefined;
}): PriorPiMemoryRecall | undefined {
  const priorMount =
    canonicalPiMemoryMount(args.previousRunStorageMounts) ??
    canonicalPiMemoryMount(args.persistedStorageMounts);
  if (priorMount?.piMemoryRecall === undefined) {
    return undefined;
  }
  const parsed = piMemoryRecallSelectionSchema.safeParse(
    priorMount.piMemoryRecall,
  );
  if (
    parsed.success &&
    parsed.data.memoryStorageId === args.currentMemoryMount.storageId &&
    parsed.data.storageVersionId === args.currentMemoryMount.versionId
  ) {
    return { recall: parsed.data };
  }
  return {
    recall: noContentPiMemoryRecall({
      memoryStorageId: args.currentMemoryMount.storageId,
      storageVersionId: args.currentMemoryMount.versionId,
    }),
    mismatchReason: parsed.success ? "identity_mismatch" : "invalid_epoch",
  };
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

function withPiMemoryRecallEpoch(
  mounts: readonly PersistedStorageMount[],
  memoryRecall: PiMemoryRecallSelection | undefined,
): readonly PersistedStorageMount[] {
  if (memoryRecall === undefined) {
    return mounts;
  }
  return mounts.map((mount) => {
    if (
      mount.name !== AUTO_MEMORY_ARTIFACT_NAME ||
      mount.mountPath !== PI_MEMORY_ROOT ||
      mount.storageId !== memoryRecall.memoryStorageId ||
      mount.version !== memoryRecall.storageVersionId
    ) {
      return mount;
    }
    return { ...mount, piMemoryRecall: memoryRecall };
  });
}

/**
 * The installed CLI must have this session construction and meet the CLI
 * floor; otherwise the guest uses the commit-addressed package.
 */
const PI_INSTALLED_CLI_REQUIREMENT = {
  requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
  minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  requiredPiSessionConstructionDigest: PI_SESSION_CONSTRUCTION_DIGEST,
} as const satisfies PiInstalledCliRequirement;

function storedExecutionContextWithPiResources(
  context: StoredExecutionContext,
  resources: PreparedPiLaunchResources | undefined,
  launchFramework: AgentRunFullLaunchSnapshot["framework"],
): StoredExecutionContext {
  const finalizedContext = { ...context, cliAgentType: launchFramework };
  if (resources === undefined) {
    return finalizedContext;
  }
  return {
    ...finalizedContext,
    resumeSession: resources.resumeSession ?? null,
    piSessionId: resources.sessionId,
    piLaunchConfig: resources.launchConfig,
    piModelConfig: resources.modelConfig,
    piInstalledCliRequirement: PI_INSTALLED_CLI_REQUIREMENT,
  };
}

export function assemblePiLaunchResources(args: {
  readonly modelConfig: PiModelConfig;
  readonly piLaunchConfig: CreateAgentRunArgs["piLaunchConfig"];
  readonly memoryRecall: PiMemoryRecallSelection | undefined;
  readonly resumeSession: PreparedPiLaunchResources["resumeSession"];
  readonly sessionId: string;
}): PreparedPiLaunchResources {
  const { memoryRecall, resumeSession, sessionId } = args;
  return {
    modelConfig: args.modelConfig,
    launchConfig: {
      schemaVersion: 2,
      ...(memoryRecall === undefined ? {} : { memoryRecall }),
      ...args.piLaunchConfig,
    },
    ...(memoryRecall === undefined ? {} : { memoryRecall }),
    resumeSession,
    sessionId,
  };
}

export interface PreparePiLaunchResourcesArgs {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly piMemoryEnabled: boolean;
  readonly runId: string;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly storagePlan: Promise<ResolvedAgentRunStorage>;
  readonly previousRunStorageMounts:
    | readonly PersistedStorageMount[]
    | undefined;
  readonly piSandbox: PiModelConfig | undefined;
  readonly chatThreadId: string | undefined;
  readonly timing: ApiDispatchTimingCollector;
  readonly piLaunchConfig: CreateAgentRunArgs["piLaunchConfig"];
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

function preparedRunnerGroup(
  content: agentRunCreateAgentExecutionConfig,
): string {
  const group = runnerGroup(content) ?? optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

function preparedRunnerJobBody(
  args: BuildRunnerJobPayloadInput,
): CreateRunBody {
  if (!args.includeOkouTokenSecret) {
    return args.body;
  }
  const customConnectorSourceEntries =
    args.customConnectorContext.targets.flatMap((target) => {
      return target.kind === "custom" && target.sourceId
        ? [[target.customConnectorId, target.sourceId] as const]
        : [];
    });
  const builtinMcpSlugs = new Set(args.connectorContext.mcpConnectorSlugs);
  const builtinConnectorSourceEntries = (
    args.permissionManifest?.builtinRuntimeTargets ?? []
  ).flatMap((target) => {
    return target.kind === "builtin" &&
      target.sourceId !== undefined &&
      builtinMcpSlugs.has(target.connectorSlug)
      ? [[target.connectorSlug, target.sourceId] as const]
      : [];
  });
  const okouToken = generateOkouToken(
    args.userId,
    args.run.id,
    args.orgId,
    args.featureSwitchContext.overrides,
    {
      ...(args.okouTokenComputerUseHostId
        ? { computerUseHostId: args.okouTokenComputerUseHostId }
        : {}),
      cloudBrowserEnabled: args.okouTokenCloudBrowserEnabled === true,
      imageRecognitionAvailable: args.imageRecognitionAvailable,
      ...(customConnectorSourceEntries.length === 0
        ? {}
        : {
            customConnectorSourceIds: Object.fromEntries(
              customConnectorSourceEntries,
            ),
          }),
      ...(builtinConnectorSourceEntries.length === 0
        ? {}
        : {
            builtinConnectorSourceIds: Object.fromEntries(
              builtinConnectorSourceEntries,
            ),
          }),
    },
  );
  return withOkouTokenSecret(args.body, okouToken);
}

function okouTokenEnvironment(body: CreateRunBody): Record<string, string> {
  const okouToken = body.secrets?.OKOU_TOKEN;
  if (!okouToken) {
    throw new Error("The Okou run token is missing from the run context");
  }
  return { OKOU_TOKEN: okouToken };
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

export function withPaidToolPlatformEnvironment(
  owner: Pick<
    BuildRunnerJobPayloadInput,
    "framework" | "modelProvider" | "piSandbox" | "disabledPaidTools"
  >,
  platformEnvironment: Record<string, string> | undefined,
): Record<string, string> {
  const disabledTools = owner.disabledPaidTools;
  const environment: Record<string, string> = {
    ...platformEnvironment,
    [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(disabledTools),
  };
  if (shouldEnableFrameworkWebSearch(owner, disabledTools)) {
    environment[ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR] = "true";
  } else {
    delete environment[ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR];
  }
  return environment;
}

function shouldEnableFrameworkWebSearch(
  context: Pick<
    BuildRunnerJobPayloadInput,
    "framework" | "modelProvider" | "piSandbox"
  >,
  disabledTools: readonly string[],
): boolean {
  if (
    context.piSandbox !== undefined ||
    !disabledTools.includes("web-search") ||
    (context.framework !== "claude-code" && context.framework !== "codex")
  ) {
    return false;
  }

  // A successful route without a stored provider uses the framework key
  // declared in compose. Stored non-built-in providers are BYOK as well.
  return (
    context.modelProvider === null ||
    !isBuiltInModelProviderType(context.modelProvider.type)
  );
}

function finalizedRunnerLaunch({
  args,
  group,
  body,
  checkpointArtifacts,
  builtContext,
  piResources,
}: {
  args: BuildRunnerJobPayloadInput;
  group: string;
  body: ReturnType<typeof preparedRunnerJobBody>;
  checkpointArtifacts: BuildRunnerJobPayloadInput["artifacts"];
  builtContext: BuiltStoredExecutionContext;
  piResources: PreparedPiLaunchResources | undefined;
}): PreparedRunnerLaunch {
  const storedContext = storedExecutionContextWithPiResources(
    builtContext.context,
    piResources,
    args.launchSnapshot.framework,
  );
  const persistedStorageMounts = withPiMemoryRecallEpoch(
    builtContext.persistedStorageMounts,
    piResources?.memoryRecall,
  );
  const runContextSnapshot = buildRunContextSnapshot({
    runId: args.run.id,
    userId: args.userId,
    body,
    builtContext: { ...builtContext, context: storedContext },
  });
  const cliAgentSessionId =
    storedContext.piSessionId ?? storedContext.resumeSession?.sessionId ?? null;
  return {
    runnerJobPayload: runnerJobPayload({
      runnerGroup: group,
      profile: args.launchSnapshot.runnerProfile,
      cliAgentSessionId,
      reuseKey: runnerReuseKey(args.chatThreadId),
      executionContext: storedContext,
    }),
    runContextSnapshot,
    runStorageMounts: persistedStorageMounts,
    sessionStorageMounts: sessionStorageMountsForPersistence({
      resolvedMounts: persistedStorageMounts,
      artifacts: checkpointArtifacts,
    }),
  };
}

interface StorageMaterializationInput {
  readonly db: Db;
  readonly args: BuildRunnerJobPayloadInput;
  readonly storageManifestStats: StorageManifestBuildStats;
}

function runnerCheckpointArtifacts(args: BuildRunnerJobPayloadInput) {
  return args.artifactMissingRootPolicy === undefined
    ? args.artifacts
    : args.artifacts.map((artifact) => {
        return {
          ...artifact,
          missingRootPolicy: args.artifactMissingRootPolicy,
        };
      });
}

export function prepareRunnerStorageInput(input: StorageMaterializationInput) {
  const { db, args, storageManifestStats } = input;
  const body = preparedRunnerJobBody(args);
  return {
    db,
    args,
    storageManifestStats,
    body,
    checkpointArtifacts: runnerCheckpointArtifacts(args),
    group: preparedRunnerGroup(args.resolved.content),
    platformEnvironment: args.includeOkouTokenSecret
      ? { ...args.platformEnvironment, ...okouTokenEnvironment(body) }
      : args.platformEnvironment,
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

interface MaterializedRunnerStorage {
  readonly input: ReturnType<typeof prepareRunnerStorageInput>;
  readonly preparedStorage: MaterializedAgentRunStorage;
  readonly piResources: PreparedPiLaunchResources | undefined;
}

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

interface ValidatedPreparedLaunchAdmission {
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
  readonly validatedAccountIdentity: string | null;
}

interface PersistAtomicLaunchRowsArgs extends ValidatedPreparedLaunchAdmission {
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

function threadSessionBindingAction(args: {
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

export async function persistThreadSessionBinding(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly identity: LaunchRunIdentity;
    readonly resolution: PendingThreadSessionResolution | undefined;
    readonly timing: ApiDispatchTimingCollector;
    readonly validatedThreadSession?: ValidatedThreadSessionSnapshot;
  },
): Promise<ThreadSessionBindingWrite> {
  const chatThreadId = args.chatThreadId;
  const validatedThreadSession =
    args.validatedThreadSession?.[validatedThreadSessionTransaction] === tx &&
    args.validatedThreadSession.chatThreadId === chatThreadId
      ? args.validatedThreadSession
      : undefined;
  const thread = validatedThreadSession
    ? { agentSessionId: validatedThreadSession.agentSessionId }
    : await args.timing.measure(
        "api_dispatch_load_thread_session_binding",
        "nested",
        async () => {
          const [loaded] = await tx
            .select({ agentSessionId: chatThreads.agentSessionId })
            .from(chatThreads)
            .where(eq(chatThreads.id, chatThreadId))
            .limit(1);
          return loaded;
        },
      );
  if (!thread) {
    throw new Error("Chat thread not found while persisting session binding");
  }

  const action = threadSessionBindingAction({
    identity: args.identity,
    previousAgentSessionId: thread.agentSessionId,
    resolution: args.resolution,
  });
  const [updated] = await args.timing.measure(
    "api_dispatch_update_thread_session_binding",
    "nested",
    async () => {
      return await tx
        .update(chatThreads)
        .set({
          agentSessionId: args.identity.sessionId,
          agentSessionRunId: args.identity.runId,
        })
        .where(eq(chatThreads.id, chatThreadId))
        .returning({ id: chatThreads.id });
    },
  );
  if (!updated) {
    throw new Error("Failed to persist chat thread session binding");
  }

  return {
    chatThreadId: updated.id,
    agentSessionId: args.identity.sessionId,
    agentSessionRunId: args.identity.runId,
    action,
  };
}

export async function validateThreadSessionSnapshot(
  tx: DbTransaction,
  args: {
    readonly createArgs: PendingRunArguments;
    readonly identity: LaunchRunIdentity;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<ValidatedThreadSessionSnapshot | undefined> {
  const resolution = args.createArgs.threadSessionResolution;
  const chatThreadId = args.createArgs.chatThreadId;
  if (!chatThreadId) {
    return undefined;
  }

  const [thread] = await args.timing.measure(
    "api_dispatch_validate_thread_session_snapshot_thread",
    "nested",
    async () => {
      return await tx
        .select({
          agentSessionId: chatThreads.agentSessionId,
          agentSessionRunId: chatThreads.agentSessionRunId,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, chatThreadId))
        .limit(1);
    },
  );
  if (!thread) {
    throw new Error("Chat thread not found while validating session snapshot");
  }
  // No thread row lock: the binding update compares this run id, and the
  // final active-run insert is the per-thread lock.
  if (!resolution) {
    return undefined;
  }
  if (
    thread.agentSessionId !== resolution.expected.agentSessionId ||
    thread.agentSessionRunId !== resolution.expected.agentSessionRunId
  ) {
    throw new Error("Chat thread session changed during run preparation");
  }

  const expectedSessionId = resolution.expected.sessionId;
  if (expectedSessionId === null) {
    return Object.freeze({
      kind: "validated-thread-session-snapshot",
      chatThreadId,
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      [validatedThreadSessionTransaction]: tx,
    });
  }
  const [session] = await args.timing.measure(
    "api_dispatch_validate_thread_session_snapshot_session",
    "nested",
    async () => {
      return await tx
        .select({ conversationId: agentSessions.conversationId })
        .from(agentSessions)
        .where(eq(agentSessions.id, expectedSessionId))
        .for("update")
        .limit(1);
    },
  );
  if (
    !session ||
    session.conversationId !== resolution.expected.conversationId
  ) {
    throw new Error("Chat thread session changed during run preparation");
  }
  return Object.freeze({
    kind: "validated-thread-session-snapshot",
    chatThreadId,
    agentSessionId: thread.agentSessionId,
    agentSessionRunId: thread.agentSessionRunId,
    [validatedThreadSessionTransaction]: tx,
  });
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

/** The thread's session binding changed after the launch read its snapshot. */
class ChatThreadBindingChanged extends Error {
  constructor() {
    super("Chat thread session binding changed during launch");
    this.name = "ChatThreadBindingChanged";
  }
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

export function admissionAttemptOutcome(
  result: AtomicLaunchCommitResult | CreateRunErrorResult,
): AdmissionAttemptOutcome {
  if ("kind" in result) {
    if (result.kind === "pending") {
      return "pending";
    }
    if (result.kind === "queue-first-claim-lost") {
      return "queue_first_claim_lost";
    }
  }
  return "rejected";
}

export function atomicLaunchPayloadInput(args: {
  readonly capturedStorageMounts?: readonly PersistedStorageMount[];
  readonly deferredPiResources?: PreparedPiLaunchResources;
  readonly createArgs: CreateAgentRunArgs;
  readonly context: FinalizedPreparedRunContext;
  readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
  readonly timing: ApiDispatchTimingCollector;
}): BuildRunnerJobPayloadInput {
  return {
    disabledPaidTools: args.context.disabledPaidTools,
    run: args.run,
    deferredPiResources: args.deferredPiResources,
    capturedStorageMounts: args.capturedStorageMounts,
    userId: args.createArgs.userId,
    orgId: args.createArgs.orgId,
    resolved: args.context.resolved,
    body: args.context.body,
    artifacts: args.context.artifacts,
    framework: args.context.framework,
    launchSnapshot: args.context.launchSnapshot,
    piSandbox: args.context.piSandbox,
    modelProvider: args.context.modelProvider,
    connectorContext: args.context.connectorContext,
    customConnectorContext: args.context.customConnectorContext,
    permissionManifest: args.context.permissionManifest,
    billableFirewalls: args.context.billableFirewalls,
    modelUsageProvider: args.context.modelUsageProvider,
    apiStartTime: args.createArgs.apiStartTime,
    additionalVolumes: args.context.additionalVolumes,
    additionalVolumeSources: args.context.additionalVolumeSources,
    includeOkouTokenSecret: args.createArgs.includeOkouTokenSecret,
    okouTokenComputerUseHostId: args.createArgs.okouTokenComputerUseHostId,
    okouTokenCloudBrowserEnabled: args.createArgs.okouTokenCloudBrowserEnabled,
    imageRecognitionAvailable: args.context.imageRecognitionAvailable,
    chatThreadId: args.createArgs.chatThreadId,
    platformEnvironment: args.createArgs.platformEnvironment,
    userTimezone: args.context.userTimezone,
    featureSwitchContext: args.context.featureSwitchContext,
    timing: args.timing,
    piLaunchConfig: args.createArgs.piLaunchConfig,
    artifactMissingRootPolicy: args.createArgs.artifactMissingRootPolicy,
  };
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

export interface PreparedRunContext {
  readonly disabledPaidTools: readonly string[];
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly connectorScope: EffectiveConnectorScope;
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes:
    | readonly AgentRunCreateAdditionalVolume[]
    | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly imageRecognitionAvailable: boolean;
  /** Resolved once at run start and used as the run's built-in image default. */
  readonly selectedImageModel: ImageModel;
}

interface FinalizedPreparedRunContext extends PreparedRunContext {
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
}

function assertCurrentPiCliArtifact(): void {
  // The writer and CLI reader are built from the same commit. A mutable or
  // differently pinned package cannot consume a newly captured model.
  const commit = env("GIT_COMMIT_SHA");
  const cliUrl = new URL(env("CLI_PKG_URL"));
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    cliUrl.origin !== "https://static.okou.io" ||
    cliUrl.username ||
    cliUrl.password ||
    cliUrl.search ||
    cliUrl.hash ||
    cliUrl.pathname !== `/okou-cli/${commit}/package.tgz`
  ) {
    throw new PiNativeConfigurationError(
      "Pi requires the current commit-addressed CLI reader artifact",
    );
  }
}

export async function materializePreparedPiProvider(
  createArgs: RunModelProviderArgs,
  provider: ResolvedModelProviderEnvironment | null,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!createArgs.piExecution) {
    return provider;
  }
  const config = resolvePiSandboxModelConfig(
    provider,
    createArgs.codexServiceTier,
    createArgs.agentRunMetadata?.reasoningEffort,
  );
  if (!config || !provider) {
    throw new Error(
      "Selected Pi execution requires a supported model provider configuration",
    );
  }
  if (provider.selectedModel === "deepseek-v4.1-flash") {
    assertCurrentPiCliArtifact();
  }
  if (!("schemaVersion" in config) || config.schemaVersion !== 4) {
    if (
      !("schemaVersion" in config) &&
      (provider.type === "deepseek" || provider.type === "openrouter-codex") &&
      isPiDeepSeekModel(provider.selectedModel)
    ) {
      const credential = safeSync(() => {
        return assertPiNativeCredential(
          provider.secrets[config.credentialSecretName] ?? "",
        );
      });
      if ("error" in credential) {
        throw new PiNativeConfigurationError(
          "Selected Pi credential is invalid",
        );
      }
      return {
        ...provider,
        piModelConfig: config,
        secretConnectorMap: undefined,
        secretConnectorMetadataMap: undefined,
      };
    }
    return { ...provider, piModelConfig: config };
  }
  assertCurrentPiCliArtifact();
  const secrets: Record<string, string> = {};
  const route = normalizePiExecutionRoute(config);
  await materializePiExecutionRoute({
    route,
    target: "direct",
    resolveCredential(binding) {
      const value = provider.secrets[binding.secretName];
      if (!value) {
        throw new PiNativeConfigurationError(
          "Selected native Pi credential is unavailable",
        );
      }
      const credential = safeSync(() => {
        return assertPiNativeCredential(value);
      });
      if ("error" in credential) {
        throw new PiNativeConfigurationError(
          "Selected Pi credential is invalid",
        );
      }
      secrets[binding.secretName] = value;
      return value;
    },
  });
  return {
    ...provider,
    piModelConfig: config,
    environment: nativeCredentialEnvironment(route),
    secrets,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    firewall: piNativeFirewall(config),
    inlineFirewall: true,
  };
}

export function resolvePreparedPiModelConfig(args: {
  readonly createArgs: Pick<
    CreateAgentRunArgs,
    "piExecution" | "codexServiceTier" | "agentRunMetadata"
  >;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
}): PiModelConfig | undefined {
  if (!args.createArgs.piExecution) {
    return undefined;
  }
  const config = resolvePiSandboxModelConfig(
    args.modelProvider,
    args.createArgs.codexServiceTier,
    args.createArgs.agentRunMetadata?.reasoningEffort,
  );
  if (!config) {
    throw new Error(
      "Selected Pi execution requires a supported Pi model provider configuration",
    );
  }
  return config;
}

async function resolveRunModelProvider(
  db: ReadonlyDb,
  args: RunModelProviderArgs,
  options: {
    readonly content: agentRunCreateAgentExecutionConfig;
    readonly framework: SupportedFramework;
    readonly featureSwitchContext: FeatureSwitchContext;
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
      })
    : null;

  if (!shouldResolveModelProvider || modelProvider) {
    return modelProvider;
  }

  return providerUnavailable(
    `No model provider configured and ${frameworkApiKeyEnv(options.framework)} is not declared in compose environment`,
  );
}

export async function buildResolvedRunBody(args: {
  readonly initialBody: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly canonicalOkouRuntime: boolean;
  readonly resolvedEnvironment?: RunBodyEnvironment;
}): Promise<CreateRunBody> {
  const runVars =
    args.initialBody.vars !== undefined
      ? args.initialBody.vars
      : args.resolved.vars;
  const environment =
    args.resolvedEnvironment ??
    (await resolveRunBodyEnvironment({
      content: args.resolved.content,
      runVars,
      runSecrets: args.initialBody.secrets,
      persistedEnvironment: args.persistedEnvironment,
      featureSwitchContext: args.featureSwitchContext,
      canonicalOkouRuntime: args.canonicalOkouRuntime,
    }));
  return {
    ...args.initialBody,
    ...environment,
    volumeVersions:
      args.initialBody.volumeVersions !== undefined
        ? args.initialBody.volumeVersions
        : args.resolved.volumeVersions,
  };
}

type RunBodyEnvironment = Pick<CreateRunBody, "vars" | "secrets">;

export async function resolveRunBodyEnvironment(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly runVars: CreateRunBody["vars"];
  readonly runSecrets: CreateRunBody["secrets"];
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly canonicalOkouRuntime: boolean;
}): Promise<RunBodyEnvironment> {
  const mergedVars = buildMergedVariables({
    persistedEnvironment: args.persistedEnvironment,
    runVars: args.runVars,
  });
  const mergedSecrets = await buildReferencedSecrets({
    content: args.content,
    runSecrets: args.runSecrets,
    persistedEnvironment: args.persistedEnvironment,
    featureSwitchContext: args.featureSwitchContext,
  });

  return {
    vars: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedVars)
      : mergedVars,
    secrets: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedSecrets)
      : mergedSecrets,
  };
}

function validateRunEnvironmentReferences(args: {
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly validateEnvironmentReferences: boolean | undefined;
}): CreateRunErrorResult | null {
  const validationSecrets = buildStoredExecutionSecrets({
    connectorContext: args.connectorContext,
    modelProvider: args.modelProvider,
    bodySecrets: args.body.secrets,
    customConnectorContext: args.customConnectorContext,
  });
  const validation = validateCompose(
    args.resolved.content,
    args.body.vars,
    validationSecrets.secrets,
    {
      validateEnvironmentReferences: args.validateEnvironmentReferences,
      environmentSecretPlaceholders:
        args.permissionManifest?.environmentSecretPlaceholders,
      additionalEnvironment: args.modelProvider?.environment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    },
  );

  return isRouteError(validation) ? validation : null;
}

export async function buildPreparedPermissionManifest(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<CreateRunBody, "permissionPolicies" | "vars" | "secrets">;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | CreateRunErrorResult> {
  const result = await settle(
    buildPermissionManifest({
      connectorCatalogSelection: args.connectorCatalogSelection,
      modelProvider: args.modelProvider,
      permissionPolicies: args.body.permissionPolicies,
      vars: args.body.vars,
      connectorVars: args.storedConnectorMetadataContext.vars,
      connectorSlugs: args.storedConnectorMetadataContext.connectorSlugs,
      connectorSourceIdBySlug:
        args.storedConnectorMetadataContext.connectorSourceIdBySlug,
      customConnectorFirewalls: args.customConnectorContext.firewalls,
      customConnectorPermissionPolicies:
        args.customConnectorContext.permissionPolicies,
      customConnectorIdByFirewallName:
        args.customConnectorContext.customConnectorIdByFirewallName,
      customConnectorSourceIdByFirewallName:
        args.customConnectorContext.customConnectorSourceIdByFirewallName,
      timing: args.timing,
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof FirewallBaseUrlResolutionError) {
    return badRequestMessage(result.error.message);
  }
  throw result.error;
}

function preparedRunAdditionalVolumes(args: {
  readonly createArgs: Pick<CreateAgentRunArgs, "injectSkillVolumes">;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly skillsRoot: string;
  readonly body: Pick<CreateRunBody, "additionalVolumes">;
  readonly resolved: Pick<ResolvedRunExecution, "additionalVolumes">;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}): PreparedAdditionalVolumes {
  const bodyAdditionalVolumes = args.body.additionalVolumes;
  const injectedSkillVolumes = buildInjectedSkillVolumes(
    {
      injectSkillVolumes: args.createArgs.injectSkillVolumes,
      systemSkillStorageResolution: args.systemSkillStorageResolution,
      allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
      connectorCatalogSelection: args.connectorCatalogSelection,
      officialWorkflowRun: args.officialWorkflowRun,
    },
    args.skillsRoot,
  );
  return mergeAdditionalVolumes({
    prepend: [
      ...buildCustomConnectorSkillVolumes(
        args.customConnectorContext.skills,
        args.skillsRoot,
      ),
      ...(injectedSkillVolumes ?? []),
    ],
    base: prepareAdditionalVolumesWithSource(
      bodyAdditionalVolumes ?? args.resolved.additionalVolumes,
      bodyAdditionalVolumes ? "request_additional_volume" : "unknown",
    ),
  });
}

export interface PreparedRunBodyContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly requestedFramework: SupportedFramework;
  readonly featureSwitchContext: FeatureSwitchContext;
}

export interface PreparedRuntimeContext {
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

export interface PreparedConnectorContext {
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
}

export function connectorScopeForRuntimeSnapshot(
  scope: EffectiveConnectorScope,
  snapshot: ConnectorRuntimeSelection,
): EffectiveConnectorScope {
  return {
    ...scope,
    allowedConnectorSlugs: scope.allowedConnectorSlugs.filter(
      (connectorSlug) => {
        const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
        return (
          connector !== undefined &&
          [...connector.methods.values()].some((method) => {
            return method.executable;
          })
        );
      },
    ),
  };
}

export function connectorScopeFromCreateArgs(
  args: CreateAgentRunArgs,
): EffectiveConnectorScope {
  const source = isEmptyRunConnectorScope(args.connectorScope)
    ? "empty"
    : (args.connectorScope.source ?? "explicit");
  return {
    allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
    allowedCustomConnectorIds: args.connectorScope.allowedCustomConnectorIds,
    customConnectorGrants: args.connectorScope.customConnectorGrants,
    source,
  };
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
      });
    },
  );
}

export function piConfigurationRouteError(
  error: unknown,
): ReturnType<typeof badRequestMessage> {
  if (error instanceof PiNativeConfigurationError) {
    return badRequestMessage(error.message);
  }
  throw error;
}

export interface RunPreparedConnectorInputs {
  readonly db: ReadonlyDb;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<CreateRunBody, "permissionPolicies" | "vars" | "secrets">;
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
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

export function prepareRunOutputMetadata(args: {
  readonly createArgs: Pick<
    CreateAgentRunArgs,
    "injectSkillVolumes" | "pinnedMemoryVersionId"
  >;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly body: Pick<CreateRunBody, "additionalVolumes">;
  readonly resolved: RunStorageExecution;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}): {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes:
    | readonly AgentRunCreateAdditionalVolume[]
    | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
} {
  const additionalVolumes = preparedRunAdditionalVolumes({
    createArgs: args.createArgs,
    systemSkillStorageResolution: args.systemSkillStorageResolution,
    connectorScope: args.connectorScope,
    connectorCatalogSelection: args.connectorCatalogSelection,
    customConnectorContext: args.customConnectorContext,
    skillsRoot: skillsRootForRun(args.framework, args.piSandbox),
    body: args.body,
    resolved: args.resolved,
    officialWorkflowRun: args.officialWorkflowRun,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    piSandbox: args.piSandbox,
    includeAutoMemory: true,
    pinnedMemoryVersionId: args.createArgs.pinnedMemoryVersionId,
  }).artifacts;
  return {
    additionalVolumes: additionalVolumes.volumes,
    additionalVolumeSources: additionalVolumes.sources,
    artifacts,
  };
}

export function skillsRootForRun(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  return piSandbox === undefined
    ? frameworkSkillsMountPath(framework)
    : PI_SKILLS_ROOT;
}

function isImageRecognitionAvailableForRun(args: {
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly selectedModel: string | undefined;
  readonly providerType: ModelProviderType | undefined;
}): boolean {
  return (
    args.includeOkouTokenSecret === true &&
    getModelImageInputSupport(args.selectedModel, args.providerType) ===
      "unsupported"
  );
}

export interface PrepareRunContextInput {
  readonly db: ReadonlyDb;
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
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

function resolveCompatibleDirectResumeSession(args: {
  readonly resolved: ResolvedRunExecution;
  readonly next: SessionExecutionIdentity;
}): ResolvedRunExecution {
  const previous = args.resolved.resumeSessionIdentity;
  return previous && canReuseSession(previous, args.next)
    ? args.resolved
    : { ...args.resolved, resumeSession: undefined };
}

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

export function builtInModelProviderEnvironmentFromSnapshot(args: {
  readonly route: BuiltInModelRuntimeRoute;
  readonly selectedModel: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly apiKey: string;
}): ResolvedModelProviderEnvironment | null {
  const { route, selectedModel, featureSwitchContext } = args;
  const key = { apiKey: args.apiKey };
  const secretName = getSecretNameForType(route.providerType);
  if (!secretName) {
    return null;
  }
  const environment = providerEnvironmentFromSecretRefs(
    route.providerType,
    secretName,
    key.apiKey,
    route.upstreamModel,
  );
  const routing = {
    credentialOwner: "builtin" as const,
    model: route.upstreamModel,
    usRoutingEnabled: isFeatureEnabled(
      FeatureSwitchKey.OpenRouterUsRouting,
      featureSwitchContext,
    ),
  };
  const firewall = getModelProviderFirewall(route.providerType, routing);
  const usesUsEndpoint = firewall?.apis.some((api) => {
    return api.base.startsWith(`${OPENROUTER_US_ORIGIN}/`);
  });
  if (route.providerType === "openrouter-api-key") {
    environment.ANTHROPIC_BASE_URL = getOpenRouterBaseUrl("messages", routing);
  } else if (route.providerType === "openrouter-codex") {
    environment.OPENAI_BASE_URL = getOpenRouterBaseUrl("responses", routing);
  }
  const codexRuntimeConfig = resolveModelProviderCodexRuntimeConfig({
    type: route.providerType,
    logicalModel: selectedModel,
    runtimeModel: route.upstreamModel,
    environment,
  });

  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    environment,
    secrets: { [secretName]: key.apiKey },
    selectedModel,
    builtInModelRuntimeRoute: route,
    upstreamModel: route.upstreamModel,
    ...(usesUsEndpoint ? { firewall } : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
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

type RunModelProviderArgs = Pick<
  CreateAgentRunArgs,
  | "catalog"
  | "orgId"
  | "userId"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "modelProviderType"
  | "capturedPersonalSubscriptionAccount"
  | "selectedModelOverride"
  | "builtInModelRuntimeRoute"
  | "piExecution"
  | "retainedRunId"
  | "codexServiceTier"
  | "agentRunMetadata"
  | "queueFirstAssociation"
>;

export interface RunModelProviderReadInput {
  readonly db: ReadonlyDb;
  readonly timing: ApiDispatchTimingCollector;
  readonly args: RunModelProviderArgs;
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
  const captureSecret =
    args.piExecution &&
    (isPiNativeModel(args.selectedModelOverride) ||
      isPiDeepSeekModel(args.selectedModelOverride));
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
      (provider?.type !== "openai-api-key" ||
        provider.selectedModel !== "gpt-6-astra")
    ) {
      return badRequestMessage(
        "Astra Ultrafast requires a direct OpenAI API-key route",
      );
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

export interface RunConnectorSelection {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly threadConnectorSelectionIds: ThreadConnectorSelectionIds | undefined;
  readonly connectorScope: EffectiveConnectorScope;
}

type RunConnectorScopeObject = Computed<
  EffectiveConnectorScope | Promise<EffectiveConnectorScope>
>;

export interface RunConnectorReadInput {
  readonly db: ReadonlyDb;
  readonly timing: ApiDispatchTimingCollector;
  readonly args: Pick<
    CreateAgentRunArgs,
    | "orgId"
    | "userId"
    | "chatThreadId"
    | "connectorSourceId"
    | "includeOkouTokenSecret"
  >;
}

export interface RunConnectorContextSnapshot {
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}

type RunConnectorSelectionObject = Computed<
  Promise<RunConnectorSelection | CreateRunErrorResult>
>;

export interface RunConnectorPreparation {
  readonly selection: RunConnectorSelection;
  readonly stored: StoredConnectorMaterializationArgs | null;
  readonly custom: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[];
    readonly connectorIdCandidatesByCustomConnectorId:
      | ReadonlyMap<string, readonly string[]>
      | undefined;
    readonly customConnectorGrants:
      | readonly AgentCustomConnectorGrant[]
      | undefined;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  } | null;
}

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

interface RunThreadConnectorSelectionRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

export function runConnectorTargetFromRow(
  row: Pick<
    RunThreadConnectorSelectionRow,
    "connectorSlug" | "customConnectorId"
  >,
): ConnectorAccountTarget {
  if (row.connectorSlug !== null && row.customConnectorId === null) {
    return {
      kind: "builtin",
      connectorSlug: connectorSlugSchema.parse(row.connectorSlug),
    };
  }
  if (row.customConnectorId !== null && row.connectorSlug === null) {
    return { kind: "custom", customConnectorId: row.customConnectorId };
  }
  throw new Error("Expected exactly one thread connector selection target");
}

export function runConnectorTargetIsAuthorized(
  scope: EffectiveConnectorScope,
  target: ConnectorAccountTarget,
): boolean {
  return target.kind === "builtin"
    ? scope.allowedConnectorSlugs.includes(
        connectorSlugSchema.parse(target.connectorSlug),
      )
    : scope.allowedCustomConnectorIds.includes(target.customConnectorId);
}

export function runThreadConnectorCandidates(
  selections: readonly ConnectorAccountSelection[],
  source: ConnectorAccountSelection | null,
): ThreadConnectorSelectionIds {
  const candidates = new Map<string, readonly ConnectorAccountSelection[]>();
  for (const selection of selections) {
    candidates.set(connectorAccountTargetKey(selection.target), [selection]);
  }
  if (source) {
    const key = connectorAccountTargetKey(source.target);
    const selected = candidates.get(key)?.[0];
    candidates.set(
      key,
      selected && selected.connectionId !== source.connectionId
        ? [source, selected]
        : [source],
    );
  }
  const connectorIdCandidatesBySlug = new Map<
    ConnectorSlug,
    readonly string[]
  >();
  const connectorIdCandidatesByCustomConnectorId = new Map<
    string,
    readonly string[]
  >();
  for (const values of candidates.values()) {
    const first = values[0];
    if (!first) {
      continue;
    }
    const ids = values.map((value) => {
      return value.connectionId;
    });
    if (first.target.kind === "builtin") {
      connectorIdCandidatesBySlug.set(
        connectorSlugSchema.parse(first.target.connectorSlug),
        ids,
      );
    } else {
      connectorIdCandidatesByCustomConnectorId.set(
        first.target.customConnectorId,
        ids,
      );
    }
  }
  return {
    connectorIdCandidatesBySlug,
    connectorIdCandidatesByCustomConnectorId,
  };
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

interface RunConnectorAccountRequest {
  readonly target: ConnectorAccountTarget;
  readonly sourceIds: readonly string[];
}

interface RunConnectorAccountRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
  readonly isDefault: boolean;
}

export function runConnectorAccountRequests(
  scope: EffectiveConnectorScope,
  selections: ThreadConnectorSelectionIds | undefined,
): readonly RunConnectorAccountRequest[] {
  return [
    ...scope.allowedConnectorSlugs.map(
      (connectorSlug): RunConnectorAccountRequest => {
        return {
          target: { kind: "builtin", connectorSlug },
          sourceIds:
            selections?.connectorIdCandidatesBySlug?.get(connectorSlug) ?? [],
        };
      },
    ),
    ...scope.allowedCustomConnectorIds.map(
      (customConnectorId): RunConnectorAccountRequest => {
        return {
          target: { kind: "custom", customConnectorId },
          sourceIds:
            selections?.connectorIdCandidatesByCustomConnectorId?.get(
              customConnectorId,
            ) ?? [],
        };
      },
    ),
  ];
}

export function runConnectorAccountCandidatesFromRows(args: {
  readonly requests: readonly RunConnectorAccountRequest[];
  readonly rows: readonly RunConnectorAccountRow[];
}): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(
    args.rows.map((row) => {
      return [row.connectorId, row];
    }),
  );
  const defaultsByTarget = new Map<string, string[]>();
  for (const row of args.rows) {
    if (!row.isDefault) {
      continue;
    }
    const key = connectorAccountTargetKey(runConnectorTargetFromRow(row));
    const ids = defaultsByTarget.get(key) ?? [];
    ids.push(row.connectorId);
    defaultsByTarget.set(key, ids);
  }
  return new Map(
    args.requests.map((request) => {
      const key = connectorAccountTargetKey(request.target);
      const explicit = request.sourceIds.filter((id) => {
        const row = byId.get(id);
        return (
          row !== undefined &&
          connectorAccountTargetKey(runConnectorTargetFromRow(row)) === key
        );
      });
      const defaults = defaultsByTarget.get(key) ?? [];
      return [
        key,
        [...new Set([...explicit, ...(defaults.length === 1 ? defaults : [])])],
      ];
    }),
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

export function customConnectorCandidateRuntimeRows(args: {
  readonly connector: CustomConnectorRuntimeDataRows[number]["connector"];
  readonly candidateIds: readonly string[];
  readonly storageRows: readonly CustomConnectorRuntimeStorageRow[];
}): CustomConnectorRuntimeDataRows {
  const { connector } = args;
  const declaredFields = new Set(
    connector.fields.map(customConnectorValueMarkerKey),
  );
  const ids: readonly (string | undefined)[] = args.candidateIds.length
    ? args.candidateIds
    : [undefined];
  return ids.map((id) => {
    const storage = customConnectorRuntimeStorageSnapshot(
      [connector],
      args.storageRows,
      new Map(id ? [[connector.id, id]] : []),
    );
    const credentialAccess = storage.accesses.get(connector.id);
    if (!credentialAccess) {
      throw new Error("Expected custom connector credential access");
    }
    return {
      connector,
      credentialAccess,
      values: storage.values.filter((value) => {
        return declaredFields.has(customConnectorValueMarkerKey(value));
      }),
    };
  });
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
      const usage = prepareModelUsageContext({
        catalog: (await get(input$)).args.catalog,
        modelProvider,
        permissionManifest: connectors.permissionManifest,
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

export interface RunWorkflowReadInput {
  readonly db: ReadonlyDb;
  readonly args: Pick<
    CreateAgentRunArgs,
    | "orgId"
    | "userId"
    | "injectSkillVolumes"
    | "requiredOfficialWorkflowIds"
    | "piExecution"
    | "codexServiceTier"
    | "agentRunMetadata"
  >;
}

export type RunWorkflowModelState =
  | {
      readonly requestedFramework: SupportedFramework;
      readonly modelProvider: ResolvedModelProviderEnvironment | null;
    }
  | CreateRunErrorResult
  | undefined;

export type PreparedOfficialWorkflow =
  | OfficialWorkflowRunObservation
  | CreateRunErrorResult
  | undefined;

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

export function composePreparedRunContext({
  args,
  bodyContext,
  runtimeContext,
  userTimezone,
  selectedImageModel,
  officialWorkflowRun,
  systemSkillStorageResolution,
  disabledPaidTools,
}: {
  readonly args: CreateAgentRunArgs;
  readonly bodyContext: PreparedRunBodyContext;
  readonly runtimeContext: PreparedRuntimeContext;
  readonly userTimezone: string | undefined;
  readonly selectedImageModel: PreparedRunContext["selectedImageModel"];
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly disabledPaidTools: readonly string[];
}): PreparedRunContext | CreateRunErrorResult {
  const { body } = bodyContext;
  const piSandbox = resolvePreparedPiModelConfig({
    createArgs: args,
    modelProvider: runtimeContext.modelProvider,
  });
  const resolved = resolveCompatibleDirectResumeSession({
    resolved: bodyContext.resolved,
    next: {
      selectedModel: runtimeContext.modelProvider?.selectedModel ?? null,
      cliAgentType: piSandbox ? "pi" : runtimeContext.framework,
    },
  });
  const validation = validateRunEnvironmentReferences({
    resolved,
    body,
    modelProvider: runtimeContext.modelProvider,
    connectorContext: runtimeContext.connectorContext,
    customConnectorContext: runtimeContext.customConnectorContext,
    permissionManifest: runtimeContext.permissionManifest,
    validateEnvironmentReferences: args.validateEnvironmentReferences,
  });
  if (validation) {
    return validation;
  }
  const metadata = prepareRunOutputMetadata({
    createArgs: args,
    systemSkillStorageResolution: systemSkillStorageResolution,
    connectorScope: runtimeContext.connectorScope,
    connectorCatalogSelection: runtimeContext.connectorCatalogSelection,
    customConnectorContext: runtimeContext.customConnectorContext,
    framework: runtimeContext.framework,
    piSandbox,
    body,
    resolved,
    officialWorkflowRun,
  });
  return {
    disabledPaidTools,
    body,
    resolved,
    framework: runtimeContext.framework,
    piSandbox,
    modelProvider: runtimeContext.modelProvider,
    connectorContext: runtimeContext.connectorContext,
    customConnectorContext: runtimeContext.customConnectorContext,
    permissionManifest: runtimeContext.permissionManifest,
    billableFirewalls: runtimeContext.billableFirewalls,
    modelUsageProvider: runtimeContext.modelUsageProvider,
    connectorScope: runtimeContext.connectorScope,
    ...metadata,
    officialWorkflowRun,
    userTimezone,
    featureSwitchContext: bodyContext.featureSwitchContext,
    selectedImageModel,
    imageRecognitionAvailable: isImageRecognitionAvailableForRun({
      includeOkouTokenSecret: args.includeOkouTokenSecret,
      selectedModel:
        runtimeContext.modelProvider?.selectedModel ??
        args.selectedModelOverride,
      providerType:
        runtimeContext.modelProvider?.concreteType ??
        runtimeContext.modelProvider?.type,
    }),
  };
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

export function flushQueueFirstClaimLostTiming(args: {
  readonly createArgs: PendingRunArguments;
  readonly identity: LaunchRunIdentity;
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}): void {
  args.phaseTiming.appendTo(args.timing);
  args.timing.flush({
    runId: args.identity.runId,
    runnerGroup: args.launch.runnerJobPayload.runnerGroup,
    profile: args.launch.runnerJobPayload.profile,
    dispatchPath: "direct",
    dimensions: {
      ...timingDimensionsForCreateArgs(args.createArgs),
      queue_first_launch_outcome: "claim_lost",
    },
    ...(args.createArgs.body.triggerSource
      ? { triggerSource: args.createArgs.body.triggerSource }
      : {}),
  });
}

export interface AtomicLaunchRunInput {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly enforceBuiltInCredits: boolean;
  readonly context: FinalizedPreparedRunContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}

export function bindStableAppendSystemPrompt(
  prompt: PiStableContextPromptProjection,
  dynamicAppendSystemPrompt: string,
): string {
  return [
    prompt.agentIdentity,
    prompt.executionLimit,
    prompt.tools,
    dynamicAppendSystemPrompt,
  ]
    .filter((part) => {
      return Boolean(part);
    })
    .join("\n\n");
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

export function finalizedMaterializedLaunch(
  storage: MaterializedRunnerStorage,
  contextDraft: BuiltStoredExecutionContextDraft,
): PreparedRunnerLaunch {
  const { args, group, body, checkpointArtifacts } = storage.input;
  return finalizedRunnerLaunch({
    args,
    group,
    body,
    checkpointArtifacts,
    builtContext: resolveBuiltStoredExecutionContext(
      storage.preparedStorage.prepared,
      contextDraft,
    ),
    piResources: storage.piResources,
  });
}

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

interface PreparedAgentRun {
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly contextInput: PrepareRunContextInput;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
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

export function finalizePreparedRunContext(
  prepared: Omit<PreparedAgentRun, "phaseTiming">,
  finalAppendSystemPrompt: CreateRunBody["appendSystemPrompt"],
): FinalizedPreparedRunContext {
  return {
    ...prepared.context,
    launchSnapshot: {
      schemaVersion: 3,
      framework:
        prepared.context.piSandbox === undefined
          ? prepared.context.framework
          : "pi",
      runnerProfile: runnerProfile(prepared.context.resolved.content),
    },
    body: withFinalRunAppendSystemPrompt({
      body: {
        ...prepared.context.body,
        appendSystemPrompt: finalAppendSystemPrompt,
      },
      framework: prepared.context.framework,
      chatThreadId: prepared.args.chatThreadId,
      imageRecognitionAvailable: prepared.context.imageRecognitionAvailable,
      mcpConnectorSlugs: [
        ...prepared.context.connectorContext.mcpConnectorSlugs,
        ...prepared.context.customConnectorContext.mcpConnectorSlugs,
      ],
      selectedImageModel: prepared.context.selectedImageModel,
      cliAvailable: prepared.args.includeOkouTokenSecret === true,
    }),
  };
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
      const args = previewAutomationBypass
        ? {
            ...input.args,
            platformEnvironment: {
              ...input.args.platformEnvironment,
              [VERCEL_AUTOMATION_BYPASS_ENV]: previewAutomationBypass,
            },
          }
        : input.args;
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

/** Post-reservation materializer. This never inserts a Run or invokes the API
 * first turn. Publication owns a fresh admission. */

// Selected-agent authorization, bootstrap and canonical session preparation.

export type AgentRunCreateBody = z.infer<typeof runCreateBodySchema>;

// Emitted as the agent_run_origin observability dimension. The values name what
// started the run, so the fallback is "direct" (not started by an automation)
// rather than a restatement that this is an agent run.
type AgentRunOrigin = "direct" | "workflow_automation";

const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
  "Skill(loop)",
  "Skill(loop *)",
] as const;

export type AgentRunRecord = AgentRunRequestAgent;

/**
 * Request-scoped preparation facts from an entry point that already authorized
 * this exact user, organization, and Agent. These observations can remove
 * equivalent preflight reads, but they never authorize the later launch
 * transaction: compute admission still resolves the Agent and its ownership
 * again before it claims input or inserts a Run.
 *
 * When this object is present, nullable Agent metadata and feature overrides
 * are authoritative observations. The bootstrap materializer may enrich an
 * omitted email from the same request's user-info row. Absence of the object
 * means those facts were not loaded and every existing database fallback
 * remains.
 */
interface AuthorizedAgentRunRequestObservation {
  readonly userId: string;
  readonly orgId: string;
  readonly agent: AgentRunRequestAgent;
  readonly featureSwitchContext: FeatureSwitchContext;
}

function optionalAgentSetting(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

interface AgentRunsCreateHttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface AgentRunsCreateInternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

type AgentRunsCreateRunCallback =
  | AgentRunsCreateHttpRunCallback
  | AgentRunsCreateInternalRunCallback;

interface AgentRunsCreateAgentRunMetadata {
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export interface CreateAgentRunCommandArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: AgentRunCreateBody;
  readonly apiStartTime: number;
  readonly triggerSource?: TriggerSource;
  readonly appendSystemPrompt?: string;
  readonly userInfoExtras?: Pick<
    UserInfo,
    | "slackDisplayName"
    | "slackUserId"
    | "feishuDisplayName"
    | "feishuOpenId"
    | "teamsUserDisplayName"
    | "teamsUserPrincipalName"
    | "teamsUserId"
    | "telegramDisplayName"
    | "telegramUsername"
    | "telegramUserId"
    | "telegramLanguage"
    | "agentphoneHandle"
  >;
  readonly callbacks?: readonly AgentRunsCreateRunCallback[];
  readonly chatThreadId?: string;
  readonly connectorSourceId?: string;
  readonly threadSessionRoute?: ChatThreadSessionRoute;
  /** A producer may atomically move an integration thread to this run's agent. */
  readonly expectedThreadAgentId?: string;
  readonly webChatSessionPromptContext?: WebChatSessionPromptContext;
  readonly computerUseHostId?: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly agentRunMetadata?: AgentRunsCreateAgentRunMetadata;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly dispatchFailedCallbacks?: DispatchFailedRunCallbacks;
  readonly persistProducerRunBinding?: PersistProducerRunBinding;
  readonly agentRunModelPin?: AgentRunModelPin;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly timing?: ApiDispatchTimingCollector;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
}

export interface CreateQueueFirstAgentRunCommandArgs extends Omit<
  CreateAgentRunCommandArgs,
  "chatThreadId" | "agentRunModelPin"
> {
  readonly chatThreadId: string;
  readonly queueFirstAssociation: QueueFirstRunAssociation;
  readonly agentRunModelPin: AgentRunModelPin;
}

type AnyCreateAgentRunCommandArgs =
  | CreateAgentRunCommandArgs
  | CreateQueueFirstAgentRunCommandArgs;

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

export function agentRunsCreateForbidden(
  message: string,
): ApiErrorResponse<403, "FORBIDDEN"> {
  return {
    status: 403 as const,
    body: {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
  };
}

function buildExecutionTimeLimitPrompt(): string {
  const executionHours = AGENT_EXECUTION_TIMEOUT_SECONDS / (60 * 60);
  const executionHourUnit = executionHours === 1 ? "hour" : "hours";
  return [
    "# Execution Time Limit",
    "",
    `A single agent run has a maximum execution time of ${executionHours} ${executionHourUnit}.`,
    "Plan and prioritize the work so you can complete the most important in-scope tasks and provide a final response before the run ends.",
  ].join("\n");
}

function buildCurrentUserPrompt(
  userInfo: UserInfo,
  triggerSource: TriggerSource,
): string {
  const lines = ["# Current User Info"];
  if (userInfo.name) {
    lines.push(`Name: ${userInfo.name}`);
  }
  if (userInfo.email) {
    lines.push(`Email: ${userInfo.email}`);
  }
  lines.push(`Timezone: ${userInfo.timezone ?? "UTC"}`);
  if (userInfo.slackDisplayName) {
    lines.push(`Slack display name: ${userInfo.slackDisplayName}`);
  }
  if (userInfo.slackUserId) {
    lines.push(`Slack user ID: ${userInfo.slackUserId}`);
  }
  if (triggerSource === "feishu" || triggerSource === "lark") {
    const providerName = FEISHU_PLATFORMS[triggerSource].name;
    if (userInfo.feishuDisplayName) {
      lines.push(`${providerName} display name: ${userInfo.feishuDisplayName}`);
    }
    if (userInfo.feishuOpenId) {
      lines.push(`${providerName} open ID: ${userInfo.feishuOpenId}`);
    }
  }
  if (userInfo.teamsUserDisplayName) {
    lines.push(`Teams display name: ${userInfo.teamsUserDisplayName}`);
  }
  if (userInfo.teamsUserPrincipalName) {
    lines.push(`Teams user principal name: ${userInfo.teamsUserPrincipalName}`);
  }
  if (userInfo.teamsUserId) {
    lines.push(`Teams user ID: ${userInfo.teamsUserId}`);
  }
  if (userInfo.telegramDisplayName) {
    lines.push(`Telegram display name: ${userInfo.telegramDisplayName}`);
  }
  if (userInfo.telegramUsername) {
    lines.push(`Telegram username: ${userInfo.telegramUsername}`);
  }
  if (userInfo.telegramUserId) {
    lines.push(`Telegram user ID: ${userInfo.telegramUserId}`);
  }
  if (userInfo.telegramLanguage) {
    lines.push(`Telegram language: ${userInfo.telegramLanguage}`);
  }
  if (userInfo.agentphoneHandle) {
    lines.push(`Text message handle: ${userInfo.agentphoneHandle}`);
  }
  return lines.join("\n");
}

function buildAppendSystemPrompt(args: {
  readonly stable: PiStableContextPromptProjection;
  readonly userInfo: UserInfo;
  readonly triggerSource: TriggerSource;
}): string {
  return [
    args.stable.agentIdentity,
    args.stable.executionLimit,
    args.stable.tools,
    buildCurrentUserPrompt(args.userInfo, args.triggerSource),
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

function buildStableAgentPrompt(args: {
  readonly privateArtifactsEnabled: boolean;
  readonly agent: AgentRunRecord;
  readonly triggerSource: TriggerSource;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly browserNativeInputEnabled: boolean;
  readonly bankingEnabled: boolean;
  readonly vncEnabled: boolean;
  readonly larkEnabled: boolean;
  readonly discordEnabled: boolean;
  readonly deliveryFormatGuidanceEnabled: boolean;
  readonly presentationConvertEnabled: boolean;
  readonly customConnectorMcpEnabled: boolean;
}): PiStableContextPromptProjection {
  observeStableAgentPromptBuild();
  return {
    agentIdentity: buildAgentIdentityPrompt(args.agent) ?? "",
    executionLimit: buildExecutionTimeLimitPrompt(),
    tools: buildAgentToolsPrompt({
      privateArtifactsEnabled: args.privateArtifactsEnabled,
      triggerSource: args.triggerSource,
      cloudBrowserEnabled: args.cloudBrowserEnabled,
      browserNativeInputEnabled: args.browserNativeInputEnabled,
      bankingEnabled: args.bankingEnabled,
      vncEnabled: args.vncEnabled,
      larkEnabled: args.larkEnabled,
      discordEnabled: args.discordEnabled,
      deliveryFormatGuidanceEnabled: args.deliveryFormatGuidanceEnabled,
      presentationConvertEnabled: args.presentationConvertEnabled,
    }),
  };
}

function buildAgentRunPlatformEnvironment(args: {
  readonly agentId: string;
  readonly triggerSource: TriggerSource;
  readonly chatThreadId: string | undefined;
  readonly codexServiceTier: "fast" | "ultrafast" | undefined;
  readonly reasoningEffort?: ReasoningEffort | null;
}): Record<string, string> {
  const integrationByTriggerSource: Partial<Record<TriggerSource, string>> = {
    web: "web",
    agent: "web",
    slack: "slack",
    discord: "discord",
    teams: "teams",
    feishu: "feishu",
    lark: "lark",
    telegram: "telegram",
    agentphone: "phone",
    github: "github",
  };
  const currentIntegration = integrationByTriggerSource[args.triggerSource];
  return {
    OKOU_APP_URL: env("APP_URL"),
    OKOU_AGENT_ID: args.agentId,
    ...(currentIntegration
      ? { OKOU_CURRENT_INTEGRATION: currentIntegration }
      : {}),
    ...(args.reasoningEffort !== null && args.reasoningEffort !== undefined
      ? { OKOU_REASONING_EFFORT: args.reasoningEffort }
      : {}),
    // Chat-mode automation (and web) runs carry their thread id so the
    // in-sandbox CLI can bind a newly created automation to it (the create
    // flow reads $OKOU_CHAT_THREAD_ID when no thread is given).
    ...(args.chatThreadId
      ? {
          OKOU_CHAT_THREAD_ID: args.chatThreadId,
        }
      : {}),
    ...(args.codexServiceTier
      ? {
          OKOU_CODEX_SERVICE_TIER: args.codexServiceTier,
        }
      : {}),
  };
}

function agentRunTimingDimensions(args: {
  readonly origin: AgentRunOrigin;
  readonly command: AnyCreateAgentRunCommandArgs;
  readonly source?: AgentRunPreCreateSource;
}): ApiDispatchTimingDimensions {
  const apiStartSource =
    "queueFirstAssociation" in args.command ? "queue_event" : "request";
  return {
    agent_run_origin: args.origin,
    api_start_source: apiStartSource,
    ...(args.source ? { agent_run_pre_create_source: args.source } : {}),
  };
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

function agentRunOrigin(args: {
  readonly command: AnyCreateAgentRunCommandArgs;
}): AgentRunOrigin {
  if (args.command.agentRunMetadata?.workflowAutomationId) {
    return "workflow_automation";
  }
  return "direct";
}

function createRunBody(args: {
  readonly body: AgentRunCreateBody;
  readonly agent: AgentRunRecord;
  readonly userInfo: UserInfo;
  readonly stablePrompt: PiStableContextPromptProjection;
  readonly permissionPolicies: FirewallPolicies | null | undefined;
  readonly triggerSource: TriggerSource | undefined;
  readonly appendSystemPrompt: string | undefined;
  readonly standaloneIntegrationNote: string;
}) {
  const triggerSource = args.triggerSource ?? "web";
  const baseAppendSystemPrompt = buildAppendSystemPrompt({
    stable: args.stablePrompt,
    userInfo: args.userInfo,
    triggerSource,
  });
  return {
    prompt: args.body.prompt,
    agentId: args.agent.id,
    sessionId: args.body.sessionId,
    conversationId: args.body.conversationId,
    additionalVolumes: args.body.additionalVolumes,
    realAgentInPreview: args.body.realAgentInPreview,
    captureNetworkBodies: args.body.captureNetworkBodies,
    tools: args.body.tools,
    settings: args.body.settings,
    permissionPolicies: args.permissionPolicies ?? undefined,
    triggerSource,
    appendSystemPrompt: [
      baseAppendSystemPrompt,
      args.appendSystemPrompt,
      args.appendSystemPrompt ? "" : args.standaloneIntegrationNote,
    ]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: selectedAgentRunVariables(args.agent.id),
  };
}

export function selectedAgentRunVariables(agentId: string) {
  return { OKOU_AGENT_ID: agentId };
}

export function measureAgentRunPreCreate<T>(
  timing: ApiDispatchTimingCollector | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => T | Promise<T>,
  dimensions?: ApiDispatchTimingDimensionsInput,
): Promise<T> {
  return measureApiDispatchTiming(
    timing,
    actionType,
    "nested",
    operation,
    dimensions,
  );
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

interface AgentRunAfterBootstrap extends RunBootstrapContext {
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly timing: ApiDispatchTimingCollector;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly command: AgentRunIdentityCommand;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
}

export interface AgentRunAfterPreCreate extends AgentRunAfterBootstrap {
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

interface BuildCreateAgentRunArgsInput {
  /** One catalog snapshot per run, loaded by the entry point. */
  readonly catalog: ModelCatalog;
  readonly command: AnyCreateAgentRunCommandArgs;
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly userInfo: UserInfo;
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly permissionValidityHorizon: string | null;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly workflows: readonly RunWorkflowRef[];
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants: readonly AgentCustomConnectorGrant[];
  readonly customConnectorDefinitions: readonly CustomConnectorDefinitionVersion[];
  readonly timing: ApiDispatchTimingCollector;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
}

function emptyStablePrompt(): PiStableContextPromptProjection {
  return {
    agentIdentity: "",
    executionLimit: "",
    tools: "",
  };
}

/**
 * A run launched straight through the runs API has no conversational surface,
 * so nothing renders `# Current Integration` for the note to follow. Its
 * delivery rules still apply, so they close the caller-supplied prompt
 * instead. A run whose surface supplied an integration prompt already carries
 * the note inside that block.
 */
function standaloneIntegrationNote(args: BuildCreateAgentRunArgsInput): string {
  if (args.command.appendSystemPrompt) {
    return "";
  }
  return resolveIntegrationNotePrompt({
    triggerSource: args.command.triggerSource ?? "web",
    featureSwitchContext: args.featureSwitchContext,
  });
}

function buildStableRunPromptContext(args: BuildCreateAgentRunArgsInput): {
  readonly userInfo: UserInfo;
  readonly initialStablePrompt: PiStableContextPromptProjection;
  readonly piStableContext: NonNullable<CreateAgentRunArgs["piStableContext"]>;
} {
  const promptInputs = buildAgentToolsPromptInputs({
    featureSwitchContext: args.featureSwitchContext,
    triggerSource: args.command.triggerSource ?? "web",
    cloudBrowserEnabled: args.cloudBrowserEnabled,
  });
  const userInfo = { ...args.userInfo, ...args.command.userInfoExtras };
  const connectorScope = {
    allowedConnectorSlugs: args.allowedConnectorSlugs,
    allowedCustomConnectorIds: args.allowedCustomConnectorIds,
    customConnectorGrants: args.customConnectorGrants,
    customConnectorDefinitions: args.customConnectorDefinitions,
    workflows: args.workflows,
  };
  let stablePrompt: PiStableContextPromptProjection | undefined;
  const buildPrompt = () => {
    stablePrompt ??= buildStableAgentPrompt({
      ...promptInputs,
      agent: args.agent,
    });
    return stablePrompt;
  };
  let cacheIdentity:
    | ReturnType<
        NonNullable<CreateAgentRunArgs["piStableContext"]>["buildCacheIdentity"]
      >
    | undefined;
  const buildCacheIdentity = () => {
    if (cacheIdentity) {
      return cacheIdentity;
    }
    observeStableContextCacheIdentityBuild();
    const agentIdentity = buildAgentIdentityPrompt(args.agent) ?? "";
    cacheIdentity = {
      owner: {
        orgId: args.command.auth.orgId,
        userId: args.command.auth.userId,
        agentId: args.agent.id,
        resourceOwner: {
          orgId: args.agent.orgId,
          userId: args.agent.owner,
        },
      },
      variantDigest: piStableContextVariantDigest({
        triggerSource: promptInputs.triggerSource,
        cloudBrowserEnabled: promptInputs.cloudBrowserEnabled,
        connectorSource: "stored_agent",
      }),
      semantic: { promptInputs, connectorScope },
      source: {
        catalogIdentity:
          args.connectorCatalogSelection.kind === "scoped"
            ? piStableContextVariantDigest(
                args.connectorCatalogSelection.selection.catalogIdentity,
              )
            : null,
        catalogSourceId:
          args.connectorCatalogSelection.kind === "scoped"
            ? args.connectorCatalogSelection.selection.catalogIdentity.sourceId
            : null,
        agentIdentityDigest: piStableContextVariantDigest(agentIdentity),
        featurePromptDigest: piStableContextVariantDigest(promptInputs),
        permissionDigest: piStableContextVariantDigest(
          args.runPermissionPolicies ?? null,
        ),
        connectorScopeDigest: piStableContextVariantDigest(connectorScope),
        validityHorizon: args.permissionValidityHorizon,
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
      },
    };
    return cacheIdentity;
  };
  return {
    userInfo,
    initialStablePrompt: args.command.piExecution
      ? emptyStablePrompt()
      : buildPrompt(),
    piStableContext: {
      buildPrompt,
      buildCacheIdentity,
      dynamicAppendSystemPrompt: [
        buildCurrentUserPrompt(userInfo, promptInputs.triggerSource),
        args.command.appendSystemPrompt,
        standaloneIntegrationNote(args),
      ]
        .filter((part): part is string => {
          return Boolean(part);
        })
        .join("\n\n"),
    },
  };
}

export function buildCreateAgentRunArgs(
  args: BuildCreateAgentRunArgsInput,
): CreateAgentRunArgs {
  const command = args.command;
  const { userInfo, initialStablePrompt, piStableContext } =
    buildStableRunPromptContext(args);
  const productAgentExecutionPlan = {
    identity: "agent" as const,
    content: buildAgentExecutionConfig(args.agent.name),
  };
  return {
    ...selectedRunModelProviderArgs(
      command,
      args.agent,
      args.capturedPersonalSubscriptionAccount,
    ),
    catalog: args.catalog,
    body: createRunBody({
      body: command.body,
      agent: args.agent,
      userInfo,
      stablePrompt: initialStablePrompt,
      permissionPolicies: args.runPermissionPolicies,
      triggerSource: command.triggerSource,
      appendSystemPrompt: command.appendSystemPrompt,
      standaloneIntegrationNote: standaloneIntegrationNote(args),
    }),
    apiStartTime: command.apiStartTime,
    piStableContext,
    chatThreadId: command.chatThreadId,
    ...(command.connectorSourceId
      ? { connectorSourceId: command.connectorSourceId }
      : {}),
    ...(args.threadSessionResolution
      ? { threadSessionResolution: args.threadSessionResolution }
      : {}),
    platformEnvironment: buildAgentRunPlatformEnvironment({
      agentId: args.agent.id,
      triggerSource: command.triggerSource ?? "web",
      chatThreadId: command.chatThreadId,
      codexServiceTier: command.codexServiceTier,
      reasoningEffort: command.reasoningEffort,
    }),
    callbacks: command.callbacks,
    includeOkouTokenSecret: true,
    productAgentExecutionPlan,
    ...(args.authorizedRequestObservation
      ? {
          preloadedAgentExecutionObservation: {
            requestUserId: args.authorizedRequestObservation.userId,
            requestOrgId: args.authorizedRequestObservation.orgId,
            agentId: args.agent.id,
            ownerUserId: args.agent.owner,
            agentOrgId: args.agent.orgId,
          },
        }
      : {}),
    okouTokenComputerUseHostId: command.computerUseHostId,
    okouTokenCloudBrowserEnabled: args.cloudBrowserEnabled,
    enforceBuiltInCredits: true,
    injectSkillVolumes: { workflows: args.workflows },
    requiredOfficialWorkflowIds: command.requiredOfficialWorkflowIds,
    connectorScope: {
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      allowedCustomConnectorIds: args.allowedCustomConnectorIds,
      customConnectorGrants: args.customConnectorGrants,
      source: "stored_agent",
    },
    validateEnvironmentReferences: false,
    agentRunMetadata: {
      ...command.agentRunMetadata,
      codexServiceTier: command.codexServiceTier,
      reasoningEffort: command.reasoningEffort,
    },
    dispatchFailedCallbacks: command.dispatchFailedCallbacks,
    persistProducerRunBinding: async (tx, run) => {
      await command.persistProducerRunBinding?.(tx, run);
      // Pi memory Stage 1 is owned by chat-thread launches, not the run core.
      if (run.status === "pending" && command.chatThreadId) {
        await requestPiMemoryStage1DayForAdmittedRun(tx, run.runId);
      }
    },
    ...(command.agentRunModelPin
      ? { agentRunModelPin: command.agentRunModelPin }
      : {}),
    timing: args.timing,
    timingDimensions: agentRunTimingDimensions({
      origin: agentRunOrigin({
        command,
      }),
      command,
      source: command.agentRunPreCreateSource,
    }),
  };
}

const bootstrapMetadataRowKindSchema = z.enum([
  "user_info",
  "feature_switch",
  "builtin_connector",
  "custom_connector",
  "permission_grant",
]);

type BootstrapMetadataRowKind = z.output<typeof bootstrapMetadataRowKindSchema>;

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

export interface BootstrapMetadataQueryRow {
  readonly kind: BootstrapMetadataRowKind;
  readonly id: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly featureUserId: string | null;
  readonly switches: Record<string, boolean> | null;
  readonly detail: string | null;
  readonly action: FirewallPermissionGrantAction | null;
  readonly permissionNames: readonly string[] | null;
  readonly permissionBundleRef: string | null;
  readonly storageVersion: number | null;
  readonly skillStorageVersionId: string | null;
  readonly isMcp: boolean | null;
  readonly expiresAt: Date | null;
}

interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly slackDisplayName?: string;
  readonly slackUserId?: string;
  readonly feishuDisplayName?: string;
  readonly feishuOpenId?: string;
  readonly teamsUserDisplayName?: string;
  readonly teamsUserPrincipalName?: string;
  readonly teamsUserId?: string;
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
  readonly agentphoneHandle?: string;
}

export interface RunBootstrapContext extends AgentConnectorScopeSnapshot {
  readonly userInfo: UserInfo;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly workflows: readonly RunWorkflowRef[];
  readonly permissionGrants: readonly FirewallPermissionGrant[];
  readonly permissionValidityHorizon: string | null;
  readonly connectorCatalogMetadataSlugs: readonly ConnectorSlug[];
}

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

function permissionValidityHorizon(
  rows: readonly BootstrapMetadataQueryRow[],
): string | null {
  let horizon: Date | null = null;
  for (const row of rows) {
    if (
      row.kind === "permission_grant" &&
      row.expiresAt !== null &&
      (horizon === null || row.expiresAt.getTime() < horizon.getTime())
    ) {
      horizon = row.expiresAt;
    }
  }
  return horizon?.toISOString() ?? null;
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

export type AgentRunSelectionInput = Omit<
  AnyCreateAgentRunCommandArgs,
  "body" | "appendSystemPrompt" | "callbacks"
> & {
  readonly body: Omit<AgentRunCreateBody, "prompt">;
  readonly queueFirstAssociation?: CreateQueueFirstAgentRunCommandArgs["queueFirstAssociation"];
};
export interface AgentRunIdentityInput {
  readonly timing: ApiDispatchTimingCollector;
  readonly auth: CreateAgentRunCommandArgs["auth"];
  readonly agentId: string;
  readonly apiStartTime: number;
  readonly chatThreadId?: string;
  readonly expectedThreadAgentId?: string;
  readonly queueFirstAssociation?: CreateQueueFirstAgentRunCommandArgs["queueFirstAssociation"];
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
export type AgentRunIdentityCommand = Omit<
  AgentRunSelectionInput,
  "piExecution"
> & {
  readonly piExecution?: boolean;
};
export interface AgentRunGraphInput {
  readonly command: AgentRunIdentityCommand;
  readonly timing: ApiDispatchTimingCollector;
}

export function matchingAuthorizedRequestObservation(
  args: AgentRunIdentityCommand,
  agentId: string,
): AuthorizedAgentRunRequestObservation | undefined {
  const observation = args.authorizedRequestObservation;
  if (
    !observation ||
    observation.userId !== args.auth.userId ||
    observation.orgId !== args.auth.orgId ||
    observation.agent.id !== agentId ||
    observation.agent.orgId !== args.auth.orgId ||
    observation.featureSwitchContext.userId !== args.auth.userId ||
    observation.featureSwitchContext.orgId !== args.auth.orgId
  ) {
    return undefined;
  }
  return observation;
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
              agentRunsCreateORG_SENTINEL_USER_ID,
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

export function personalSubscriptionAccountCandidates(args: {
  readonly command: AgentRunIdentityCommand;
  readonly providerType: string;
  readonly modelProviderId: string | null;
  readonly snapshot?: MemberModelAccountSnapshot | null;
}) {
  const snapshot = args.snapshot;
  if (
    !snapshot ||
    snapshot.orgId !== args.command.auth.orgId ||
    snapshot.userId !== args.command.auth.userId ||
    !isPersonalSubscriptionProviderType(args.providerType)
  ) {
    return undefined;
  }
  return snapshot.accounts.filter((account) => {
    if (
      account.disconnectedAt !== null ||
      account.orgId !== snapshot.orgId ||
      account.userId !== snapshot.userId
    ) {
      return false;
    }
    const activeType = account.type === args.providerType && account.isActive;
    return args.modelProviderId === null
      ? activeType
      : account.id === args.modelProviderId ||
          (account.modelProviderId === args.modelProviderId && activeType);
  });
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

export function selectedRunPiExecution(
  command: AgentRunIdentityCommand,
): boolean {
  if (command.piExecution === undefined) {
    throw new Error("Selected model execution eligibility is unavailable");
  }
  return command.piExecution;
}

export function selectedRunModelProviderArgs(
  command: AgentRunIdentityCommand,
  agent: AgentRunRecord,
  capturedPersonalSubscriptionAccount:
    | CapturedPersonalSubscriptionAccount
    | undefined,
): Omit<RunModelProviderArgs, "catalog"> {
  return {
    orgId: command.auth.orgId,
    userId: command.auth.userId,
    modelProviderId:
      command.modelProviderId ?? optionalAgentSetting(agent.modelProviderId),
    modelProviderCredentialScope: command.modelProviderCredentialScope,
    modelProviderType: command.body.modelProvider,
    capturedPersonalSubscriptionAccount,
    selectedModelOverride:
      command.selectedModelOverride ??
      optionalAgentSetting(agent.selectedModel),
    builtInModelRuntimeRoute: command.builtInModelRuntimeRoute,
    piExecution: selectedRunPiExecution(command),
    codexServiceTier: command.codexServiceTier,
    agentRunMetadata: { reasoningEffort: command.reasoningEffort },
    ...("queueFirstAssociation" in command
      ? { queueFirstAssociation: command.queueFirstAssociation }
      : {}),
  };
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
      secretNames: runEnvironmentSecretNames(
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

type RunStorageExecution = Pick<
  ResolvedRunExecution,
  | "orgId"
  | "content"
  | "artifacts"
  | "agentSessionId"
  | "persistedStorageMounts"
  | "previousRunStorageMounts"
  | "additionalVolumes"
>;

export function selectedRunStorageExecution(
  agent: AgentRunRecord,
  session: ChatThreadSessionResolution | undefined,
): RunStorageExecution | CreateRunErrorResult {
  const common = {
    orgId: agent.orgId,
    content: buildAgentExecutionConfig(agent.name),
  };
  if (!session?.sessionId) {
    return { ...common, artifacts: [] };
  }
  const snapshot = session.executionSnapshot;
  if (!snapshot) {
    return notFound("Agent session not found");
  }
  if (!snapshot.agent) {
    return notFound("Agent not found");
  }
  return {
    ...common,
    ...resolvedSessionStorage(snapshot.session),
    agentSessionId: session.sessionId,
    previousRunStorageMounts: session.resetNativeSession
      ? undefined
      : (snapshot.previousRun?.storageMounts ?? undefined),
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
