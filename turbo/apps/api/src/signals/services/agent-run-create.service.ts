import { requestPiMemoryStage1Day } from "./pi-memory-stage1-schedule.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
} from "@okouai/pi-agent-runtime/api";
import { isPiNativeModel } from "@okouai/core/pi-execution";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import {
  assertPiNativeCredential,
  materializePiExecutionRoute,
  normalizePiExecutionRoute,
  type PiExecutionRoute,
} from "@okouai/pi-agent-runtime";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  type PiModelConfigV4,
} from "@okouai/api-contracts/contracts/pi-native";
import { piNativeFirewall } from "@okouai/api-contracts/contracts/pi-native-firewall";
import {
  getOpenRouterBaseUrl,
  OPENROUTER_US_ORIGIN,
} from "@okouai/api-contracts/contracts/openrouter-routing";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { isUnsupportedRunAdmission } from "./run-admission-input";
import { createHash, randomUUID } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type PiMemoryRecallSelection,
  type PiMemoryPhase2Maintenance,
  type PiLaunchConfig,
  type PiApiFirstTurnConfig,
  type PiModelConfig,
  type PiModelConfigLegacy,
  type ConnectorRuntimeTargetRegistration,
  PI_MEMORY_ROOT,
  piMemoryRecallSelectionSchema,
  PI_SKILLS_ROOT,
  type SecretConnectorMetadata,
  type StorageMountEntry,
  type StoredConnectorPermissionBaseline,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { customConnectorSlugSchema } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { modelProviderSurfaceProtocolSchema } from "@okouai/api-contracts/contracts/model-provider-gateways";
import {
  getDefaultModel,
  getModelProviderCodexCatalogForModel,
  getModelProviderCodexRuntimeConfig,
  getModelProviderEnvBindings,
  getModelImageInputSupport,
  getFrameworkForType,
  getProviderRuntimeModel,
  getSecretNameForType,
  getSecretsForAuthMethod,
  getBuiltInConcreteProviderType,
  hasAuthMethods,
  isBuiltInModelProviderType,
  isSupportedRunModel,
  MODEL_PROVIDER_TYPES,
  normalizeRunModelId,
  type ModelProviderCodexRuntimeConfig,
  type ModelProviderEnvBindings,
  type ModelProviderCredentialScope,
  getModelProviderFirewall,
  type ModelProviderType,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@okouai/connectors/connector-auth-method";
import type {
  ConnectorServerFirewallExecutionMetadata,
  ConnectorServerFirewallPermissionIndex,
} from "./connector-server-firewall-catalog.service";
import {
  canonicalizeFirewallBaseUrlVarsForExecution,
  extractSecretNamesFromApis,
  type ExecutionFirewallEntry,
  type ExecutionFirewallInlineEntry,
  type ExecutionFirewalls,
  type ExpandedFirewallConfig,
  FirewallBaseUrlResolutionError,
  type Firewall,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicies,
  type NetworkPolicy,
  canonicalizeFirewallBaseUrl,
  validateBaseUrlHostPolicy,
} from "@okouai/connectors/firewall-types";
import {
  type CreateRunResponse,
  type RunStatus,
  unifiedRunRequestSchema,
} from "@okouai/api-contracts/contracts/runs";
import {
  isSupportedFramework,
  type SupportedFramework,
} from "@okouai/core/frameworks";
import {
  getAllFeatureStates,
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { isStaffOrg } from "@okouai/core/staff-org";
import {
  DEFAULT_IMAGE_MODEL_ENV,
  IMAGE_MODEL_CONFIGS,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { resolveSkillRef, parseGitHubTreeUrl } from "@okouai/core/github-url";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
  getSkillStorageName,
  MEMORY_ARTIFACT_NAME,
} from "@okouai/core/storage-names";
import { INTRO_VIDEO_SKILL_NAME, SEED_SKILLS } from "@okouai/core/seed-skills";
import {
  expandVariables,
  expandVariablesInString,
  extractAndGroupVariables,
} from "@okouai/core/variable-expander";
import { expandMountPath } from "@okouai/api-contracts/contracts/agents";
import type {
  AgentExecutionArtifact,
  AgentExecutionConfig,
  AgentExecutionDefinition,
} from "./agent-execution-config";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type {
  AgentRunFullLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { conversations } from "@okouai/db/schema/conversation";
import { blobs } from "@okouai/db/schema/blob";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { secrets as secretsTable } from "@okouai/db/schema/secret";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { variables } from "@okouai/db/schema/variable";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";
import { z } from "zod";
import { env, optionalEnv } from "../../lib/env";
import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
  pgNullDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { VERCEL_AUTOMATION_BYPASS_ENV } from "../../lib/preview-automation-bypass";
import { previewAutomationBypass$ } from "../context/hono";
import {
  systemSkillStorageResolution$,
  type SystemSkillStorageResolution,
} from "../context/system-skill-storage-resolution";
import { writeDb$, type Db } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { now, nowDate } from "../../lib/time";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import {
  isPiLangfuseDebugRunEnvironment,
  piLangfuseDebugPlatformEnvironment,
  resolvePiLangfuseDebugConfig,
} from "../../lib/pi-langfuse-debug";
import { generateOkouToken } from "../auth/tokens";
import { joinAll, onRejection, safeSync, settle, tapError } from "../utils";
import {
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  featureFlagsRecordToEntries,
  networkPoliciesRecordToEntries,
  type RunContextAxiomSnapshot,
} from "./run-context-snapshot.service";
import {
  decryptStoredSecretValue,
  encryptPersistentSecretValue,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import {
  compileModelProviderGatewayRuntime,
  GATEWAY_RUNTIME_SECRET_NAME,
} from "./model-provider-gateway-runtime";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
  CustomConnectorRuntimePrefixError,
  customConnectorInternalName,
  customConnectorManualAuthReferencesMemberField,
  customConnectorMissingRequiredFieldKeys,
  customConnectorPrefixTemplateVariableKeys,
  customConnectorValueMarkerKey,
  loadCustomConnectorRuntimeData,
  renderCustomConnectorRuntimePrefix,
  renderTemplateForRuntime,
  type StoredValueRow,
} from "./custom-connector.service";
import {
  loadCustomConnectorPermissionBundleDependencySlugs,
  loadCustomConnectorPermissionBundle,
  type CustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";
import {
  resolveAgentRunStorage,
  materializeAgentRunStorage,
  type ResolvedAgentRunStorage,
  type StorageMountMetadata,
  OfficialWorkflowArtifactResolutionError,
  type PreparedAgentRunStorage,
  StorageManifestBuildStats,
  type StorageManifestSource,
} from "./agent-run-storage.service";
import type { RunWorkflowRef } from "./workflow-data.service";
import {
  acquireOfficialWorkflowRunCatalogAdmissionLock,
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
  OfficialWorkflowRunAdmissionError,
  resolveOfficialWorkflowRunObservation,
  validateOfficialWorkflowRunForInsert,
  type OfficialWorkflowRunObservation,
} from "./official-workflow-run.service";
import { projectLegacyWritebackArtifacts } from "./storage-legacy-projection.service";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "./agent-run-queue-payload.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { resolvePiSandboxModelConfig } from "./pi-sandbox-config";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import {
  piResourceDiscoveryMounts,
  piResourceSnapshotDigest,
} from "./pi-resource-snapshot.service";
import { readMemorySummaryProjection } from "./memory-summary-projection.service";
import {
  PI_API_FIRST_TURN_COORDINATION_TIMEOUT_MS,
  piApiFirstTurnObjectKey,
  requirePiApiFirstTurnExecutionContext,
} from "./pi-api-first-turn-config";
import { lockModelProviderState } from "./auth-state-lock.service";
import {
  activePersonalModelProviderAccount,
  ensurePersonalModelProviderAccount,
  coordinatePersonalSubscriptionCredentials,
  preparePersonalSubscriptionAdmission,
  validatePersonalSubscriptionAdmission,
  type PreparedPersonalSubscriptionAdmission,
  isPersonalSubscriptionProviderType,
  personalModelProviderAccountById,
} from "./model-provider-account.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import {
  connectorRuntimeCredentialStatusWithMethod,
  type ConnectorCredentialStatus,
} from "./connector-credential-status.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSelection,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import {
  connectorCredentialSecretReadCondition,
  resolveConnectorCredentialAccess,
  type ConnectorCredentialAccess,
  type ConnectorCredentialReadGroup,
} from "./connector-credential-access.service";
import {
  connectorAccountTargetKey,
  resolveConnectorAccounts,
} from "./connector-account-resolution.service";
import { resolveChatThreadConnectorSelections } from "./chat-thread-connector-selection.service";
import {
  defaultFirewallPolicyForPermissionIndex,
  networkPolicyForFirewallPolicy,
} from "./firewall-network-policy.service";
import { currentConnectorCatalogValidatorIdentity } from "./connector-catalog-validator-authority";
import { logger } from "../../lib/log";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { piPreparationObserver } from "./pi-preparation-timing.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import type {
  ChatThreadSessionResolution,
  ChatThreadSessionResolutionAction,
} from "./chat-session-continuity.service";
import {
  claimQueueFirstRunAssociation,
  resolveQueueFirstRunAdmission,
  type QueueFirstRunAdmission,
  type QueueFirstRunAssociation,
  type QueueFirstRunClaimResult,
  type QueueFirstRunSessionSnapshotState,
} from "./chat-queued-event.service";
import { recordFirstAssistantEventEligibility } from "./chat-first-assistant-event-metric.service";
import { bindPiMemoryPhase2MaintenanceRun } from "./pi-memory-phase2-maintenance.service";
import { isWebChatTriggerSource } from "./chat-trigger-source.service";
import { resolveMediaModelsForRun } from "./run-media-model.service";
import {
  cappedBaseConcurrencyLimit,
  loadOrgConcurrencyState,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  checkOrgPlanRunAdmission,
  checkOrgCreditsForRunAdmission,
  checkResolvedOrgCreditsForRunAdmission,
  resolveOrgCreditAvailability,
} from "./run-admission.service";
import { activateUsageAllowanceWindowsForRun } from "./usage-allowance.service";
import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import {
  isCompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
  type CompressedSessionHistoryBlobEncoding,
} from "./session-history-blobs";
import type { Tx } from "../../lib/db-types";
import type { PiPreparationDiscardReason } from "./pi-api-first-turn-preparation";
import { waitUntil } from "../context/wait-until";
import { prepareConfiguredPiApiFirstTurn$ } from "./pi-api-first-turn-dispatch.service";
import { activatePendingRun$ } from "./agent-run-activation.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import {
  normalizeRunMetadata,
  type RunMetadataValues,
} from "./agent-run-metadata-write.service";
import {
  builtInModelRuntimeTarget,
  type BuiltInModelRuntimeRoute,
} from "./built-in-model-runtime-route.service";

import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "./session-compatibility";

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const AUTO_MEMORY_ARTIFACT_NAME = MEMORY_ARTIFACT_NAME;
type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;
const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";

function getEffectiveConcurrencyLimit(
  baseLimit: number,
  paidSlots: number,
): number {
  const limit = totalConcurrencyLimit({
    baseLimit: cappedBaseConcurrencyLimit(baseLimit),
    paidSlots,
  });
  return Number.isFinite(limit) ? limit : 0;
}

const ORG_SENTINEL_USER_ID = "__org__";
const L = logger("AgentRunCreate");
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
const MERCURY_NOT_A_BANK_DISCLOSURE =
  "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.";
const MERCURY_RESPONSE_DISCLOSURE_PROMPT = [
  "# Mercury Account Data Disclosure",
  "",
  "When a response displays or summarizes any data retrieved through the Mercury connector, including account details, balances, or transactions, include both of the following:",
  "- [Powered by Mercury](https://mercury.com)",
  `- ${MERCURY_NOT_A_BANK_DISCLOSURE}`,
  "",
  "Do not include this disclosure when the response does not present Mercury-sourced data.",
].join("\n");
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
    "# MCP Custom Connectors",
    "",
    "The following MCP Custom Connectors were admitted when this Run started:",
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
  return withOkouTokenSecret(body, "__pending_okou_token__");
}

function defaultImageModelPrompt(model: ImageModel): string {
  const alias = IMAGE_MODEL_CONFIGS[model].alias;
  return [
    "# Default built-in image model",
    "",
    `This run's default built-in image model is \`${alias}\`.`,
    "- Only when the current user request explicitly names another supported built-in image model, pass `--model <model>`.",
    `- Otherwise omit \`--model\`; the server applies \`${alias}\`.`,
    "- Image generation through a connected third-party service chooses its model separately; this default does not apply to that path.",
  ].join("\n");
}

function withDefaultImageModelPlatformEnvironment(
  platformEnvironment: Record<string, string> | undefined,
  model: ImageModel | null,
): Record<string, string> | undefined {
  if (model === null) {
    return platformEnvironment;
  }
  return {
    ...platformEnvironment,
    [DEFAULT_IMAGE_MODEL_ENV]: IMAGE_MODEL_CONFIGS[model].alias,
  };
}

function withFinalRunAppendSystemPrompt(args: {
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly chatThreadId: string | undefined;
  readonly imageRecognitionAvailable: boolean;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly mcpConnectorSlugs: readonly string[];
  readonly selectedImageModel: ImageModel | null;
  readonly cliAvailable: boolean;
}): CreateRunBody {
  const appendedParts: string[] = [];
  if (args.cliAvailable) {
    const mcpConnectorPrompt = buildMcpConnectorPrompt(args.mcpConnectorSlugs);
    if (mcpConnectorPrompt) {
      appendedParts.push(mcpConnectorPrompt);
    }
  }
  if (args.connectorSlugs.includes("mercury")) {
    appendedParts.push(MERCURY_RESPONSE_DISCLOSURE_PROMPT);
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
  if (args.selectedImageModel !== null) {
    appendedParts.push(defaultImageModelPrompt(args.selectedImageModel));
  }
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

interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

interface RunArtifacts {
  readonly artifacts: readonly ContextArtifact[];
}

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly baselineCandidate?: true;
  readonly expectedStorageId?: string;
}

type AdditionalVolumeSources = readonly StorageManifestSource[] | undefined;

interface PreparedAdditionalVolume {
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
}

interface PreparedAdditionalVolumes {
  readonly volumes: readonly AdditionalVolume[] | undefined;
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
  readonly content: AgentExecutionConfig;
  readonly artifacts: readonly ContextArtifact[];
  readonly vars?: Record<string, string>;
  readonly volumeVersions?: Record<string, string>;
  readonly additionalVolumes?: readonly AdditionalVolume[];
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
  readonly previousRunStorageMounts?: readonly PersistedStorageMount[];
  readonly agentSessionId?: string;
  readonly continuedFromAgentSessionId?: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
  readonly resumeSessionIdentity?: SessionExecutionIdentity;
}

interface ResolvedPrivateMaintenanceExecution extends Omit<
  ResolvedAgentExecution,
  "agentId"
> {
  readonly agentId: null;
}

type ResolvedRunExecution =
  | ResolvedAgentExecution
  | ResolvedPrivateMaintenanceExecution;

interface ProductAgentExecutionPlan {
  readonly identity: "agent" | "pi-memory-phase2-maintenance";
  readonly content: AgentExecutionConfig;
}

interface ProductResolutionOptions {
  readonly executionPlan: ProductAgentExecutionPlan;
  readonly timing?: ApiDispatchTimingCollector;
}

interface ResolveAgentExecutionOptions {
  readonly productAgentExecutionPlan?: ProductAgentExecutionPlan;
  readonly testOnlyResolveDirectRun?: TestOnlyDirectRunResolver;
  readonly timing?: ApiDispatchTimingCollector;
}

type TestOnlyDirectRunResolver = (args: {
  readonly db: Db;
  readonly body: CreateRunBody;
  readonly userId: string;
  readonly orgId: string;
  readonly timing?: ApiDispatchTimingCollector;
}) => Promise<ResolvedAgentExecution | CreateRunErrorResult>;

type ConnectorScopeSource = "explicit" | "stored_agent" | "empty";

interface EffectiveConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants:
    | readonly AgentCustomConnectorGrant[]
    | undefined;
  readonly source: ConnectorScopeSource;
}

interface ThreadConnectorSelectionIds {
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

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
  readonly status: "pending" | "queued";
}

interface LaunchRunIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly shouldCreateSession: boolean;
}

type LaunchRunStatus = "pending" | "queued" | "failed";

type ThreadSessionBindingAction = ChatThreadSessionResolutionAction;

interface ThreadSessionBindingWrite {
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly action: ThreadSessionBindingAction;
}

type PersistedAtomicLaunchRows =
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly runnerJobCreatedAt: Date;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | {
      readonly kind: "queued";
      readonly run: RunRecord;
      readonly queueDepth: number;
      readonly telemetryTimestamp: string;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    };

type RunnerJobPayload = ReturnType<typeof queuedRunnerJobPayload>;
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

export interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

interface ThreadSessionSnapshotStale {
  readonly kind: "thread-session-snapshot-stale";
  readonly chatThreadId: string;
  readonly agentSessionId: string;
  readonly agentSessionRunId: string;
  readonly resolutionAction: ChatThreadSessionResolutionAction;
  readonly reason: "binding_changed" | "session_changed";
}

interface ValidatedThreadSessionSnapshot {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly agentSessionId: string | null;
}

type AtomicLaunchCommitResult =
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly runnerJobPayload: RunnerJobPayload;
      readonly runnerJobCreatedAt: Date;
      readonly runContextSnapshot: RunContextAxiomSnapshot;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | {
      readonly kind: "queued";
      readonly run: RunRecord;
      readonly runnerJobPayload: RunnerJobPayload;
      readonly queueDepth: number;
      readonly telemetryTimestamp: string;
      readonly runContextSnapshot: RunContextAxiomSnapshot;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
      readonly threadSessionBinding: ThreadSessionBindingWrite | undefined;
    }
  | {
      readonly kind: "queue-payload-required";
    }
  | ThreadSessionSnapshotStale
  | QueueFirstRunClaimLost;
type QueuePayloadRequiredResult = Extract<
  AtomicLaunchCommitResult,
  { readonly kind: "queue-payload-required" }
>;
type AtomicLaunchCommitAttempt =
  | AtomicLaunchCommitResult
  | CreateRunErrorResult;
interface AtomicLaunchCommitCompletion {
  readonly result: AtomicLaunchCommitAttempt;
  readonly transactionReturnedAt: number;
}
type CommitAtomicLaunch = (
  encryptedQueuedParams: string | undefined,
) => Promise<AtomicLaunchCommitCompletion>;
type CommittedAtomicLaunchResult = Exclude<
  AtomicLaunchCommitResult,
  | { readonly kind: "queue-payload-required" }
  | QueueFirstRunClaimLost
  | ThreadSessionSnapshotStale
>;

type FailedLaunchCommitResult =
  | {
      readonly kind: "failed";
      readonly createdAt: Date;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
    }
  | QueueFirstRunClaimLost
  | CreateRunErrorResult;

export interface AgentRunModelPin {
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
};

type QueueFirstAgentRunResult =
  | CreateRunSuccessResult
  | CreateRunErrorResult
  | QueueFirstRunClaimLost
  | ThreadSessionSnapshotStale;

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

export function isThreadSessionSnapshotStale(
  result: unknown,
): result is ThreadSessionSnapshotStale {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "thread-session-snapshot-stale"
  );
}

interface CommitPreparedLaunchArgs {
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly creditAdmitted: boolean;
  readonly context: FinalizedPreparedRunContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly launch: PreparedRunnerLaunch;
  readonly encryptedQueuedParams: string | undefined;
  readonly subscriptionAdmission: PreparedPersonalSubscriptionAdmission | null;
  readonly timing: ApiDispatchTimingCollector;
}

interface HttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

type RunCallback = HttpRunCallback | InternalRunCallback;

interface ResolvedModelProviderEnvironment {
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
  readonly modelUsageProvider: SupportedRunModel | undefined;
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

type CreateRunRouteResult =
  | CreateRunSuccessResult
  | ApiErrorResponse<400, "BAD_REQUEST">
  | ApiErrorResponse<403, "FORBIDDEN">
  | ApiErrorResponse<404, "NOT_FOUND">
  | ApiErrorResponse<409, "CONFLICT">
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<429, "CONCURRENT_RUN_LIMIT">
  | ApiErrorResponse<503, "PROVIDER_UNAVAILABLE">;

type CreateRunErrorResult = Exclude<
  CreateRunRouteResult,
  { readonly status: 201 }
>;

export type DispatchFailedRunCallbacks = (
  db: Db,
  runId: string,
  error: string,
) => Promise<void>;

export interface CreateAgentRunArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier?: "fast";
  readonly callbacks?: readonly RunCallback[];
  readonly chatThreadId?: string;
  /** Exact connector that delivered this run's durable integration input. */
  readonly connectorSourceId?: string;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly includeOkouTokenSecret?: boolean;
  readonly productAgentExecutionPlan?: ProductAgentExecutionPlan;
  /**
   * Retired direct-run test support. Production callers must supply a canonical
   * productAgentExecutionPlan; keeping legacy reads in the test fixture
   * preserves historical runner coverage without restoring a runtime dual-read.
   */
  readonly testOnlyResolveDirectRun?: TestOnlyDirectRunResolver;
  readonly okouTokenComputerUseHostId?: string;
  readonly okouTokenCloudBrowserEnabled?: boolean;
  /** Immutable Intro Video eligibility captured with the caller's switch context. */
  readonly introVideoEnabled?: boolean;
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
  readonly queueOnConcurrencyLimit?: boolean;
  readonly enforceBuiltInCredits?: boolean;
  readonly dispatchFailedCallbacks?: DispatchFailedRunCallbacks;
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
  readonly agentRunModelPin?: AgentRunModelPin;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  /** Private non-interactive Pi memory maintenance input and claim fence. */
  readonly piMemoryPhase2Maintenance?: PiMemoryPhase2Maintenance;
  /** In-memory private admission fence; never serialized into run metadata. */
  readonly validatePiMemoryPhase2Admission?: (tx: Tx) => Promise<void>;
  readonly timing?: ApiDispatchTimingCollector;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
}

function timingDimensionsForCreateArgs(
  args: CreateAgentRunArgs,
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

interface ConnectorRuntimeContext {
  readonly secrets: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly connectorSourceIdBySlug: Readonly<Record<string, string>>;
  readonly storedEnvironment: Record<string, string> | undefined;
}

interface PersistedRunEnvironmentSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly userId: string;
}

interface PersistedRunEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

interface PersistedRunEnvironmentSnapshot {
  readonly secrets: readonly PersistedRunEnvironmentSecret[];
  readonly variables: readonly PersistedRunEnvironmentVariable[];
}

const persistedRunEnvironmentRowKindDecoder = zodEnumDriverValueDecoder(
  z.enum(["variable", "secret"]),
);

interface CustomConnectorRuntimeContext {
  readonly firewalls: readonly ExpandedFirewallConfig[];
  readonly reservedSecretAliases: Record<string, true> | undefined;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
  readonly customConnectorIdByFirewallName: Readonly<Record<string, string>>;
  readonly customConnectorSourceIdByFirewallName: Readonly<
    Record<string, string>
  >;
  readonly mcpConnectorSlugs: readonly string[];
  readonly skills: readonly {
    readonly connectorId: string;
    readonly connectorSlug: string;
    readonly versionId: string;
  }[];
}

function emptyCustomConnectorRuntimeContext(): CustomConnectorRuntimeContext {
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

function insufficientCredits(): ApiErrorResponse<402, "INSUFFICIENT_CREDITS"> {
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

function concurrentRunLimit(): ApiErrorResponse<429, "CONCURRENT_RUN_LIMIT"> {
  return {
    status: 429,
    body: {
      error: {
        message: "Concurrent run limit reached",
        code: "CONCURRENT_RUN_LIMIT",
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
  volumes: readonly AdditionalVolume[] | undefined,
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
): readonly AdditionalVolume[] {
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

function officialWorkflowRunCandidates(
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
    readonly introVideoEnabled: boolean;
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
    ...(args.introVideoEnabled
      ? buildLegacySystemSkillVolumes(
          [INTRO_VIDEO_SKILL_NAME],
          skillsRoot,
          args.systemSkillStorageResolution,
        ).map((volume) => {
          return { volume, source: "system_skill" as const };
        })
      : []),
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

function isRouteError(value: unknown): value is CreateRunErrorResult {
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
  content: AgentExecutionConfig,
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
  content: AgentExecutionConfig,
): SupportedFramework | null {
  const framework = firstAgent(content)?.framework;
  if (!isSupportedFramework(framework)) {
    return null;
  }
  return framework;
}

function modelProviderFramework(
  modelProvider: ResolvedModelProviderEnvironment,
): SupportedFramework {
  return getFrameworkForType(modelProvider.concreteType ?? modelProvider.type);
}

function frameworkForProviderSelection(
  providerType: ModelProviderType,
  selectedModel: string | null | undefined,
): SupportedFramework | null {
  if (!isBuiltInModelProviderType(providerType)) {
    return getFrameworkForType(providerType);
  }
  const builtInModel =
    selectedModel ?? MODEL_PROVIDER_TYPES["built-in"].defaultModel;
  if (!builtInModel) {
    return null;
  }
  return getFrameworkForType(getBuiltInConcreteProviderType(builtInModel));
}

async function resolveRequestedRunFramework(
  db: Db,
  args: CreateAgentRunArgs,
  composeFramework: SupportedFramework,
): Promise<SupportedFramework> {
  if (args.modelProviderType && isModelProviderType(args.modelProviderType)) {
    return (
      frameworkForProviderSelection(
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
      provider.type,
      args.selectedModelOverride ?? provider.selectedModel,
    ) ?? composeFramework
  );
}

function frameworkApiKeyEnv(framework: SupportedFramework): string {
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
): ContextArtifact {
  return withAutoMemoryMissingRootPolicy({
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: autoMemoryMountPath(framework, piSandbox),
  });
}

function isCanonicalAutoMemoryArtifact(
  artifact: ContextArtifact,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME &&
    artifact.mountPath === autoMemoryMountPath(framework, piSandbox)
  );
}

function withAutoMemoryMissingRootPolicy(
  artifact: ContextArtifact,
): ContextArtifact {
  return {
    ...artifact,
    missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
  };
}

function withCanonicalAutoMemoryMissingRootPolicy(
  artifacts: readonly ContextArtifact[],
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): readonly ContextArtifact[] {
  return artifacts.map((artifact) => {
    return isCanonicalAutoMemoryArtifact(artifact, framework, piSandbox)
      ? withAutoMemoryMissingRootPolicy(artifact)
      : artifact;
  });
}

function claimsAutoMemorySlot(
  artifact: ContextArtifact,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): boolean {
  return (
    artifact.name === AUTO_MEMORY_ARTIFACT_NAME ||
    artifact.mountPath === autoMemoryMountPath(framework, piSandbox)
  );
}

function withoutSupersededAutoMemoryArtifacts(
  artifacts: readonly ContextArtifact[],
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
  slotOwnerIndex: number,
): readonly ContextArtifact[] {
  return artifacts.filter((artifact, index) => {
    return (
      index >= slotOwnerIndex ||
      !isCanonicalAutoMemoryArtifact(artifact, framework, piSandbox)
    );
  });
}

function resolveAgentExecutionArtifactMountPath(
  artifact: AgentExecutionArtifact,
): string {
  return expandMountPath(artifact.mount_path);
}

function composeArtifacts(
  content: AgentExecutionConfig,
): readonly ContextArtifact[] {
  return (content.artifacts ?? []).map((artifact) => {
    return {
      name: artifact.name,
      version: artifact.version,
      mountPath: resolveAgentExecutionArtifactMountPath(artifact),
    };
  });
}

function withPinnedPiContinuationMemory(
  artifacts: readonly ContextArtifact[],
  previousRunStorageMounts: readonly PersistedStorageMount[] | undefined,
): readonly ContextArtifact[] {
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
  readonly resolved: ResolvedRunExecution;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly includeAutoMemory: boolean;
  readonly bodyArtifacts: readonly ContextArtifact[] | undefined;
}): RunArtifacts {
  const isContinuation = Boolean(args.resolved.agentSessionId);
  const composeContextArtifacts = isContinuation
    ? []
    : composeArtifacts(args.resolved.content);
  const unpinnedBaseArtifacts = isContinuation
    ? args.resolved.artifacts
    : [...composeContextArtifacts, ...args.resolved.artifacts];
  const baseArtifacts =
    isContinuation && args.piSandbox !== undefined && args.includeAutoMemory
      ? withPinnedPiContinuationMemory(
          unpinnedBaseArtifacts,
          args.resolved.previousRunStorageMounts,
        )
      : unpinnedBaseArtifacts;
  const bodyArtifacts = args.bodyArtifacts ?? [];
  const artifacts = [...baseArtifacts, ...bodyArtifacts];
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

function runnerGroup(content: AgentExecutionConfig): string | null {
  return firstAgent(content)?.experimental_runner?.group ?? null;
}

function runnerProfile(content: AgentExecutionConfig): string {
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
  readonly content: AgentExecutionConfig;
  readonly additionalEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const environment = firstAgent(args.content)?.environment;
  return mergeRecords(args.additionalEnvironment, environment);
}

function expandEnvironment(args: {
  readonly content: AgentExecutionConfig;
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
  readonly content: AgentExecutionConfig;
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
  readonly content: AgentExecutionConfig;
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

function hasExplicitFrameworkApiKey(
  content: AgentExecutionConfig,
  framework: SupportedFramework,
): boolean {
  return (
    firstAgent(content)?.environment?.[frameworkApiKeyEnv(framework)] !==
    undefined
  );
}

function isModelProviderType(type: string): type is ModelProviderType {
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
  if (providerConfig || !args.logicalModel || !args.runtimeModel) {
    return providerConfig;
  }
  const modelCatalog = getModelProviderCodexCatalogForModel(
    args.logicalModel,
    args.runtimeModel,
    args.type,
  );
  if (!modelCatalog) {
    return undefined;
  }
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
    supportsWebsockets: false,
    modelCatalog,
  };
}

function modelProviderEnvironment(args: {
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
  const runtimeModel = model ? getProviderRuntimeModel(args.type, model) : "";
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
        ? getProviderRuntimeModel(args.type, selectedModel)
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

async function multiAuthModelProviderEnvironment(
  db: Db,
  args: {
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
  },
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.authMethod) {
    return null;
  }
  const secretConfig = getSecretsForAuthMethod(args.type, args.authMethod);
  if (!secretConfig) {
    return null;
  }

  const firewall = getModelProviderFirewall(args.type);
  const hasFirewallAuth = firewall !== undefined;
  const secretRows = args.accountId
    ? await db
        .select({
          name: modelProviderAccountSecrets.name,
          encryptedValue: hasFirewallAuth
            ? sql`NULL`.mapWith(pgNullDecoder)
            : modelProviderAccountSecrets.encryptedValue,
        })
        .from(modelProviderAccountSecrets)
        .where(
          eq(
            modelProviderAccountSecrets.modelProviderAccountId,
            args.accountId,
          ),
        )
    : await db
        .select({
          name: secretsTable.name,
          encryptedValue: hasFirewallAuth
            ? sql`NULL`.mapWith(pgNullDecoder)
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
    environment: providerEnvironmentFromSecretMap(
      args.type,
      forwardableSecrets,
      runtimeModel,
    ),
    secrets: hasFirewallAuth ? {} : forwardableSecrets,
    selectedModel,
    secretConnectorMap: authMaps?.secretConnectorMap,
    secretConnectorMetadataMap: authMaps?.secretConnectorMetadataMap,
  };
}

async function builtInModelProviderEnvironment(
  db: Db,
  selectedModel: string,
  featureSwitchContext: FeatureSwitchContext,
  resolvedRoute?: BuiltInModelRuntimeRoute,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (resolvedRoute && resolvedRoute.selectedModel !== selectedModel) {
    return null;
  }
  let route: BuiltInModelRuntimeRoute;
  let key:
    | {
        readonly id: string;
        readonly apiKey: string;
      }
    | undefined;
  if (resolvedRoute) {
    [key] = await db
      .select({
        id: builtInModelKeys.id,
        apiKey: builtInModelKeys.apiKey,
      })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.id, resolvedRoute.modelKeyId))
      .limit(1);
    route = resolvedRoute;
  } else {
    const target = builtInModelRuntimeTarget(selectedModel);
    [key] = await db
      .select({
        id: builtInModelKeys.id,
        apiKey: builtInModelKeys.apiKey,
      })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, target.vendor))
      .limit(1);
    if (!key) {
      return null;
    }
    route = {
      selectedModel: target.selectedModel,
      providerType: target.providerType,
      upstreamModel: target.upstreamModel,
      modelKeyId: key.id,
    };
  }
  if (!key?.apiKey) {
    return null;
  }
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
    ...(usesUsEndpoint ? { firewall } : {}),
    ...(codexRuntimeConfig ? { codexRuntimeConfig } : {}),
  };
}

interface ResolveModelProviderEnvironmentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly framework: SupportedFramework;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly piExecution: boolean;
  readonly featureSwitchContext: FeatureSwitchContext;
}

async function customGatewayModelProviderEnvironment(
  db: Db,
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
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
  account: PersonalModelProviderAccountRow,
  selectedModel: string | null,
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
      id: account.id,
      orgId: account.orgId,
      userId: account.userId,
      type: account.type,
      authMethod: account.authMethod,
      selectedModel: args.selectedModelOverride ?? selectedModel,
      featureSwitchContext: args.featureSwitchContext,
      accountId: account.id,
    });
  }

  const config = MODEL_PROVIDER_TYPES[account.type];
  if (!isSingleSecretModelProviderConfig(config)) {
    return null;
  }
  const [secret] = await db
    .select({ encryptedValue: modelProviderAccountSecrets.encryptedValue })
    .from(modelProviderAccountSecrets)
    .where(
      and(
        eq(modelProviderAccountSecrets.modelProviderAccountId, account.id),
        eq(modelProviderAccountSecrets.name, config.secretName),
      ),
    )
    .limit(1);
  if (!secret) {
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
    id: account.id,
    type: account.type,
    config,
    secretValue,
    sourceUserId: account.userId,
    sourceId: account.id,
    selectedModel: args.selectedModelOverride ?? selectedModel,
  });
}

async function resolveExactPersonalModelProviderAccount(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (!args.modelProviderId || args.modelProviderCredentialScope === "org") {
    return null;
  }
  const account = await personalModelProviderAccountById({
    db,
    id: args.modelProviderId,
    orgId: args.orgId,
    userId: args.userId,
  });
  if (
    !account ||
    !isPersonalSubscriptionProviderType(account.type) ||
    !(await coordinatePersonalSubscriptionCredentials({
      db,
      orgId: args.orgId,
      userId: args.userId,
      type: account.type,
      sourceId: account.id,
      featureSwitchContext: args.featureSwitchContext,
    }))
  ) {
    return null;
  }
  const currentAccount = await personalModelProviderAccountById({
    db,
    id: account.id,
    orgId: args.orgId,
    userId: args.userId,
  });
  if (!currentAccount) {
    return null;
  }
  const [provider] = await db
    .select({ selectedModel: modelProviders.selectedModel })
    .from(modelProviders)
    .where(eq(modelProviders.id, currentAccount.modelProviderId))
    .limit(1);
  if (!provider) {
    return null;
  }
  return await resolvePersonalModelProviderAccountEnvironment(
    db,
    args,
    currentAccount,
    provider.selectedModel,
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
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  const [provider] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.id, row.id))
    .limit(1);
  if (!provider || !isPersonalSubscriptionProviderType(provider.type)) {
    return null;
  }
  const ready = await ensurePersonalModelProviderAccount({
    db,
    provider,
    featureSwitchContext: args.featureSwitchContext,
  });
  if (!ready) {
    return null;
  }
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
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  const resolve = (
    reader: Db,
    selected: Pick<
      ResolvableModelProviderEnvironmentRow,
      "authMethod" | "selectedModel"
    >,
  ) => {
    return multiAuthModelProviderEnvironment(reader, {
      id: row.id,
      orgId: args.orgId,
      userId: row.userId,
      type: row.type,
      authMethod: selected.authMethod,
      selectedModel: args.selectedModelOverride ?? selected.selectedModel,
      configuredModel: selected.selectedModel,
      piExecution: args.piExecution,
      featureSwitchContext: args.featureSwitchContext,
    });
  };
  if (
    args.piExecution &&
    (row.type === "azure-foundry" || row.type === "aws-bedrock")
  ) {
    // Hold the selected row while reading its atomic resource/region/key
    // bundle. A concurrent settings write cannot mix old and new identities.
    return await db.transaction(async (tx) => {
      const [selected] = await tx
        .select({
          authMethod: modelProviders.authMethod,
          selectedModel: modelProviders.selectedModel,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.id, row.id),
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, row.userId),
            eq(modelProviders.type, row.type),
          ),
        )
        .for("share");
      if (!selected) {
        throw new PiNativeConfigurationError(
          "Selected cloud provider is unavailable",
        );
      }
      return await resolve(tx, selected);
    });
  }
  return await resolve(db, row);
}

async function resolveCandidateModelProviderEnvironment(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
  row: ResolvableModelProviderEnvironmentRow,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (isBuiltInModelProviderType(row.type)) {
    const selectedModel =
      args.selectedModelOverride ??
      row.selectedModel ??
      MODEL_PROVIDER_TYPES["built-in"].defaultModel;
    const provider = await builtInModelProviderEnvironment(
      db,
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

  const config = MODEL_PROVIDER_TYPES[row.type];
  if (!isSingleSecretModelProviderConfig(config) || !row.encryptedValue) {
    return null;
  }
  const captureSecret =
    args.piExecution &&
    (isPiNativeModel(args.selectedModelOverride) ||
      args.selectedModelOverride?.startsWith("deepseek-v4-"));
  if (getModelProviderFirewall(row.type) !== undefined && !captureSecret) {
    return modelProviderEnvironment({
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
  if (!hasUsableModelProviderSecretValue(secretValue)) {
    return null;
  }
  return modelProviderEnvironment({
    id: row.id,
    type: row.type,
    config,
    secretValue,
    captureSecret,
    sourceUserId: row.userId,
    selectedModel: args.selectedModelOverride ?? row.selectedModel,
  });
}

async function resolveModelProviderEnvironment(
  db: Db,
  args: ResolveModelProviderEnvironmentArgs,
): Promise<ResolvedModelProviderEnvironment | null> {
  if (isBuiltInModelProviderType(args.modelProviderType)) {
    const provider = await builtInModelProviderEnvironment(
      db,
      args.selectedModelOverride ??
        MODEL_PROVIDER_TYPES["built-in"].defaultModel,
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

async function loadPersistedRunEnvironmentSnapshot(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly content: AgentExecutionConfig;
  },
): Promise<PersistedRunEnvironmentSnapshot> {
  const environment = firstAgent(args.content)?.environment;
  const referencedSecretNames = environment
    ? extractAndGroupVariables(environment).secrets.map((ref) => {
        return ref.name;
      })
    : [];
  const secretNamesToLoad = [...new Set(referencedSecretNames)];
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

  return { variables: variableRows, secrets: secretRows };
}

function buildMergedVariables(args: {
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
  readonly content: AgentExecutionConfig;
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

function compactRecord<T>(
  values: Record<string, T>,
): Record<string, T> | undefined {
  return Object.keys(values).length > 0 ? values : undefined;
}

function mergeRecords<T>(
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

function withoutLegacyAgentRunEnvironmentEntries<T>(
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
  readonly access: ConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface StoredConnectorRuntimeRowCandidate {
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

interface StoredConnectorMaterializationSnapshotRow extends StoredConnectorRuntimeRowCandidate {
  readonly secretNames: readonly string[];
  readonly variableValues: Readonly<Record<string, string>>;
}

const storedConnectorSecretNamesDecoder = zodDriverValueDecoder(
  z.array(z.string()),
);
const storedConnectorVariableValuesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.string()),
);

interface ConnectorEnvBindingSet {
  readonly access: ConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
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

interface StoredConnectorEncryptedSecretRow extends StoredConnectorSecretRow {
  readonly encryptedValue: string;
}

interface StoredConnectorMaterializationSnapshot {
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

function emptyConnectorRuntimeContext(): ConnectorRuntimeContext {
  return {
    secrets: undefined,
    vars: undefined,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: [],
    connectorSourceIdBySlug: {},
    storedEnvironment: undefined,
  };
}

function allowedStoredConnectorRows(
  rows: readonly StoredConnectorRuntimeRowCandidate[],
  allowedConnectorSlugs: readonly ConnectorSlug[],
  snapshot: ConnectorRuntimeSelection,
  now: Date,
): readonly StoredConnectorRuntimeRow[] {
  const validRows = rows.flatMap((row) => {
    const accessResult = resolveConnectorCredentialAccess({
      snapshot,
      stored: {
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
        runtimeMethod: access.runtimeMethod,
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
  return connectorRuntimeCredentialStatusWithMethod({
    method: row.runtimeMethod.method,
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

function storedConnectorCredentialReadGroups(args: {
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly ConnectorCredentialReadGroup[] {
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

async function loadStoredConnectorEncryptedSecretRows(
  db: Db,
  args: {
    readonly bindingSets: readonly ConnectorEnvBindingSet[];
    readonly names: ReadonlySet<string>;
  },
): Promise<readonly StoredConnectorEncryptedSecretRow[]> {
  if (args.names.size === 0) {
    return [];
  }

  const groups = storedConnectorCredentialReadGroups({
    bindingSets: args.bindingSets,
    kind: "secret",
    names: args.names,
  });
  return await db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      connectorCredentialSecretReadCondition({
        db,
        groups,
      }),
    );
}

async function decryptStoredConnectorSecretRows(
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

function resolveStoredConnectorSecrets(
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

  for (const { access, connectorSlug, runtimeBindings } of bindingSets) {
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

function storedConnectorContextFromSnapshot(
  snapshot: StoredConnectorMaterializationSnapshot | null,
): ConnectorRuntimeContext {
  if (!snapshot) {
    return emptyConnectorRuntimeContext();
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

function overriddenRuntimeSecretAliases(
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

async function materializeStoredConnectorContext(
  snapshot: StoredConnectorMaterializationSnapshot | null,
  args: {
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<ConnectorRuntimeContext> {
  if (!snapshot) {
    return emptyConnectorRuntimeContext();
  }

  const availableSecretNames = availableStoredConnectorSecretNames(
    snapshot.secretRows,
  );

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_build_stored_connector_state",
    "nested",
    () => {
      const resolved = resolveStoredConnectorMetadata(
        snapshot.bindingSets,
        snapshot.variableValues,
        availableSecretNames,
      );

      // Secrets are decrypted and merged later, by
      // materializeEagerStoredConnectorSecrets.
      return Promise.resolve({
        secrets: undefined,
        vars: compactRecord(resolved.vars),
        secretConnectorMap: compactRecord(resolved.secretConnectorMap),
        secretConnectorMetadataMap: compactRecord(
          resolved.secretConnectorMetadataMap,
        ),
        connectorSlugs: snapshot.allowedConnectorRows.map((row) => {
          return row.connectorSlug;
        }),
        connectorSourceIdBySlug: connectorSourceIdsBySlug(snapshot.bindingSets),
        storedEnvironment: compactRecord(resolved.environment),
      });
    },
    args.timingDimensions,
  );
}

function eagerStoredConnectorSecretNames(args: {
  readonly snapshot: StoredConnectorMaterializationSnapshot;
  readonly storedEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly overriddenSecretAliases: ReadonlySet<string>;
}): ReadonlySet<string> {
  const names = new Set<string>();

  for (const { runtimeBindings } of args.snapshot.bindingSets) {
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

async function materializeEagerStoredConnectorSecrets(
  db: Db,
  snapshot: StoredConnectorMaterializationSnapshot | null,
  context: ConnectorRuntimeContext,
  args: {
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly eagerStoredEnvironment: Record<string, string> | undefined;
    readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
    readonly environmentSecretPlaceholders:
      | Readonly<Record<string, string>>
      | undefined;
    readonly overriddenSecretAliases: ReadonlySet<string>;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<ConnectorRuntimeContext> {
  if (!snapshot) {
    return context;
  }

  const eagerNames = eagerStoredConnectorSecretNames({
    snapshot,
    storedEnvironment: args.eagerStoredEnvironment,
    referencedEnvironmentSecretAliases: args.referencedEnvironmentSecretAliases,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
    overriddenSecretAliases: args.overriddenSecretAliases,
  });
  if (eagerNames.size === 0) {
    return context;
  }

  const encryptedRows = await loadStoredConnectorEncryptedSecretRows(db, {
    bindingSets: snapshot.bindingSets,
    names: eagerNames,
  });
  const connectorSecrets = await decryptStoredConnectorSecretRows(
    encryptedRows,
    {
      featureSwitchContext: args.featureSwitchContext,
      timingDimensions: args.timingDimensions,
    },
    timing,
  );
  const secrets = resolveStoredConnectorSecrets(
    snapshot.bindingSets,
    connectorSecrets,
  );

  return {
    ...context,
    secrets: mergeRecords(context.secrets, secrets),
  };
}

function eagerStoredConnectorSecretInputs(args: {
  readonly content: AgentExecutionConfig;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
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

async function loadStoredConnectorMaterializationPlan(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedConnectorSlugs: readonly ConnectorSlug[];
    readonly connectorIdCandidatesBySlug:
      | ReadonlyMap<ConnectorSlug, readonly string[]>
      | undefined;
    readonly scopeSource: ConnectorScopeSource;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  if (args.allowedConnectorSlugs.length === 0) {
    return null;
  }

  const allowedConnectorSlugs = [...new Set(args.allowedConnectorSlugs)];

  const snapshot = await loadStoredConnectorMaterializationSnapshot(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      allowedConnectorSlugs,
      connectorIdCandidatesBySlug: args.connectorIdCandidatesBySlug,
      scopeSource: args.scopeSource,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    },
    timing,
  );
  return snapshot;
}

function storedConnectorSnapshotQuery(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds: readonly string[];
  },
) {
  const selectedConnectors = db.$with("stored_connector_candidates").as(
    db
      .select({
        connectorId: connectors.id,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
        authMethod: connectors.authMethod,
        connectorStateRevision: sql`(
            EXTRACT(EPOCH FROM ${connectors.updatedAt})
            * 1000000
          )::bigint`
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
          inArray(connectors.id, args.connectorIds),
        ),
      ),
  );
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
  return db
    .with(selectedConnectors)
    .select({
      connectorId: selectedConnectors.connectorId,
      connectorSlug: selectedConnectors.connectorSlug,
      authMethod: selectedConnectors.authMethod,
      connectorStateRevision: selectedConnectors.connectorStateRevision,
      needsReconnect: selectedConnectors.needsReconnect,
      orgId: selectedConnectors.orgId,
      storageVersion: selectedConnectors.storageVersion,
      tokenExpiresAt: selectedConnectors.tokenExpiresAt,
      userId: selectedConnectors.userId,
      secretNames: sql`COALESCE(${secretGroups.secretNames}, '[]'::jsonb)`
        .mapWith(storedConnectorSecretNamesDecoder)
        .as("secret_names"),
      variableValues:
        sql`COALESCE(${variableGroups.variableValues}, '{}'::jsonb)`
          .mapWith(storedConnectorVariableValuesDecoder)
          .as("variable_values"),
    })
    .from(selectedConnectors)
    .leftJoin(
      secretGroups,
      eq(secretGroups.connectorId, selectedConnectors.connectorId),
    )
    .leftJoin(
      variableGroups,
      eq(variableGroups.connectorId, selectedConnectors.connectorId),
    );
}

async function loadStoredConnectorSnapshotRows(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds: readonly string[];
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<readonly StoredConnectorMaterializationSnapshotRow[]> {
  const startedAt = now();
  const rows = await onRejection(storedConnectorSnapshotQuery(db, args), () => {
    timing?.recordElapsed(
      "api_dispatch_prepare_context_load_stored_connector_snapshot_rows",
      "nested",
      startedAt,
      now(),
      args.timingDimensions,
    );
  });
  timing?.recordElapsed(
    "api_dispatch_prepare_context_load_stored_connector_snapshot_rows",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_candidate_count_bucket: countBucket(rows.length),
    },
  );
  return rows;
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

function materializeStoredConnectorSnapshotRows(
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

function firstConnectorId<TKey>(
  candidates: ReadonlyMap<TKey, readonly string[]> | undefined,
  key: TKey,
): string | undefined {
  return candidates?.get(key)?.[0];
}

function advanceUnavailableConnectorCandidates<TKey>(
  candidates: ReadonlyMap<TKey, readonly string[]> | undefined,
  materializedConnectorIds: ReadonlySet<string>,
): ReadonlyMap<TKey, readonly string[]> | undefined {
  if (candidates === undefined) {
    return undefined;
  }
  let changed = false;
  const remaining = new Map<TKey, readonly string[]>();
  for (const [key, connectorIds] of candidates) {
    const current = connectorIds[0];
    if (current === undefined) {
      throw new Error("Expected at least one connector account candidate");
    }
    if (materializedConnectorIds.has(current)) {
      remaining.set(key, connectorIds);
      continue;
    }
    changed = true;
    const fallbacks = connectorIds.slice(1);
    if (fallbacks.length > 0) {
      remaining.set(key, fallbacks);
    }
  }
  if (!changed) {
    return candidates;
  }
  return remaining.size > 0 ? remaining : undefined;
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

// Nothing materialized, so every first candidate is unavailable: retry with the
// next candidate per slug, or give up when the candidate list cannot advance.
async function retryStoredConnectorMaterializationSnapshot(
  db: Db,
  args: StoredConnectorMaterializationArgs,
  timing: ApiDispatchTimingCollector | undefined,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  const remainingCandidates = advanceUnavailableConnectorCandidates(
    args.connectorIdCandidatesBySlug,
    new Set(),
  );
  if (remainingCandidates === args.connectorIdCandidatesBySlug) {
    return null;
  }
  return await loadStoredConnectorMaterializationSnapshot(
    db,
    { ...args, connectorIdCandidatesBySlug: remainingCandidates },
    timing,
  );
}

async function loadStoredConnectorMaterializationSnapshot(
  db: Db,
  args: StoredConnectorMaterializationArgs,
  timing?: ApiDispatchTimingCollector,
): Promise<StoredConnectorMaterializationSnapshot | null> {
  const baseTimingDimensions = storedConnectorTimingDimensions({
    scopeSource: args.scopeSource,
  });
  const accountResolutions = await resolveConnectorAccounts(db, {
    orgId: args.orgId,
    userId: args.userId,
    requests: args.allowedConnectorSlugs.map((connectorSlug) => {
      const connectorId = firstConnectorId(
        args.connectorIdCandidatesBySlug,
        connectorSlug,
      );
      return {
        target: { kind: "builtin" as const, connectorSlug },
        selection:
          connectorId === undefined
            ? ({ kind: "default" } as const)
            : ({ kind: "exact", sourceId: connectorId } as const),
      };
    }),
  });
  const connectorIds = args.allowedConnectorSlugs.flatMap((connectorSlug) => {
    const resolution = accountResolutions.get(
      connectorAccountTargetKey({ kind: "builtin", connectorSlug }),
    );
    return resolution?.kind === "resolved"
      ? [resolution.account.connectorId]
      : [];
  });
  if (connectorIds.length === 0) {
    return await retryStoredConnectorMaterializationSnapshot(db, args, timing);
  }
  const rows = await loadStoredConnectorSnapshotRows(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds,
      timingDimensions: baseTimingDimensions,
    },
    timing,
  );
  if (rows.length === 0) {
    return await retryStoredConnectorMaterializationSnapshot(db, args, timing);
  }

  const snapshot = await materializeStoredConnectorSnapshotRows(
    {
      rows,
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
      timingDimensions: baseTimingDimensions,
    },
    timing,
  );
  if (args.connectorIdCandidatesBySlug !== undefined) {
    const materializedConnectorIds = new Set(
      (snapshot?.allowedConnectorRows ?? []).map((row) => {
        return row.access.connectorId;
      }),
    );
    const remainingCandidates = advanceUnavailableConnectorCandidates(
      args.connectorIdCandidatesBySlug,
      materializedConnectorIds,
    );
    if (remainingCandidates !== args.connectorIdCandidatesBySlug) {
      return await loadStoredConnectorMaterializationSnapshot(
        db,
        {
          ...args,
          connectorIdCandidatesBySlug: remainingCandidates,
        },
        timing,
      );
    }
  }
  return snapshot;
}

export type CustomConnectorRuntimeDataRows = Awaited<
  ReturnType<typeof loadCustomConnectorRuntimeData>
>;

function customConnectorRuntimeAuth(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
}): {
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
} {
  if (
    args.row.connector.authMode === "automatic" &&
    args.row.credentialAccess.kind === "current"
  ) {
    if (args.row.credentialAccess.resolvedAuthMethod === "none") {
      return { headers: {}, query: {} };
    }
    if (args.row.credentialAccess.resolvedAuthMethod === "oauth") {
      const authorization = renderTemplateForRuntime({
        template: `Bearer {{oauth.${CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME}}}`,
        connectorId: args.row.connector.id,
        fields: args.row.connector.fields,
      });
      if (authorization === null) {
        throw new Error("Automatic OAuth runtime template is invalid");
      }
      return { headers: { Authorization: authorization }, query: {} };
    }
  }
  return {
    headers: Object.fromEntries(
      args.row.connector.headerInjections.flatMap((header) => {
        const rendered = renderTemplateForRuntime({
          template: header.valueTemplate,
          connectorId: args.row.connector.id,
          fields: args.row.connector.fields,
        });
        return rendered === null ? [] : [[header.name, rendered]];
      }),
    ),
    query: Object.fromEntries(
      args.row.connector.queryInjections.flatMap((queryInjection) => {
        const rendered = renderTemplateForRuntime({
          template: queryInjection.valueTemplate,
          connectorId: args.row.connector.id,
          fields: args.row.connector.fields,
        });
        return rendered === null ? [] : [[queryInjection.name, rendered]];
      }),
    ),
  };
}

function buildCustomConnectorRuntimeApis(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
  readonly baseUrlVars: Readonly<Record<string, string>>;
  readonly permissionBundle: CustomConnectorPermissionBundle | null;
}): ExpandedFirewallConfig["apis"] {
  const connector = args.row.connector;
  if (connector.kind === "mcp") {
    const endpointResult = safeSync(() => {
      const canonicalEndpoint = canonicalizeFirewallBaseUrl(
        connector.endpoint,
        "MCP custom connector",
      );
      const endpoint = new URL(canonicalEndpoint);
      if (endpoint.protocol !== "https:") {
        throw new Error("MCP endpoint must use https://");
      }
      validateBaseUrlHostPolicy({
        base: canonicalEndpoint,
        serviceName: "MCP custom connector",
        hostPolicy: { kind: "publicDestination" },
      });
      return canonicalEndpoint;
    });
    if ("error" in endpointResult) {
      return [];
    }
    const endpoint = endpointResult.ok;
    return [
      {
        base: endpoint,
        hostPolicy: { kind: "publicDestination" },
        auth: { headers: args.headers, query: args.query },
      },
    ];
  }
  const templateValues = Object.fromEntries(
    Object.entries(args.baseUrlVars).map(([key, value]) => {
      return [customConnectorValueMarkerKey({ kind: "variable", key }), value];
    }),
  );

  const apis: ExpandedFirewallConfig["apis"] = [];
  for (const prefixTemplate of connector.prefixTemplates) {
    const renderedPrefix = renderCustomConnectorRuntimePrefix({
      template: prefixTemplate,
      values: templateValues,
      connectorName: connector.displayName,
    });
    if (!renderedPrefix) {
      continue;
    }
    apis.push({
      base: renderedPrefix,
      auth: { headers: args.headers, query: args.query },
      ...(args.permissionBundle
        ? { permissions: [...args.permissionBundle.permissions] }
        : {}),
    });
  }
  return apis;
}

function resolveCustomConnectorBaseUrlVars(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly provided: Readonly<Record<string, string>> | undefined;
  readonly hasProvided: boolean;
}): Readonly<Record<string, string>> | undefined {
  if (args.row.connector.kind === "mcp") {
    if (!args.hasProvided) {
      return {};
    }
    return Object.keys(args.provided ?? {}).length === 0 ? {} : undefined;
  }
  const variableKeys = [
    ...customConnectorPrefixTemplateVariableKeys(
      args.row.connector.prefixTemplates,
    ),
  ].sort();
  if (args.hasProvided) {
    const provided = args.provided ?? {};
    const providedKeys = Object.keys(provided).sort();
    return jsonArrayEqual(variableKeys, providedKeys)
      ? { ...provided }
      : undefined;
  }
  if (variableKeys.length === 0) {
    return {};
  }
  const prefixValues = args.row.values.filter(
    (
      value,
    ): value is Extract<StoredValueRow, { readonly kind: "variable" }> => {
      return value.kind === "variable" && variableKeys.includes(value.key);
    },
  );
  if (prefixValues.length !== variableKeys.length) {
    return undefined;
  }
  const valuesByKey = new Map(
    prefixValues.map((value) => {
      return [value.key, value.value] as const;
    }),
  );
  const baseUrlVars: Record<string, string> = {};
  for (const key of variableKeys) {
    const value = valuesByKey.get(key);
    if (value === undefined) {
      return undefined;
    }
    baseUrlVars[key] = value;
  }
  return baseUrlVars;
}

function jsonArrayEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

interface BuildCustomConnectorRuntimeContextArgs {
  readonly rows: CustomConnectorRuntimeDataRows;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  readonly grants: readonly AgentCustomConnectorGrant[] | undefined;
  readonly baseUrlVarsByConnectorId?: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;
}

type BuiltCustomConnectorRuntimeRow =
  | {
      readonly registration: Extract<
        ConnectorRuntimeTargetRegistration,
        { readonly kind: "custom" }
      >;
      readonly skill:
        | CustomConnectorRuntimeContext["skills"][number]
        | undefined;
      readonly firewall: ExpandedFirewallConfig;
      readonly permissionPolicy: FirewallPolicy | undefined;
    }
  | {
      readonly registration: undefined;
      readonly skill:
        | CustomConnectorRuntimeContext["skills"][number]
        | undefined;
      readonly firewall: undefined;
      readonly permissionPolicy: undefined;
    };

function customConnectorRuntimeSkill(
  row: CustomConnectorRuntimeDataRows[number],
): CustomConnectorRuntimeContext["skills"][number] | undefined {
  const { skillStorageVersionId } = row.connector;
  if (skillStorageVersionId === null) {
    return undefined;
  }
  return {
    connectorId: row.connector.id,
    connectorSlug: row.connector.slug,
    versionId: skillStorageVersionId,
  };
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

function unavailableCustomConnectorRuntimeRow(
  skill: BuiltCustomConnectorRuntimeRow["skill"],
): BuiltCustomConnectorRuntimeRow {
  return {
    registration: undefined,
    skill,
    firewall: undefined,
    permissionPolicy: undefined,
  };
}

export async function loadEffectiveCustomConnectorPermissionBundle(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly snapshot: ConnectorRuntimeSelection;
}): Promise<CustomConnectorPermissionBundle | null | undefined> {
  if (args.row.connector.kind === "mcp") {
    return null;
  }
  const ref = effectiveCustomConnectorPermissionBundleRef({
    slug: args.row.connector.slug,
    authMode: args.row.connector.authMode,
    oauthProviderAdapter:
      args.row.connector.oauthConfig?.providerAdapter ?? null,
    prefixTemplates: args.row.connector.prefixTemplates,
    permissionBundleRef: args.row.connector.permissionBundleRef,
  });
  return ref
    ? ((await loadCustomConnectorPermissionBundle({
        catalog: args.snapshot.serverFirewallMetadata,
        ref,
      })) ?? undefined)
    : null;
}

function buildCustomConnectorPermissionPolicy(args: {
  readonly bundle: CustomConnectorPermissionBundle;
  readonly selectedPermissionNames: readonly string[];
}): FirewallPolicy {
  const selectedPermissionNames = new Set(args.selectedPermissionNames);
  return {
    policies: Object.fromEntries(
      [...args.bundle.permissionNames].map((permissionName) => {
        return [
          permissionName,
          selectedPermissionNames.has(permissionName)
            ? "allow"
            : (args.bundle.defaultPolicies[permissionName] ?? "deny"),
        ];
      }),
    ),
    unknownPolicy: "deny",
  };
}

async function buildCustomConnectorRuntimeRow(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly context: BuildCustomConnectorRuntimeContextArgs;
  readonly selectedPermissionNames: readonly string[];
}): Promise<BuiltCustomConnectorRuntimeRow> {
  const hasProvidedBaseUrlVars =
    args.context.baseUrlVarsByConnectorId?.has(args.row.connector.id) ?? false;
  const baseUrlVars = resolveCustomConnectorBaseUrlVars({
    row: args.row,
    provided: args.context.baseUrlVarsByConnectorId?.get(args.row.connector.id),
    hasProvided: hasProvidedBaseUrlVars,
  });
  const skill = customConnectorRuntimeSkill(args.row);
  const { headers, query } = customConnectorRuntimeAuth({
    row: args.row,
  });
  if (Object.keys(headers).length === 0 && Object.keys(query).length === 0) {
    if (
      args.row.connector.kind === "mcp" &&
      args.row.connector.authMode !== "none" &&
      !(
        args.row.connector.authMode === "automatic" &&
        args.row.credentialAccess.kind === "current" &&
        args.row.credentialAccess.resolvedAuthMethod === "none"
      )
    ) {
      return unavailableCustomConnectorRuntimeRow(skill);
    }
  }
  if (baseUrlVars === undefined) {
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  const permissionBundle = await loadEffectiveCustomConnectorPermissionBundle({
    row: args.row,
    snapshot: args.context.connectorCatalogSnapshot,
  });
  if (permissionBundle === undefined) {
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  const apisResult = safeSync(() => {
    return buildCustomConnectorRuntimeApis({
      row: args.row,
      headers,
      query,
      baseUrlVars,
      permissionBundle,
    });
  });
  if ("error" in apisResult) {
    if (!(apisResult.error instanceof CustomConnectorRuntimePrefixError)) {
      throw apisResult.error;
    }
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  const apis = apisResult.ok;
  if (apis.length === 0) {
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  return {
    registration: {
      kind: "custom",
      customConnectorId: args.row.connector.id,
      baseUrlVars: { ...baseUrlVars },
      ...(args.row.credentialAccess.kind === "absent"
        ? {}
        : { sourceId: args.row.credentialAccess.memberConnectorId }),
    },
    skill,
    firewall: {
      name: customConnectorInternalName(args.row.connector.id),
      description: args.row.connector.displayName,
      apis,
    },
    permissionPolicy: permissionBundle
      ? buildCustomConnectorPermissionPolicy({
          bundle: permissionBundle,
          selectedPermissionNames: args.selectedPermissionNames,
        })
      : undefined,
  };
}

export async function buildCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  const firewalls: ExpandedFirewallConfig[] = [];
  const reservedSecretAliases: Record<string, true> = {};
  const permissionPolicies: FirewallPolicies = {};
  const targets: ConnectorRuntimeTargetRegistration[] = [];
  const customConnectorIdByFirewallName: Record<string, string> = {};
  const customConnectorSourceIdByFirewallName: Record<string, string> = {};
  const mcpConnectorSlugs: string[] = [];
  const skills: {
    connectorId: string;
    connectorSlug: string;
    versionId: string;
  }[] = [];
  const grantByConnectorId = new Map(
    (args.grants ?? []).map((grant) => {
      return [grant.customConnectorId, grant.permissionNames] as const;
    }),
  );
  for (const row of args.rows) {
    const built = await buildCustomConnectorRuntimeRow({
      row,
      context: args,
      selectedPermissionNames: grantByConnectorId.get(row.connector.id) ?? [],
    });
    if (built.skill) {
      skills.push(built.skill);
    }
    if (!built.registration) {
      continue;
    }
    targets.push(built.registration);
    firewalls.push(built.firewall);
    customConnectorIdByFirewallName[built.firewall.name] = row.connector.id;
    if (built.registration.sourceId !== undefined) {
      customConnectorSourceIdByFirewallName[built.firewall.name] =
        built.registration.sourceId;
    }
    if (row.connector.kind === "mcp") {
      const slug = customConnectorSlugSchema.safeParse(row.connector.slug);
      if (slug.success) {
        mcpConnectorSlugs.push(slug.data);
      }
    }
    if (built.permissionPolicy) {
      permissionPolicies[built.firewall.name] = built.permissionPolicy;
    }
    for (const secretName of extractSecretNamesFromApis(built.firewall.apis)) {
      reservedSecretAliases[secretName] = true;
    }
  }

  return {
    firewalls,
    reservedSecretAliases: compactRecord(reservedSecretAliases),
    permissionPolicies: compactRecord(permissionPolicies),
    targets,
    customConnectorIdByFirewallName,
    customConnectorSourceIdByFirewallName,
    mcpConnectorSlugs,
    skills,
  };
}

async function buildNewRunCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  // Active targets call the shared builder directly so credential loss does
  // not remove their pinned firewall. Only new runs apply this admission gate.
  const context = await buildCustomConnectorRuntimeContext({
    ...args,
    rows: args.rows.filter((row) => {
      return (
        row.credentialAccess.kind === "current" &&
        row.credentialAccess.runtimeAvailable &&
        (row.connector.authMode !== "manual" ||
          customConnectorManualAuthReferencesMemberField(row.connector)) &&
        customConnectorRequiredMemberCredentialsAreComplete(row)
      );
    }),
  });
  return {
    ...context,
    skills: args.rows.flatMap((row) => {
      const skill = customConnectorRuntimeSkill(row);
      return skill ? [skill] : [];
    }),
  };
}

type CustomConnectorRuntimeFirewall = Omit<Firewall, "apis"> & {
  readonly apis: (Firewall["apis"][number] & {
    readonly id: string;
  })[];
};

interface CustomConnectorRuntimeExecutionState {
  readonly firewall: Omit<ExecutionFirewallInlineEntry, "firewall"> & {
    readonly customConnectorId: string;
    readonly firewall: CustomConnectorRuntimeFirewall;
  };
  readonly networkPolicy: NetworkPolicy;
}

async function resolveCustomConnectorMemberIds(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[];
    readonly connectorIdCandidatesByCustomConnectorId:
      | ReadonlyMap<string, readonly string[]>
      | undefined;
  },
): Promise<ReadonlyMap<string, string>> {
  const accountResolutions = await resolveConnectorAccounts(db, {
    orgId: args.orgId,
    userId: args.userId,
    requests: args.allowedCustomConnectorIds.map((customConnectorId) => {
      const connectorId = firstConnectorId(
        args.connectorIdCandidatesByCustomConnectorId,
        customConnectorId,
      );
      return {
        target: { kind: "custom" as const, customConnectorId },
        selection:
          connectorId === undefined
            ? ({ kind: "default" } as const)
            : ({ kind: "exact", sourceId: connectorId } as const),
      };
    }),
  });
  const connectorIds = new Map<string, string>();
  for (const customConnectorId of args.allowedCustomConnectorIds) {
    const resolution = accountResolutions.get(
      connectorAccountTargetKey({ kind: "custom", customConnectorId }),
    );
    if (resolution?.kind === "resolved") {
      connectorIds.set(customConnectorId, resolution.account.connectorId);
    }
  }
  return connectorIds;
}

export function customConnectorRuntimeExecutionState(args: {
  readonly context: CustomConnectorRuntimeContext;
  readonly connectorId: string;
}): CustomConnectorRuntimeExecutionState | null {
  const firewallName = customConnectorInternalName(args.connectorId);
  const source = args.context.firewalls.find((firewall) => {
    return firewall.name === firewallName;
  });
  if (!source) {
    return null;
  }

  const permissionNames = collectPermissionNames(source.apis);
  const defaultPolicy = allAllowPolicyForPermissions(permissionNames);
  const policy = args.context.permissionPolicies?.[firewallName];
  const networkPolicy = resolveConnectorNetworkPolicy({
    permissionNames,
    defaultPolicy,
    policy,
  });

  return {
    firewall: {
      kind: "inline",
      customConnectorId: args.connectorId,
      firewall: customConnectorRuntimeFirewall(source),
    },
    networkPolicy,
  };
}

async function loadCustomConnectorContext(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[];
    readonly connectorIdCandidatesByCustomConnectorId:
      | ReadonlyMap<string, readonly string[]>
      | undefined;
    readonly customConnectorGrants:
      | readonly AgentCustomConnectorGrant[]
      | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  },
  signal: AbortSignal,
  timing?: ApiDispatchTimingCollector,
): Promise<CustomConnectorRuntimeContext> {
  if (args.allowedCustomConnectorIds.length === 0) {
    return emptyCustomConnectorRuntimeContext();
  }

  const memberConnectorIdsByCustomConnectorId =
    await resolveCustomConnectorMemberIds(db, args);
  const rows = await loadCustomConnectorRuntimeData(db, {
    orgId: args.orgId,
    userId: args.userId,
    connectorIds: args.allowedCustomConnectorIds,
    memberConnectorIdsByCustomConnectorId,
    measure: async (step, operation) => {
      const actionType =
        step === "connectorRows"
          ? "api_dispatch_prepare_context_load_custom_connector_rows"
          : "api_dispatch_prepare_context_load_custom_connector_value_rows";
      return await measureApiDispatchTiming(
        timing,
        actionType,
        "nested",
        operation,
      );
    },
  });
  if (rows.length === 0) {
    const remainingCandidates = advanceUnavailableConnectorCandidates(
      args.connectorIdCandidatesByCustomConnectorId,
      new Set(),
    );
    if (remainingCandidates !== args.connectorIdCandidatesByCustomConnectorId) {
      return await loadCustomConnectorContext(
        db,
        {
          ...args,
          connectorIdCandidatesByCustomConnectorId: remainingCandidates,
        },
        signal,
        timing,
      );
    }
    return emptyCustomConnectorRuntimeContext();
  }
  signal.throwIfAborted();
  const newRunRows = rows.filter((row) => {
    return (
      row.connector.kind !== "mcp" ||
      isFeatureEnabled(
        FeatureSwitchKey.CustomConnectorMcp,
        args.featureSwitchContext,
      )
    );
  });
  const context = await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_build_custom_connector_firewalls",
    "nested",
    async () => {
      return await buildNewRunCustomConnectorRuntimeContext({
        rows: newRunRows,
        featureSwitchContext: args.featureSwitchContext,
        connectorCatalogSnapshot: args.connectorCatalogSnapshot,
        grants: args.customConnectorGrants,
      });
    },
  );
  if (args.connectorIdCandidatesByCustomConnectorId !== undefined) {
    const remainingCandidates = advanceMaterializedCustomConnectorCandidates(
      context,
      args.connectorIdCandidatesByCustomConnectorId,
    );
    if (remainingCandidates !== args.connectorIdCandidatesByCustomConnectorId) {
      return await loadCustomConnectorContext(
        db,
        {
          ...args,
          connectorIdCandidatesByCustomConnectorId: remainingCandidates,
        },
        signal,
        timing,
      );
    }
  }
  return context;
}

function advanceMaterializedCustomConnectorCandidates(
  context: CustomConnectorRuntimeContext,
  candidates: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> | undefined {
  const sourceIds = new Set(
    context.targets.flatMap((target) => {
      return target.sourceId === undefined ? [] : [target.sourceId];
    }),
  );
  return advanceUnavailableConnectorCandidates(candidates, sourceIds);
}

function collectPermissionNames(
  apis: ExpandedFirewallConfig["apis"],
): readonly string[] {
  const names = new Set<string>();
  for (const api of apis) {
    for (const permission of api.permissions ?? []) {
      names.add(permission.name);
    }
  }
  return [...names];
}

function allAllowPolicyForPermissions(
  permissionNames: readonly string[],
): FirewallPolicy {
  return {
    policies: Object.fromEntries(
      permissionNames.map((name) => {
        return [name, "allow" as const];
      }),
    ),
    unknownPolicy: "allow",
  };
}

function resolveConnectorNetworkPolicy(args: {
  readonly permissionNames: readonly string[];
  readonly defaultPolicy: FirewallPolicy;
  readonly policy: FirewallPolicy | undefined;
}): NetworkPolicy {
  return networkPolicyForFirewallPolicy(
    args.permissionNames,
    args.policy
      ? {
          ...args.policy,
          unknownPolicy:
            args.policy.unknownPolicy ?? args.defaultPolicy.unknownPolicy,
        }
      : args.defaultPolicy,
  );
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

function runtimeFirewall(firewall: ExpandedFirewallConfig): Firewall {
  return {
    name: firewall.name,
    apis: firewall.apis.map((api) => {
      return {
        base: api.base,
        ...(api.hostPolicy !== undefined ? { hostPolicy: api.hostPolicy } : {}),
        auth: api.auth,
        permissions: api.permissions ?? [],
      };
    }),
  };
}

function customConnectorRuntimeFirewall(
  firewall: ExpandedFirewallConfig,
): CustomConnectorRuntimeFirewall {
  const runtime = runtimeFirewall(firewall);
  return {
    ...runtime,
    apis: runtime.apis.map((api, index) => {
      return {
        id: `${runtime.name}:${index}`,
        ...api,
      };
    }),
  };
}

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
    Object.assign(
      environmentSecretPlaceholders,
      source.metadata.placeholderValues,
    );
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
          return { metadata, permissionIndex };
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

async function checkRunConcurrencyLimit(
  tx: DbTransaction,
  orgId: string,
): Promise<CreateRunErrorResult | null> {
  const at = nowDate();
  const state = await loadOrgConcurrencyState(tx, {
    orgId,
    at,
    activePendingAfter: new Date(at.getTime() - PENDING_RUN_TTL_MS),
  });
  const limit = getEffectiveConcurrencyLimit(
    state.baseConcurrencyLimit,
    state.paidSlots,
  );
  if (limit === 0) {
    return null;
  }

  return state.activeRunCount >= limit ? concurrentRunLimit() : null;
}

async function checkFinalRunAdmission(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly modelProviderType: string | null | undefined;
    readonly selectedModel: string | null | undefined;
    readonly enforceBuiltInCredits: boolean;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<CreateRunErrorResult | null> {
  if (args.enforceBuiltInCredits) {
    return await args.timing.measure(
      "api_dispatch_check_built_in_credits",
      "nested",
      async () => {
        const availability = await resolveOrgCreditAvailability({
          db,
          orgId: args.orgId,
          userId: args.userId,
        });
        signal.throwIfAborted();
        return (
          (await checkResolvedOrgCreditsForRunAdmission({
            db,
            orgId: args.orgId,
            userId: args.userId,
            modelProviderType: args.modelProviderType,
            selectedModel: args.selectedModel,
            availability,
          })) ?? null
        );
      },
    );
  }

  const capabilities = await loadOrgPlanCapabilities(db, args.orgId);
  signal.throwIfAborted();
  return (
    checkOrgPlanRunAdmission({
      capabilities,
      modelProviderType: args.modelProviderType,
      selectedModel: args.selectedModel,
    }) ?? null
  );
}

async function checkOrgRunPlanStatus(
  db: Db,
  args: { readonly orgId: string },
): Promise<CreateRunErrorResult | null> {
  const capabilities = await loadOrgPlanCapabilities(db, args.orgId);
  if (!capabilities) {
    return insufficientCredits();
  }
  return capabilities.status === "active" ? null : insufficientCredits();
}

async function resolveByAgentId(
  db: Db,
  agentId: string,
  options: ProductResolutionOptions,
): Promise<ResolvedAgentExecution | CreateRunErrorResult> {
  const [row] = await measureApiDispatchTiming(
    options.timing,
    "api_dispatch_resolve_agent_execution_lookup_agent",
    "nested",
    async () => {
      return await db
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

async function resolveLatestPiResumeSession(
  db: Db,
  chatThreadId: string,
  agentSessionId: string,
): Promise<StoredExecutionContext["resumeSession"] | undefined> {
  const [snapshot] = await db
    .select({
      runId: conversations.runId,
      cliAgentSessionId: conversations.cliAgentSessionId,
      cliAgentSessionHistory: conversations.cliAgentSessionHistory,
      cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
      sessionHistoryBlobEncoding: blobs.encoding,
    })
    .from(conversations)
    .innerJoin(agentRuns, eq(conversations.runId, agentRuns.id))
    .leftJoin(blobs, eq(conversations.cliAgentSessionHistoryHash, blobs.hash))
    .where(
      and(
        eq(agentRuns.chatThreadId, chatThreadId),
        // Canonical chat-session rotation owns the Pi history generation.
        // Restrict before ordering so a pre-rotation Pi checkpoint cannot
        // cross an intervening harness boundary.
        eq(agentRuns.sessionId, agentSessionId),
        eq(agentRuns.status, "completed"),
        isNotNull(agentRuns.triggerSource),
        eq(conversations.cliAgentType, "pi"),
        eq(conversations.cliAgentSessionId, chatThreadId),
        or(
          isNotNull(conversations.cliAgentSessionHistoryHash),
          isNotNull(conversations.cliAgentSessionHistory),
        ),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return snapshot ? resumeSessionFromSnapshot(snapshot) : undefined;
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

function resolveBySessionId(
  db: Db,
  agentSessionId: string,
  userId: string,
  orgId: string,
  options: ProductResolutionOptions,
): Computed<Promise<ResolvedAgentExecution | CreateRunErrorResult>> {
  return computed(
    async (): Promise<ResolvedAgentExecution | CreateRunErrorResult> => {
      const [snapshot] = await measureApiDispatchTiming(
        options.timing,
        "api_dispatch_resolve_agent_execution_lookup_session_snapshot",
        "nested",
        async () => {
          return await db
            .select({
              session: {
                id: agentSessions.id,
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
                sessionHistoryBlobEncoding:
                  snapshot.historyBlob?.encoding ?? null,
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
        previousRunStorageMounts:
          snapshot.previousRun?.storageMounts ?? undefined,
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
    },
  );
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

function resolveAgentExecution(
  db: Db,
  body: CreateRunBody,
  userId: string,
  orgId: string,
  options: ResolveAgentExecutionOptions,
): Computed<Promise<ResolvedRunExecution | CreateRunErrorResult>> {
  return computed(
    async (get): Promise<ResolvedRunExecution | CreateRunErrorResult> => {
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
        return requireResolvedAgentIdMatch(resolved, body.agentId);
      }

      const productAgentExecutionPlan = options.productAgentExecutionPlan;
      if (productAgentExecutionPlan === undefined) {
        throw new Error(
          "Product Agent execution plan is required for canonical resolution",
        );
      }
      if (
        productAgentExecutionPlan.identity === "pi-memory-phase2-maintenance"
      ) {
        return {
          agentId: null,
          ownerUserId: userId,
          orgId,
          content: productAgentExecutionPlan.content,
          artifacts: [],
        };
      }
      if (body.sessionId) {
        const sessionId = body.sessionId;
        const resolved = await measureApiDispatchTiming(
          options.timing,
          "api_dispatch_resolve_agent_execution_by_session_id",
          "nested",
          async () => {
            return await get(
              resolveBySessionId(db, sessionId, userId, orgId, {
                executionPlan: productAgentExecutionPlan,
                timing: options.timing,
              }),
            );
          },
        );
        return requireResolvedAgentIdMatch(resolved, body.agentId);
      }
      if (!body.agentId) {
        return badRequestMessage("Missing agentId or sessionId");
      }
      const agentId = body.agentId;
      return await measureApiDispatchTiming(
        options.timing,
        "api_dispatch_resolve_agent_execution_by_agent_id",
        "nested",
        async () => {
          return await resolveByAgentId(db, agentId, {
            executionPlan: productAgentExecutionPlan,
            timing: options.timing,
          });
        },
      );
    },
  );
}

function enforceCaptureNetworkBodiesGate(
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

function validateCompose(
  content: AgentExecutionConfig,
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

function validateRunFramework(
  content: AgentExecutionConfig,
  body: CreateRunBody,
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  return validateCompose(content, body.vars, body.secrets, {
    validateEnvironmentReferences: false,
  });
}

function initialRunBody(args: CreateAgentRunArgs): CreateRunBody {
  return args.includeOkouTokenSecret
    ? withPendingOkouTokenSecret(args.body)
    : args.body;
}

function agentRunModelProviderValues(
  modelProvider: ResolvedModelProviderEnvironment | null,
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

function runFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Run failed";
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

interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly status: LaunchRunStatus;
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly runStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly sessionStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly agentRunModelPin: AgentRunModelPin | undefined;
  readonly selectedVideoModel: string;
  readonly selectedImageModel: ImageModel | null;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly chatThreadId: string | undefined;
  readonly agentRunMetadata: AgentRunMetadata | undefined;
  readonly apiStartTime: number;
  readonly runnerGroup: string | undefined;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
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
    lastHeartbeatAt: createdAt,
    runnerGroup: args.runnerGroup ?? null,
    launchSnapshot: args.launchSnapshot,
    langfuseTraceEnabled: args.langfuseTraceEnabled,
    officialWorkflowProvenance: args.officialWorkflowProvenance ?? null,
    completedAt: args.status === "failed" ? createdAt : null,
    error: args.error ?? null,
    ...metadata,
  };
}

type BuiltInModelLaunchMetadataValues = Pick<
  RunMetadataValues,
  "modelRuntimeProvider" | "modelRuntimeModel" | "builtInModelKeyId"
>;

function builtInModelLaunchMetadataValues(
  modelProvider: ResolvedModelProviderEnvironment | null,
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
    selectedVideoModel: args.selectedVideoModel,
    selectedImageModel: args.selectedImageModel,
    chatThreadId: args.chatThreadId ?? null,
    apiStartedAt: args.status === "queued" ? null : new Date(args.apiStartTime),
    firstAssistantEventAcknowledgedAt: null,
    summary: null,
  });
}

async function insertLaunchRunRows(
  tx: Db,
  args: LaunchRunRowsArgs,
): Promise<{ readonly createdAt: Date }> {
  if (args.identity.shouldCreateSession) {
    await tx.insert(agentSessions).values(launchSessionValues(args));
  }

  const createdAt = nowDate();
  const metadata = launchRunMetadataValues(args);
  await tx.insert(agentRuns).values(launchRunValues(args, createdAt, metadata));

  if (args.callbackRows.length > 0) {
    await tx.insert(agentRunCallbacks).values([...args.callbackRows]);
  }

  return { createdAt };
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

async function buildStoredExecutionContextDraft(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | undefined;
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly apiStartTime: number;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly piMemoryPhase2Maintenance: PiMemoryPhase2Maintenance | undefined;
}): Promise<BuiltStoredExecutionContextDraft> {
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
      encryptedSecrets: await encryptPersistentSecretsMap(
        executionSecrets.secrets ??
          // Private BYOK maintenance has dynamic references but no Okou token.
          // Firewall auth still needs an encrypted runtime namespace.
          (args.piMemoryPhase2Maintenance ? {} : null),
        args.featureSwitchContext,
      ),
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

async function resolveBuiltStoredExecutionContext(
  preparedStoragePromise: Promise<PreparedAgentRunStorage>,
  builtContextDraftPromise: Promise<BuiltStoredExecutionContextDraft>,
): Promise<BuiltStoredExecutionContext> {
  const [preparedStorageResult, builtContextDraftResult] =
    await Promise.allSettled([
      preparedStoragePromise,
      builtContextDraftPromise,
    ]);
  if (preparedStorageResult.status === "rejected") {
    throw preparedStorageResult.reason;
  }
  if (builtContextDraftResult.status === "rejected") {
    throw builtContextDraftResult.reason;
  }
  return {
    ...builtContextDraftResult.value,
    persistedStorageMounts: [
      ...preparedStorageResult.value.persistedStorageMounts,
    ],
    runContextStorage: preparedStorageResult.value.runContextStorage,
    context: {
      ...builtContextDraftResult.value.context,
      storageMounts: [...preparedStorageResult.value.storageMounts],
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

function recordQueuedRunEnqueueTelemetry(args: {
  readonly runId: string;
  readonly queueDepth: number;
  readonly timestamp: string;
}): void {
  bestEffortTelemetry(() => {
    recordSandboxOperation({
      sandboxType: "runner",
      actionType: "enqueue_agent_run",
      durationMs: 0,
      success: true,
      runId: args.runId,
      timestamp: args.timestamp,
      dimensions: {
        queue_depth: args.queueDepth,
      },
    });
  });
}

function recordThreadSessionBindingTelemetry(args: {
  readonly binding: ThreadSessionBindingWrite;
  readonly runStatus: "pending" | "queued";
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

export function recordThreadSessionBindingRetryTelemetry(
  retry: ThreadSessionSnapshotStale,
): void {
  bestEffortTelemetry(() => {
    recordSandboxOperation({
      sandboxType: "chat",
      actionType: "chat_thread_session_binding_retry",
      durationMs: 0,
      success: true,
      runId: retry.agentSessionRunId,
      dimensions: {
        chat_thread_id: retry.chatThreadId,
        agent_session_id: retry.agentSessionId,
        agent_session_run_id: retry.agentSessionRunId,
        binding_action: "retried",
        resolution_action: retry.resolutionAction,
        retry_reason: retry.reason,
      },
    });
  });
}

function buildStoredExecutionSecrets(args: {
  readonly connectorContext: ConnectorRuntimeContext;
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
    secrets: secrets ?? (secretConnectorMap ? {} : undefined),
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

function countBucket(count: number): (typeof COUNT_BUCKET_DIMENSIONS)[number] {
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

function storedConnectorTimingDimensions(args: {
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
  readonly modelUsageProvider: SupportedRunModel | undefined;
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

function prepareModelUsageContext(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionManifest: PermissionManifest | undefined;
}): ModelUsageContext | CreateRunErrorResult {
  const billableFirewalls = billableFirewallsForPermissions({
    modelProvider: args.modelProvider,
    permissions: args.permissionManifest,
  });
  const modelUsageProvider = modelUsageProviderForContext(args.modelProvider);
  const validation = validateModelUsageProviderInvariant({
    modelProvider: args.modelProvider,
    billableFirewalls,
    modelUsageProvider,
  });

  return validation ?? { billableFirewalls, modelUsageProvider };
}

function modelUsageProviderForContext(
  modelProvider: ResolvedModelProviderEnvironment | null,
): SupportedRunModel | undefined {
  if (!modelProvider?.selectedModel) {
    return undefined;
  }
  const canonicalModel = normalizeRunModelId(modelProvider.selectedModel);
  return isSupportedRunModel(canonicalModel) ? canonicalModel : undefined;
}

function sessionStorageMountsForPersistence(args: {
  readonly resolvedMounts: readonly PersistedStorageMount[];
  readonly artifacts: readonly ContextArtifact[];
}): readonly PersistedStorageMount[] {
  const artifactsByName = new Map<string, ContextArtifact>();
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
  readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly artifacts: readonly ContextArtifact[];
  readonly framework: SupportedFramework;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly apiStartTime: number;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
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
  readonly piMemoryPhase2Maintenance: PiMemoryPhase2Maintenance | undefined;
}

interface PreparedPiLaunchResources {
  readonly modelConfig: PiModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly sessionId: string;
}

function canonicalPiMemoryMount<
  T extends { readonly name: string; readonly mountPath: string },
>(mounts: readonly T[] | undefined): T | undefined {
  return mounts?.find((mount) => {
    return (
      mount.name === AUTO_MEMORY_ARTIFACT_NAME &&
      mount.mountPath === PI_MEMORY_ROOT
    );
  });
}

function noContentPiMemoryRecall(args: {
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
}): PiMemoryRecallSelection {
  return { ...args, status: "no-content" };
}

function priorPiMemoryRecall(args: {
  readonly currentMemoryMount: Pick<
    StorageMountMetadata,
    "storageId" | "versionId"
  >;
  readonly previousRunStorageMounts:
    | readonly PersistedStorageMount[]
    | undefined;
  readonly persistedStorageMounts: readonly PersistedStorageMount[] | undefined;
}): PiMemoryRecallSelection | undefined {
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
    return parsed.data;
  }
  L.warn("Pi memory recall epoch did not match the pinned mount", {
    memoryStorageId: args.currentMemoryMount.storageId,
    storageVersionId: args.currentMemoryMount.versionId,
    reason: parsed.success ? "identity_mismatch" : "invalid_epoch",
  });
  return noContentPiMemoryRecall({
    memoryStorageId: args.currentMemoryMount.storageId,
    storageVersionId: args.currentMemoryMount.versionId,
  });
}

async function resolvePiMemoryRecall(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly piMemoryEnabled: boolean;
    readonly storageMounts: readonly StorageMountMetadata[];
    readonly persistedStorageMounts:
      | readonly PersistedStorageMount[]
      | undefined;
    readonly previousRunStorageMounts:
      | readonly PersistedStorageMount[]
      | undefined;
  },
  signal: AbortSignal,
): Promise<PiMemoryRecallSelection | undefined> {
  const currentMemoryMount = canonicalPiMemoryMount(args.storageMounts);
  const persistedMemoryMount = canonicalPiMemoryMount(
    args.persistedStorageMounts,
  );
  if (
    currentMemoryMount === undefined ||
    persistedMemoryMount === undefined ||
    persistedMemoryMount.storageId !== currentMemoryMount.storageId ||
    persistedMemoryMount.version !== currentMemoryMount.versionId
  ) {
    return undefined;
  }
  if (!args.piMemoryEnabled) {
    // PiMemory is off for this owner: the mount stays pinned, but neither a
    // prior recall epoch nor the summary projection is read, so nothing from
    // the memory tree reaches the prompt.
    return noContentPiMemoryRecall({
      memoryStorageId: currentMemoryMount.storageId,
      storageVersionId: currentMemoryMount.versionId,
    });
  }

  const prior = priorPiMemoryRecall({
    currentMemoryMount,
    previousRunStorageMounts: args.previousRunStorageMounts,
    persistedStorageMounts: args.persistedStorageMounts,
  });
  if (prior !== undefined) {
    return prior;
  }

  const projection = await settle(
    readMemorySummaryProjection(
      args.db,
      {
        orgId: args.orgId,
        userId: args.userId,
        memoryStorageId: currentMemoryMount.storageId,
        storageVersionId: currentMemoryMount.versionId,
      },
      signal,
    ),
    signal,
  );
  if (!projection.ok) {
    L.warn("Pi memory summary projection read failed", {
      memoryStorageId: currentMemoryMount.storageId,
      storageVersionId: currentMemoryMount.versionId,
      errorClass:
        projection.error instanceof Error
          ? projection.error.name
          : "NonErrorThrown",
    });
  }
  if (!projection.ok || projection.value === null) {
    return noContentPiMemoryRecall({
      memoryStorageId: currentMemoryMount.storageId,
      storageVersionId: currentMemoryMount.versionId,
    });
  }
  return piMemoryRecallSelectionSchema.parse({
    status: "ready",
    memoryStorageId: currentMemoryMount.storageId,
    storageVersionId: currentMemoryMount.versionId,
    ...projection.value,
  });
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

function piBaseSession(
  resumeSession: StoredExecutionContext["resumeSession"] | undefined,
  sessionId: string,
): PiApiFirstTurnConfig["baseSession"] {
  if (!resumeSession) {
    return { sessionId, sha256: null };
  }
  if (resumeSession.sessionId !== sessionId) {
    throw new Error("Pi resume session id does not match the launch session");
  }
  return {
    sessionId,
    sha256:
      "historyRef" in resumeSession
        ? resumeSession.historyRef.hash
        : createHash("sha256")
            .update(resumeSession.sessionHistory, "utf8")
            .digest("hex"),
  };
}

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
  };
}

function assemblePiLaunchResources(args: {
  readonly modelConfig: PiModelConfig;
  readonly storageMounts: readonly StorageMountMetadata[];
  readonly apiStartTime: number;
  readonly maintenance: PiMemoryPhase2Maintenance | undefined;
  readonly memoryRecall: PiMemoryRecallSelection | undefined;
  readonly resumeSession: PreparedPiLaunchResources["resumeSession"];
  readonly sessionId: string;
  readonly manifestUrl: string;
  readonly sessionUrl: string;
}): PreparedPiLaunchResources {
  const { memoryRecall, resumeSession, sessionId } = args;
  return {
    modelConfig: args.modelConfig,
    launchConfig: {
      schemaVersion: 2,
      apiFirstTurn: {
        schemaVersion: 1,
        resourceSnapshotDigest: piResourceSnapshotDigest(
          piResourceDiscoveryMounts(args.storageMounts),
          memoryRecall,
        ),
        manifestUrl: args.manifestUrl,
        sessionUrl: args.sessionUrl,
        deadlineAt:
          args.apiStartTime + PI_API_FIRST_TURN_COORDINATION_TIMEOUT_MS,
        baseSession: piBaseSession(resumeSession, sessionId),
        sandboxEventSequenceStart: 1,
      },
      ...(memoryRecall === undefined ? {} : { memoryRecall }),
      ...(args.maintenance === undefined
        ? {}
        : { maintenance: args.maintenance }),
    },
    ...(memoryRecall === undefined ? {} : { memoryRecall }),
    resumeSession,
    sessionId,
  };
}

interface PreparePiLaunchResourcesArgs {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly piMemoryEnabled: boolean;
  readonly runId: string;
  readonly agentSessionId: string;
  readonly apiStartTime: number;
  readonly storagePlan: Promise<ResolvedAgentRunStorage>;
  readonly previousRunStorageMounts:
    | readonly PersistedStorageMount[]
    | undefined;
  readonly piSandbox: PiModelConfig | undefined;
  readonly chatThreadId: string | undefined;
  readonly timing: ApiDispatchTimingCollector;
  readonly maintenance: PiMemoryPhase2Maintenance | undefined;
}

function signPiLaunchObjectUrls(
  runId: string,
  observe: ReturnType<typeof piPreparationObserver>,
  signal: AbortSignal,
): Computed<Promise<[string, string]>> {
  return computed(async (get) => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    return await joinAll([
      measurePiPreparation(
        observe,
        "launch_manifest_sign",
        () => {
          return get(
            generatePresignedGetUrl(
              bucket,
              piApiFirstTurnObjectKey(runId, "manifest"),
              undefined,
              true,
            ),
          );
        },
        signal,
      ),
      measurePiPreparation(
        observe,
        "launch_session_sign",
        () => {
          return get(
            generatePresignedGetUrl(
              bucket,
              piApiFirstTurnObjectKey(runId, "session"),
              undefined,
              true,
            ),
          );
        },
        signal,
      ),
    ]);
  });
}

function preparePiLaunchResources(
  args: PreparePiLaunchResourcesArgs,
  signal: AbortSignal,
): Computed<Promise<PreparedPiLaunchResources | undefined>> {
  return computed(async (get) => {
    if (args.piSandbox === undefined) {
      return undefined;
    }
    if (args.chatThreadId === undefined && args.maintenance === undefined) {
      throw new Error("Pi sandbox execution requires a chat thread");
    }
    const piSandbox = args.piSandbox;
    const sessionId = args.chatThreadId ?? args.runId;
    const observe = piPreparationObserver(args.runId);
    const finish = startPiPreparationObservation(observe, "launch", signal);
    const result = await onRejection(
      measureApiDispatchTiming(
        args.timing,
        "api_dispatch_prepare_pi_launch_resources",
        "nested",
        async () => {
          const resumeSessionPromise = args.maintenance
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
                      return resolveLatestPiResumeSession(
                        args.db,
                        sessionId,
                        args.agentSessionId,
                      );
                    },
                    signal,
                  );
                },
              );
          const memoryPromise = (async () => {
            // Both request and canonical session writeback ownership/version and
            // overlay order are final before recall can observe this attempt.
            const { metadata } = await args.storagePlan;
            signal.throwIfAborted();
            const memoryRecall = args.maintenance
              ? undefined
              : await measurePiPreparation(
                  observe,
                  "launch_memory",
                  () => {
                    return resolvePiMemoryRecall(
                      {
                        db: args.db,
                        orgId: args.orgId,
                        userId: args.userId,
                        piMemoryEnabled: args.piMemoryEnabled,
                        storageMounts: metadata.storageMounts,
                        persistedStorageMounts: metadata.persistedStorageMounts,
                        previousRunStorageMounts: args.previousRunStorageMounts,
                      },
                      signal,
                    );
                  },
                  signal,
                );
            return { metadata, memoryRecall };
          })();
          const urlsPromise = get(
            signPiLaunchObjectUrls(args.runId, observe, signal),
          );
          const [resumeResult, memoryResult, urlsResult] =
            await Promise.allSettled([
              resumeSessionPromise,
              memoryPromise,
              urlsPromise,
            ]);
          if (resumeResult.status === "rejected") {
            throw resumeResult.reason;
          }
          if (memoryResult.status === "rejected") {
            throw memoryResult.reason;
          }
          if (urlsResult.status === "rejected") {
            throw urlsResult.reason;
          }
          signal.throwIfAborted();
          const resumeSession = resumeResult.value;
          const { metadata, memoryRecall } = memoryResult.value;
          const [manifestUrl, sessionUrl] = urlsResult.value;
          return measurePiPreparationSync(
            observe,
            "launch_identity",
            () => {
              return assemblePiLaunchResources({
                modelConfig: piSandbox,
                storageMounts: metadata.storageMounts,
                apiStartTime: args.apiStartTime,
                maintenance: args.maintenance,
                memoryRecall,
                resumeSession,
                sessionId,
                manifestUrl,
                sessionUrl,
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
    finish("success");
    return result;
  });
}

function preparedRunnerGroup(content: AgentExecutionConfig): string {
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

async function joinLaunchPreparation(
  builtContextPromise: Promise<BuiltStoredExecutionContext>,
  piResourcesPromise: Promise<PreparedPiLaunchResources | undefined>,
  signal: AbortSignal,
): Promise<{
  readonly builtContext: BuiltStoredExecutionContext;
  readonly piResources: PreparedPiLaunchResources | undefined;
}> {
  // Keep Storage, context, then Pi error precedence after every owned branch
  // has settled, including dependencies that do not support cancellation.
  const [contextResult, piResult] = await Promise.allSettled([
    builtContextPromise,
    piResourcesPromise,
  ]);
  if (contextResult.status === "rejected") {
    throw contextResult.reason;
  }
  if (piResult.status === "rejected") {
    throw piResult.reason;
  }
  signal.throwIfAborted();
  return { builtContext: contextResult.value, piResources: piResult.value };
}

function buildRunnerJobPayload(
  db: Db,
  args: BuildRunnerJobPayloadInput,
  signal: AbortSignal,
): Computed<Promise<PreparedRunnerLaunch>> {
  return computed(async (get): Promise<PreparedRunnerLaunch> => {
    const checkpointArtifacts = args.piMemoryPhase2Maintenance
      ? args.artifacts.map((artifact) => {
          return artifact.name === AUTO_MEMORY_ARTIFACT_NAME &&
            artifact.mountPath === PI_MEMORY_ROOT
            ? { ...artifact, missingRootPolicy: "fail" as const }
            : artifact;
        })
      : args.artifacts;
    const group = preparedRunnerGroup(args.resolved.content);
    const body = preparedRunnerJobBody(args);
    const platformEnvironment = args.includeOkouTokenSecret
      ? { ...args.platformEnvironment, ...okouTokenEnvironment(body) }
      : args.platformEnvironment;
    const storageManifestStats = new StorageManifestBuildStats();
    const storagePlan$ = resolveAgentRunStorage({
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
      stats: storageManifestStats,
    });
    const preparedStoragePromise = measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest",
      "nested",
      async () => {
        return get(materializeAgentRunStorage(await get(storagePlan$)));
      },
      () => {
        return storageManifestStats.overallDimensions();
      },
    );
    const builtContextDraftPromise = measureApiDispatchTiming(
      args.timing,
      "api_dispatch_build_stored_execution_context",
      "nested",
      async () => {
        return await buildStoredExecutionContextDraft({
          ...args,
          body,
          platformEnvironment,
          runId: args.run.id,
        });
      },
    );
    const builtContextPromise = resolveBuiltStoredExecutionContext(
      preparedStoragePromise,
      builtContextDraftPromise,
    );
    const piResourcesPromise = get(
      preparePiLaunchResources(
        {
          db,
          orgId: args.orgId,
          userId: args.userId,
          // The launching Run's own switch context, never the caller's.
          piMemoryEnabled: isFeatureEnabled(
            FeatureSwitchKey.PiMemory,
            args.featureSwitchContext,
          ),
          runId: args.run.id,
          agentSessionId: args.run.sessionId,
          apiStartTime: args.apiStartTime,
          storagePlan: get(storagePlan$),
          previousRunStorageMounts: args.resolved.previousRunStorageMounts,
          piSandbox: args.piSandbox,
          chatThreadId: args.chatThreadId,
          maintenance: args.piMemoryPhase2Maintenance,
          timing: args.timing,
        },
        signal,
      ),
    );
    const { builtContext, piResources } = await joinLaunchPreparation(
      builtContextPromise,
      piResourcesPromise,
      signal,
    );
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
      storedContext.piSessionId ??
      storedContext.resumeSession?.sessionId ??
      null;
    return {
      runnerJobPayload: queuedRunnerJobPayload({
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
  });
}

function preparedLaunchRowsArgs(args: {
  readonly commit: CommitPreparedLaunchArgs;
  readonly status: Extract<LaunchRunStatus, "pending" | "queued">;
  readonly runnerGroup: string;
}): LaunchRunRowsArgs {
  return {
    userId: args.commit.createArgs.userId,
    orgId: args.commit.createArgs.orgId,
    identity: args.commit.identity,
    status: args.status,
    resolved: args.commit.context.resolved,
    body: args.commit.context.body,
    runStorageMounts: args.commit.launch.runStorageMounts,
    sessionStorageMounts: args.commit.launch.sessionStorageMounts,
    modelProvider: args.commit.context.modelProvider,
    agentRunModelPin: args.commit.createArgs.agentRunModelPin,
    selectedVideoModel: args.commit.context.selectedVideoModel,
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
    creditAdmitted: args.status === "pending" && args.commit.creditAdmitted,
  };
}

interface PersistAtomicLaunchRowsArgs {
  readonly tx: DbTransaction;
  readonly commit: CommitPreparedLaunchArgs;
  readonly status: Extract<LaunchRunStatus, "pending" | "queued">;
  readonly payload: RunnerJobPayload;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
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
      .where(eq(chatThreads.id, args.chatThreadId))
      .returning({ id: chatThreads.id }),
  );
}

function buildAtomicLaunchCteContext(args: PersistAtomicLaunchRowsArgs) {
  const rowsArgs = preparedLaunchRowsArgs({
    commit: args.commit,
    status: args.status,
    runnerGroup: args.payload.runnerGroup,
  });
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

  const metadata = launchRunMetadataValues(rowsArgs);
  const insertedRun = args.tx.$with("inserted_launch_run").as(
    args.tx
      .insert(agentRuns)
      .values({
        ...launchRunValues(rowsArgs, createdAt, metadata),
        sessionId: insertedSession
          ? returnedCteId(insertedSession)
          : rowsArgs.identity.sessionId,
      })
      .returning({ id: agentRuns.id, createdAt: agentRuns.createdAt }),
  );
  ctes.push(insertedRun);

  const diagnosticRegistrationPayload =
    agentRunConnectorDiagnosticRegistrationPayloadSchema.parse({
      version: 1,
      targets: args.payload.executionContext.connectorRuntimeTargets,
    });
  const insertedDiagnosticRegistration = args.tx
    .$with("inserted_launch_connector_diagnostic_registration")
    .as(
      args.tx
        .insert(agentRunConnectorDiagnosticRegistrations)
        .values({
          runId: returnedCteId(insertedRun),
          payload: diagnosticRegistrationPayload,
          createdAt,
        })
        .returning({ id: agentRunConnectorDiagnosticRegistrations.runId }),
    );
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
    insertedDiagnosticRegistration,
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

async function persistPendingAtomicLaunch(
  args: PersistAtomicLaunchRowsArgs,
  context: AtomicLaunchCteContext,
): Promise<Extract<PersistedAtomicLaunchRows, { readonly kind: "pending" }>> {
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
    .innerJoin(insertedQueue, eq(insertedQueue.runId, context.insertedRun.id))
    .innerJoin(
      context.insertedDiagnosticRegistration,
      eq(context.insertedDiagnosticRegistration.id, context.insertedRun.id),
    );
  if (!row || (context.updatedThread && !row.boundThreadId)) {
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

async function persistQueuedAtomicLaunch(
  args: PersistAtomicLaunchRowsArgs,
  context: AtomicLaunchCteContext,
): Promise<Extract<PersistedAtomicLaunchRows, { readonly kind: "queued" }>> {
  const insertedQueue = args.tx.$with("inserted_launch_run_queue").as(
    args.tx
      .insert(agentRunQueue)
      .values({
        runId: returnedCteId(context.insertedRun),
        userId: args.commit.createArgs.userId,
        orgId: args.commit.createArgs.orgId,
        encryptedParams: args.commit.encryptedQueuedParams,
        createdAt: context.createdAt,
        expiresAt: sql`now() + interval '2 hours'`,
      })
      .returning({ runId: agentRunQueue.runId }),
  );
  const ctes = [...context.ctes, insertedQueue];
  if (context.updatedThread) {
    ctes.push(context.updatedThread);
  }
  const visibleQueueDepth = args.tx
    .select({ depth: count().as("depth") })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.orgId, args.commit.createArgs.orgId))
    .as("visible_launch_queue_depth");
  const [row] = await args.tx
    .with(...ctes)
    .select({
      runId: context.insertedRun.id,
      createdAt: context.insertedRun.createdAt,
      queueDepth: sql`(${visibleQueueDepth.depth} + 1)`.mapWith(
        pgInt8ToBigIntDecoder,
      ),
      boundThreadId: nullableReturnedCteId(context.updatedThread).mapWith(
        nullableDriverValueDecoder(pgTextDecoder),
      ),
    })
    .from(context.insertedRun)
    .innerJoin(insertedQueue, eq(insertedQueue.runId, context.insertedRun.id))
    .innerJoin(
      context.insertedDiagnosticRegistration,
      eq(context.insertedDiagnosticRegistration.id, context.insertedRun.id),
    )
    .crossJoin(visibleQueueDepth);
  if (!row || (context.updatedThread && !row.boundThreadId)) {
    throw new Error("Atomic queued launch persistence returned no row");
  }
  return {
    kind: "queued",
    run: runRecordFromLaunchIdentity(
      context.rowsArgs.identity,
      "queued",
      row.createdAt,
    ),
    queueDepth: Number(row.queueDepth),
    telemetryTimestamp: nowDate().toISOString(),
    threadSessionBinding: atomicThreadSessionBinding({
      context,
      commit: args.commit,
      validatedThreadSession: args.validatedThreadSession,
      boundThreadId: row.boundThreadId,
      runId: row.runId,
    }),
  };
}

// The status the caller passes as a literal selects the persisted kind, so
// each entry point returns the matching member instead of the whole union.
async function persistAtomicLaunchRows(
  args: PersistAtomicLaunchRowsArgs & { readonly status: "pending" },
): Promise<Extract<PersistedAtomicLaunchRows, { readonly kind: "pending" }>>;
async function persistAtomicLaunchRows(
  args: PersistAtomicLaunchRowsArgs & { readonly status: "queued" },
): Promise<Extract<PersistedAtomicLaunchRows, { readonly kind: "queued" }>>;
async function persistAtomicLaunchRows(
  args: PersistAtomicLaunchRowsArgs,
): Promise<PersistedAtomicLaunchRows> {
  const context = buildAtomicLaunchCteContext(args);
  const persisted = await args.commit.timing.measure(
    "api_dispatch_persist_atomic_launch",
    "nested",
    async () => {
      return args.status === "pending"
        ? await persistPendingAtomicLaunch(args, context)
        : await persistQueuedAtomicLaunch(args, context);
    },
  );

  const chatThreadId = args.commit.createArgs.chatThreadId;
  if (chatThreadId && !args.validatedThreadSession) {
    const threadSessionBinding = await persistUnvalidatedThreadSessionBinding(
      args.tx,
      {
        chatThreadId,
        identity: context.rowsArgs.identity,
        resolution: args.commit.createArgs.threadSessionResolution,
        timing: args.commit.timing,
      },
    );
    return { ...persisted, threadSessionBinding };
  }
  return persisted;
}

async function checkRunConcurrencyPreflight(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<CreateRunErrorResult | null> {
  return await args.db.transaction(async (tx) => {
    await args.timing.measure(
      "api_dispatch_concurrency_preflight_lock_wait",
      "nested",
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.orgId}))`,
        );
      },
    );
    return await args.timing.measure(
      "api_dispatch_concurrency_preflight_check",
      "nested",
      async () => {
        return await checkRunConcurrencyLimit(tx, args.orgId);
      },
    );
  });
}

async function resolveQueueFirstAdmissionForLaunch(args: {
  readonly tx: DbTransaction;
  readonly createArgs: CreateAgentRunArgs;
  readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
  readonly threadAlreadyLocked?: true;
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
    admissionTime:
      association.kind === "user_message"
        ? association.admissionTime
        : args.createArgs.apiStartTime,
    sessionSnapshotState: args.sessionSnapshotState,
    threadId: association.threadId,
    timing: args.timing,
    ...(args.threadAlreadyLocked ? { threadAlreadyLocked: true } : {}),
  });
}

async function claimQueueFirstAssociationForLaunch(args: {
  readonly tx: DbTransaction;
  readonly admission: QueueFirstRunAdmission | undefined;
  readonly createArgs: CreateAgentRunArgs;
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
    ...(args.createArgs.codexServiceTier === "fast"
      ? { serviceTier: "priority" as const }
      : {}),
    timing: args.timing,
  });
}

interface CommitFailedLaunchArgs {
  readonly db: Db;
  readonly createArgs: CreateAgentRunArgs;
  readonly context: FinalizedPreparedRunContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly launch?: PreparedRunnerLaunch;
  readonly error: unknown;
  readonly timing: ApiDispatchTimingCollector;
}

async function persistFailedLaunch(
  tx: DbTransaction,
  args: CommitFailedLaunchArgs,
  message: string,
): Promise<FailedLaunchCommitResult> {
  if (args.createArgs.piMemoryPhase2Maintenance) {
    const validate = args.createArgs.validatePiMemoryPhase2Admission;
    if (!validate) {
      throw new Error("Private maintenance requires source admission");
    }
    await validate(tx);
  }
  await acquireOfficialWorkflowRunCatalogAdmissionLock(
    tx,
    args.context.officialWorkflowRun,
  );
  if (args.context.officialWorkflowRun) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${args.createArgs.orgId}))`,
    );
  }
  const officialAdmissionFailure = await validateOfficialWorkflowRunForInsert(
    tx,
    {
      observation: args.context.officialWorkflowRun,
      orgId: args.createArgs.orgId,
      userId: args.createArgs.userId,
      agentId: args.context.resolved.agentId,
      automationId: args.createArgs.agentRunMetadata?.workflowAutomationId,
      runStorageMounts: args.launch?.runStorageMounts,
      allowMissingMountsForFailedRun: true,
    },
  );
  if (officialAdmissionFailure) {
    return conflict(officialAdmissionFailure.message);
  }
  const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
    tx,
    createArgs: args.createArgs,
    sessionSnapshotState: "unvalidated",
    timing: args.timing,
  });
  const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
    tx,
    admission: queueFirstAdmission,
    createArgs: args.createArgs,
    identity: args.identity,
    timing: args.timing,
  });
  if (queueFirstClaim?.kind === "lost") {
    return { kind: "queue-first-claim-lost" };
  }
  const { createdAt } = await insertLaunchRunRows(tx, {
    userId: args.createArgs.userId,
    orgId: args.createArgs.orgId,
    identity: args.identity,
    status: "failed",
    resolved: args.context.resolved,
    body: args.context.body,
    runStorageMounts: args.launch?.runStorageMounts,
    sessionStorageMounts: args.launch?.sessionStorageMounts,
    modelProvider: args.context.modelProvider,
    agentRunModelPin: args.createArgs.agentRunModelPin,
    selectedVideoModel: args.context.selectedVideoModel,
    selectedImageModel: args.context.selectedImageModel,
    callbackRows: args.callbackRows,
    chatThreadId: args.createArgs.chatThreadId,
    agentRunMetadata: args.createArgs.agentRunMetadata,
    apiStartTime: args.createArgs.apiStartTime,
    runnerGroup: undefined,
    launchSnapshot: args.context.launchSnapshot,
    langfuseTraceEnabled: false,
    officialWorkflowProvenance: args.context.officialWorkflowRun?.provenance,
    error: message,
    creditAdmitted: false,
  });
  return {
    kind: "failed",
    createdAt,
    queueFirstClaim,
  };
}

async function commitFailedLaunch(
  args: CommitFailedLaunchArgs,
): Promise<
  CreateRunSuccessResult | CreateRunErrorResult | QueueFirstRunClaimLost
> {
  const message = runFailureMessage(args.error);
  const committed = await args.db.transaction(async (tx) => {
    return await persistFailedLaunch(tx, args, message);
  });

  if (isRouteError(committed)) {
    return committed;
  }
  if (committed.kind === "queue-first-claim-lost") {
    return committed;
  }

  if (args.createArgs.chatThreadId) {
    recordFirstAssistantEventEligibility({
      runId: args.identity.runId,
      apiStartedAt: args.createArgs.apiStartTime,
    });
  }

  if (args.createArgs.dispatchFailedCallbacks) {
    await tapError(
      args.createArgs.dispatchFailedCallbacks(
        args.db,
        args.identity.runId,
        message,
      ),
      (error) => {
        L.error("Failed to dispatch failed-run callbacks", {
          runId: args.identity.runId,
          error,
        });
      },
    );
  }
  const response = failedRunResponse(
    runRecordFromLaunchIdentity(args.identity, "pending", committed.createdAt),
    args.error,
  );
  return committed.queueFirstClaim
    ? { ...response, queueFirstClaim: committed.queueFirstClaim }
    : response;
}

async function activatePreparedLaunchUsageAllowance(args: {
  readonly tx: DbTransaction;
  readonly commit: CommitPreparedLaunchArgs;
  readonly run: RunRecord;
}): Promise<void> {
  if (isBuiltInModelProviderType(args.commit.context.modelProvider?.type)) {
    await args.commit.timing.measure(
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
  }
}

function threadSessionBindingAction(args: {
  readonly identity: LaunchRunIdentity;
  readonly previousAgentSessionId: string | null;
  readonly resolution: ChatThreadSessionResolution | undefined;
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

async function persistUnvalidatedThreadSessionBinding(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly identity: LaunchRunIdentity;
    readonly resolution: ChatThreadSessionResolution | undefined;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<ThreadSessionBindingWrite> {
  const chatThreadId = args.chatThreadId;
  const [thread] = await args.timing.measure(
    "api_dispatch_load_thread_session_binding",
    "nested",
    async () => {
      return await tx
        .select({ agentSessionId: chatThreads.agentSessionId })
        .from(chatThreads)
        .where(eq(chatThreads.id, chatThreadId))
        .for("update")
        .limit(1);
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

function threadSessionSnapshotStale(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly identity: LaunchRunIdentity;
  readonly reason: ThreadSessionSnapshotStale["reason"];
}): ThreadSessionSnapshotStale {
  const resolution = args.createArgs.threadSessionResolution;
  const chatThreadId = args.createArgs.chatThreadId;
  if (!resolution || !chatThreadId) {
    throw new Error("Missing chat thread session snapshot");
  }
  return {
    kind: "thread-session-snapshot-stale",
    chatThreadId,
    agentSessionId: args.identity.sessionId,
    agentSessionRunId: args.identity.runId,
    resolutionAction: resolution.action,
    reason: args.reason,
  };
}

async function validateThreadSessionSnapshot(
  tx: DbTransaction,
  args: {
    readonly createArgs: CreateAgentRunArgs;
    readonly identity: LaunchRunIdentity;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<
  ThreadSessionSnapshotStale | ValidatedThreadSessionSnapshot | undefined
> {
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
        .for("update")
        .limit(1);
    },
  );
  if (!thread) {
    throw new Error("Chat thread not found while validating session snapshot");
  }
  // Even callers without a prepared snapshot later bind this thread. Take its
  // row lock before the provider lock, just like completion and timeout.
  if (!resolution) {
    return undefined;
  }
  if (
    thread.agentSessionId !== resolution.expected.agentSessionId ||
    thread.agentSessionRunId !== resolution.expected.agentSessionRunId
  ) {
    return threadSessionSnapshotStale({
      createArgs: args.createArgs,
      identity: args.identity,
      reason: "binding_changed",
    });
  }

  const expectedSessionId = resolution.expected.sessionId;
  if (expectedSessionId === null) {
    return {
      kind: "validated-thread-session-snapshot",
      chatThreadId,
      agentSessionId: thread.agentSessionId,
    };
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
    return threadSessionSnapshotStale({
      createArgs: args.createArgs,
      identity: args.identity,
      reason: "session_changed",
    });
  }
  return {
    kind: "validated-thread-session-snapshot",
    chatThreadId,
    agentSessionId: thread.agentSessionId,
  };
}

async function commitQueuedPreparedLaunch(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  queueFirstClaim: QueueFirstRunClaimed | undefined,
  validatedThreadSession: ValidatedThreadSessionSnapshot | undefined,
): Promise<Extract<AtomicLaunchCommitResult, { readonly kind: "queued" }>> {
  if (!args.encryptedQueuedParams) {
    throw new Error("Missing encrypted queued runner job payload");
  }

  const persisted = await persistAtomicLaunchRows({
    tx,
    commit: args,
    status: "queued",
    payload,
    validatedThreadSession,
  });
  await bindPreparedPiMemoryPhase2MaintenanceRun(tx, args, persisted.run.id);
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

async function commitPendingPreparedLaunch(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  queueFirstClaim: QueueFirstRunClaimed | undefined,
  validatedThreadSession: ValidatedThreadSessionSnapshot | undefined,
): Promise<Extract<AtomicLaunchCommitResult, { readonly kind: "pending" }>> {
  const persisted = await persistAtomicLaunchRows({
    tx,
    commit: args,
    status: "pending",
    payload,
    validatedThreadSession,
  });
  await bindPreparedPiMemoryPhase2MaintenanceRun(tx, args, persisted.run.id);
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

async function bindPreparedPiMemoryPhase2MaintenanceRun(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  runId: string,
): Promise<void> {
  const maintenance = args.createArgs.piMemoryPhase2Maintenance;
  if (!maintenance) {
    return;
  }
  await bindPiMemoryPhase2MaintenanceRun(tx, {
    runId,
    binding: {
      memoryStorageId: maintenance.memoryStorageId,
      orgId: args.createArgs.orgId,
      userId: args.createArgs.userId,
      leaseToken: maintenance.leaseToken,
      claimedRevision: maintenance.claimedRevision,
      claimedBaseVersionId: maintenance.claimedBaseVersionId,
      selectionDigest: maintenance.selectionDigest,
    },
  });
}

async function validateCapturedSubscriptionAccount(
  tx: Tx,
  args: CommitPreparedLaunchArgs,
  validatedThreadSession: ValidatedThreadSessionSnapshot | undefined,
) {
  const provider = args.context.modelProvider;
  if (
    provider &&
    isPersonalSubscriptionProviderType(provider.type) &&
    provider.credentialOwner === "member"
  ) {
    if (
      !args.identity.shouldCreateSession &&
      (!validatedThreadSession ||
        args.createArgs.threadSessionResolution?.expected.sessionId !==
          args.identity.sessionId)
    ) {
      // Unvalidated/session-only launches still acquire this FK lock when
      // inserting the run. A completion can hold the session before cleanup,
      // so acquire it before the provider lock too.
      await tx
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(eq(agentSessions.id, args.identity.sessionId))
        .for("key share");
    }
    await lockModelProviderState(tx, {
      orgId: args.createArgs.orgId,
      userId: args.createArgs.userId,
      type: provider.type,
    });
    const coherent = await validatePersonalSubscriptionAdmission(
      {
        db: tx,
        orgId: args.createArgs.orgId,
        userId: args.createArgs.userId,
        type: provider.type,
        sourceId: provider.id ?? undefined,
        featureSwitchContext: args.context.featureSwitchContext,
      },
      args.subscriptionAdmission,
    );
    const account =
      coherent && provider.id
        ? await personalModelProviderAccountById({
            db: tx,
            orgId: args.createArgs.orgId,
            userId: args.createArgs.userId,
            id: provider.id,
          })
        : null;
    if (!account || account.type !== provider.type) {
      return conflict(
        "The selected subscription account was disconnected. Reconnect it before starting another run.",
      );
    }
    return { identity: personalSubscriptionAccountIdentity(account) };
  }
  return undefined;
}

async function commitPreparedLaunchUnderLock(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
): Promise<AtomicLaunchCommitResult | CreateRunErrorResult> {
  const officialAdmissionFailure = await validateOfficialWorkflowRunForInsert(
    tx,
    {
      observation: args.context.officialWorkflowRun,
      orgId: args.createArgs.orgId,
      userId: args.createArgs.userId,
      agentId: args.context.resolved.agentId,
      automationId: args.createArgs.agentRunMetadata?.workflowAutomationId,
      runStorageMounts: args.launch.runStorageMounts,
      allowMissingMountsForFailedRun: false,
    },
  );
  if (officialAdmissionFailure) {
    return conflict(officialAdmissionFailure.message);
  }
  const threadSessionValidation = await validateThreadSessionSnapshot(tx, {
    createArgs: args.createArgs,
    identity: args.identity,
    timing: args.timing,
  });
  let capturedIdentity: string | null = null;
  if (threadSessionValidation?.kind !== "thread-session-snapshot-stale") {
    if (args.createArgs.piMemoryPhase2Maintenance) {
      const validate = args.createArgs.validatePiMemoryPhase2Admission;
      if (!validate) {
        throw new Error("Private maintenance requires source admission");
      }
      await validate(tx);
    }
    const failure = await validateCapturedSubscriptionAccount(
      tx,
      args,
      threadSessionValidation,
    );
    if (failure && "identity" in failure) {
      capturedIdentity = failure.identity;
    } else if (failure) {
      return failure;
    }
  }
  const result = await commitValidatedPreparedLaunch(
    tx,
    args,
    payload,
    threadSessionValidation,
  );
  if (
    capturedIdentity &&
    "kind" in result &&
    (result.kind === "pending" || result.kind === "queued")
  ) {
    // The new run and its validated account are still owned by this admission
    // transaction. Historical and preparation-failure rows remain unknown.
    await tx
      .update(agentRuns)
      .set({ modelProviderAccountIdentity: capturedIdentity })
      .where(eq(agentRuns.id, result.run.id));
  }
  return result;
}

async function commitValidatedPreparedLaunch(
  tx: DbTransaction,
  args: CommitPreparedLaunchArgs,
  payload: RunnerJobPayload,
  threadSessionValidation: Awaited<
    ReturnType<typeof validateThreadSessionSnapshot>
  >,
): Promise<AtomicLaunchCommitResult | CreateRunErrorResult> {
  if (threadSessionValidation?.kind === "thread-session-snapshot-stale") {
    const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
      tx,
      createArgs: args.createArgs,
      sessionSnapshotState: threadSessionValidation.reason,
      threadAlreadyLocked: true,
      timing: args.timing,
    });
    if (!queueFirstAdmission || queueFirstAdmission.kind === "idle") {
      return threadSessionValidation;
    }
    const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
      tx,
      admission: queueFirstAdmission,
      createArgs: args.createArgs,
      identity: args.identity,
      timing: args.timing,
    });
    if (queueFirstClaim?.kind !== "lost") {
      throw new Error("Blocked queue-first admission must lose its claim");
    }
    return { kind: "queue-first-claim-lost" };
  }
  const validatedThreadSession = threadSessionValidation;
  const concurrency = await args.timing.measure(
    "api_dispatch_check_concurrency_limit",
    "nested",
    async () => {
      return await checkRunConcurrencyLimit(tx, args.createArgs.orgId);
    },
  );

  if (concurrency) {
    if (!args.createArgs.queueOnConcurrencyLimit) {
      return concurrency;
    }
    if (!args.encryptedQueuedParams) {
      return { kind: "queue-payload-required" };
    }
    const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
      tx,
      createArgs: args.createArgs,
      sessionSnapshotState: validatedThreadSession ? "current" : "unvalidated",
      ...(validatedThreadSession ? { threadAlreadyLocked: true } : {}),
      timing: args.timing,
    });
    const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
      tx,
      admission: queueFirstAdmission,
      createArgs: args.createArgs,
      identity: args.identity,
      timing: args.timing,
    });
    if (queueFirstClaim?.kind === "lost") {
      return { kind: "queue-first-claim-lost" };
    }
    return await commitQueuedPreparedLaunch(
      tx,
      args,
      payload,
      queueFirstClaim,
      validatedThreadSession,
    );
  }

  const queueFirstAdmission = await resolveQueueFirstAdmissionForLaunch({
    tx,
    createArgs: args.createArgs,
    sessionSnapshotState: validatedThreadSession ? "current" : "unvalidated",
    ...(validatedThreadSession ? { threadAlreadyLocked: true } : {}),
    timing: args.timing,
  });
  const queueFirstClaim = await claimQueueFirstAssociationForLaunch({
    tx,
    admission: queueFirstAdmission,
    createArgs: args.createArgs,
    identity: args.identity,
    timing: args.timing,
  });
  if (queueFirstClaim?.kind === "lost") {
    return { kind: "queue-first-claim-lost" };
  }
  return await commitPendingPreparedLaunch(
    tx,
    args,
    payload,
    queueFirstClaim,
    validatedThreadSession,
  );
}

async function commitPreparedLaunch(
  args: CommitPreparedLaunchArgs,
): Promise<AtomicLaunchCommitCompletion> {
  const committed = await args.db.transaction(async (tx) => {
    const payload = queuedRunnerJobPayload({
      ...args.launch.runnerJobPayload,
      reuseKey: runnerReuseKey(args.createArgs.chatThreadId),
    });
    await acquireOfficialWorkflowRunCatalogAdmissionLock(
      tx,
      args.context.officialWorkflowRun,
    );
    await args.timing.measure(
      "api_dispatch_admission_lock_wait",
      "nested",
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${args.createArgs.orgId}))`,
        );
      },
    );
    const admissionLockHeldStartedAt = now();
    const result = await commitPreparedLaunchUnderLock(tx, args, payload);
    if (
      "kind" in result &&
      (result.kind === "pending" || result.kind === "queued")
    ) {
      await requestPiMemoryStage1Day(tx, {
        ...result.run,
        userId: args.createArgs.userId,
        orgId: args.createArgs.orgId,
        chatThreadId: args.createArgs.chatThreadId ?? null,
        triggerSource: args.context.body.triggerSource,
        launchSnapshot: args.context.launchSnapshot,
        completedAt: null,
      });
    }
    return { result, admissionLockHeldStartedAt };
  });
  const transactionReturnedAt = now();
  args.timing.recordElapsed(
    "api_dispatch_admission_lock_held",
    "nested",
    committed.admissionLockHeldStartedAt,
  );
  return {
    result: committed.result,
    transactionReturnedAt,
  };
}

function buildAtomicLaunchPayload(
  db: Db,
  args: {
    readonly createArgs: CreateAgentRunArgs;
    readonly context: FinalizedPreparedRunContext;
    readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Computed<Promise<PreparedRunnerLaunch>> {
  return buildRunnerJobPayload(
    db,
    {
      run: args.run,
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
      okouTokenCloudBrowserEnabled:
        args.createArgs.okouTokenCloudBrowserEnabled,
      imageRecognitionAvailable: args.context.imageRecognitionAvailable,
      chatThreadId: args.createArgs.chatThreadId,
      platformEnvironment: withDefaultImageModelPlatformEnvironment(
        args.createArgs.platformEnvironment,
        args.context.selectedImageModel,
      ),
      userTimezone: args.context.userTimezone,
      featureSwitchContext: args.context.featureSwitchContext,
      timing: args.timing,
      piMemoryPhase2Maintenance: args.createArgs.piMemoryPhase2Maintenance,
    },
    signal,
  );
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

function failedRunResponse(
  run: RunRecord,
  error: unknown,
): Extract<CreateRunRouteResult, { readonly status: 201 }> {
  return {
    status: 201,
    body: {
      runId: run.id,
      status: "failed",
      sessionId: run.sessionId,
      error: runFailureMessage(error),
      createdAt: run.createdAt.toISOString(),
    },
  };
}

// Compatibility sentinel for rows created by pre-#22608 server versions.
export const BEFORE_DISPATCH_CANCELLED_ERROR =
  "Run dispatch cancelled before runner queue persistence";

interface PreparedRunContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly imageRecognitionAvailable: boolean;
  /** Snapshotted onto the run row; see `resolveMediaModelsForRun`. */
  readonly selectedVideoModel: string;
  /** Resolved once at run start and used as the run's built-in image default. */
  readonly selectedImageModel: ImageModel | null;
}

interface FinalizedPreparedRunContext extends PreparedRunContext {
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
}

async function materializePreparedPiProvider(
  createArgs: CreateAgentRunArgs,
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
  if (!("schemaVersion" in config) || config.schemaVersion !== 4) {
    if (
      !("schemaVersion" in config) &&
      (provider.type === "deepseek" || provider.type === "openrouter-codex") &&
      provider.selectedModel?.startsWith("deepseek-v4-")
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
  // The writer and CLI reader are built from the same commit. A mutable or
  // differently pinned package cannot consume a newly captured native route.
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
      "Native Pi requires the current commit-addressed CLI reader artifact",
    );
  }
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

function resolvePreparedPiModelConfig(args: {
  readonly createArgs: CreateAgentRunArgs;
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
  db: Db,
  args: CreateAgentRunArgs,
  options: {
    readonly content: AgentExecutionConfig;
    readonly framework: SupportedFramework;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
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
        orgId: args.orgId,
        userId: args.userId,
        framework: options.framework,
        modelProviderId: args.modelProviderId,
        modelProviderCredentialScope: args.modelProviderCredentialScope,
        modelProviderType: args.modelProviderType,
        selectedModelOverride: args.selectedModelOverride,
        builtInModelRuntimeRoute: args.builtInModelRuntimeRoute,
        piExecution: args.piExecution,
        featureSwitchContext: options.featureSwitchContext,
      })
    : null;
  signal.throwIfAborted();

  if (!shouldResolveModelProvider || modelProvider) {
    return modelProvider;
  }

  if (
    args.enforceBuiltInCredits &&
    isBuiltInModelProviderType(args.modelProviderType)
  ) {
    const creditGate =
      (await checkOrgCreditsForRunAdmission({
        db,
        orgId: args.orgId,
        userId: args.userId,
        modelProviderType: "built-in",
        selectedModel: args.selectedModelOverride,
      })) ?? null;
    signal.throwIfAborted();
    if (creditGate) {
      return creditGate;
    }
  }

  return providerUnavailable(
    `No model provider configured and ${frameworkApiKeyEnv(options.framework)} is not declared in compose environment`,
  );
}

function loadRunFeatureSwitchContext(
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get): Promise<FeatureSwitchContext> => {
    const overrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    return { orgId: args.orgId, userId: args.userId, overrides };
  });
}

async function loadUserTimezone(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<string | undefined> {
  const [row] = await db
    .select({ timezone: orgMembersMetadata.timezone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);

  return row?.timezone ?? undefined;
}

async function resolvePreparedUserTimezone(input: {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly preloadedUserTimezone: string | null | undefined;
}): Promise<string | undefined> {
  return await input.timing.measure(
    "api_dispatch_prepare_context_load_user_timezone",
    "nested",
    async () => {
      if (input.preloadedUserTimezone !== undefined) {
        return input.preloadedUserTimezone ?? undefined;
      }
      return await loadUserTimezone(input.db, input.args);
    },
    {
      user_timezone_source:
        input.preloadedUserTimezone === undefined ? "database" : "preloaded",
    },
  );
}

async function loadRunConnectorContexts(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorScope: EffectiveConnectorScope;
    readonly threadConnectorSelectionIds:
      | ThreadConnectorSelectionIds
      | undefined;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timing: ApiDispatchTimingCollector | undefined;
  },
  signal: AbortSignal,
): Promise<{
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}> {
  const [storedConnectorSnapshot, customConnectorContext] = await Promise.all([
    measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_context_load_stored_connectors",
      "nested",
      async () => {
        return await loadStoredConnectorMaterializationPlan(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
            connectorIdCandidatesBySlug:
              args.threadConnectorSelectionIds?.connectorIdCandidatesBySlug,
            scopeSource: args.connectorScope.source,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          },
          args.timing,
        );
      },
      storedConnectorTimingDimensions({
        scopeSource: args.connectorScope.source,
      }),
    ),
    measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_context_load_custom_connectors",
      "nested",
      async () => {
        return await loadCustomConnectorContext(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            allowedCustomConnectorIds:
              args.connectorScope.allowedCustomConnectorIds,
            connectorIdCandidatesByCustomConnectorId:
              args.threadConnectorSelectionIds
                ?.connectorIdCandidatesByCustomConnectorId,
            customConnectorGrants: args.connectorScope.customConnectorGrants,
            featureSwitchContext: args.featureSwitchContext,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
          },
          signal,
          args.timing,
        );
      },
    ),
  ]);
  return {
    storedConnectorSnapshot,
    storedConnectorMetadataContext: storedConnectorContextFromSnapshot(
      storedConnectorSnapshot,
    ),
    customConnectorContext,
  };
}

async function buildResolvedRunBody(
  args: {
    readonly initialBody: CreateRunBody;
    readonly resolved: ResolvedRunExecution;
    readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly canonicalOkouRuntime: boolean;
  },
  signal: AbortSignal,
): Promise<CreateRunBody> {
  const runVars =
    args.initialBody.vars !== undefined
      ? args.initialBody.vars
      : args.resolved.vars;
  const mergedVars = buildMergedVariables({
    persistedEnvironment: args.persistedEnvironment,
    runVars,
  });
  const vars = args.canonicalOkouRuntime
    ? withoutLegacyAgentRunEnvironmentEntries(mergedVars)
    : mergedVars;
  signal.throwIfAborted();

  const body: CreateRunBody = {
    ...args.initialBody,
    vars,
    volumeVersions:
      args.initialBody.volumeVersions !== undefined
        ? args.initialBody.volumeVersions
        : args.resolved.volumeVersions,
  };
  const mergedSecrets = await buildReferencedSecrets({
    content: args.resolved.content,
    runSecrets: body.secrets,
    persistedEnvironment: args.persistedEnvironment,
    featureSwitchContext: args.featureSwitchContext,
  });
  signal.throwIfAborted();

  return {
    ...body,
    secrets: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedSecrets)
      : mergedSecrets,
  };
}

function validateRunEnvironmentReferences(args: {
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
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

async function buildPreparedPermissionManifest(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: CreateRunBody;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
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
  readonly createArgs: CreateAgentRunArgs;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly skillsRoot: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}): PreparedAdditionalVolumes {
  const bodyAdditionalVolumes = args.body.additionalVolumes;
  const injectedSkillVolumes = buildInjectedSkillVolumes(
    {
      injectSkillVolumes: args.createArgs.injectSkillVolumes,
      systemSkillStorageResolution: args.systemSkillStorageResolution,
      introVideoEnabled:
        args.createArgs.introVideoEnabled ??
        isFeatureEnabled(
          FeatureSwitchKey.IntroVideo,
          args.featureSwitchContext,
        ),
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

interface PreparedRunBodyContext {
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly requestedFramework: SupportedFramework;
  readonly featureSwitchContext: FeatureSwitchContext;
}

interface PreparedRuntimeContext {
  readonly framework: SupportedFramework;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: SupportedRunModel | undefined;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

interface PreparedConnectorContext {
  readonly connectorContext: ConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
}

function connectorScopeForRuntimeSnapshot(
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

function connectorScopeFromCreateArgs(
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

function loadPreparedRunFeatureSwitchContext(
  args: {
    readonly createArgs: CreateAgentRunArgs;
    readonly preloaded: FeatureSwitchContext | undefined;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get) => {
    return await args.timing.measure(
      "api_dispatch_prepare_context_feature_switches",
      "nested",
      async () => {
        if (args.preloaded !== undefined) {
          signal.throwIfAborted();
          return args.preloaded;
        }
        return await get(loadRunFeatureSwitchContext(args.createArgs, signal));
      },
      {
        feature_switch_context_source:
          args.preloaded === undefined ? "database" : "preloaded",
      },
    );
  });
}

function agentRunResolutionOptions(
  args: CreateAgentRunArgs,
): Pick<
  ResolveAgentExecutionOptions,
  "productAgentExecutionPlan" | "testOnlyResolveDirectRun"
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
  const privateMaintenanceIdentity =
    productAgentExecutionPlan?.identity === "pi-memory-phase2-maintenance";
  if (
    privateMaintenanceIdentity !==
    (args.piMemoryPhase2Maintenance !== undefined)
  ) {
    throw new Error(
      "Pi memory maintenance payload and execution identity must match",
    );
  }
  if (args.validatePiMemoryPhase2Admission && !privateMaintenanceIdentity) {
    throw new Error("Phase 2 admission belongs only to private maintenance");
  }
  if (
    privateMaintenanceIdentity &&
    (args.body.agentId !== undefined ||
      args.body.sessionId !== undefined ||
      args.chatThreadId !== undefined ||
      args.piExecution !== true)
  ) {
    throw new Error(
      "Pi memory maintenance runs must use a private threadless identity",
    );
  }
  return {
    productAgentExecutionPlan,
    testOnlyResolveDirectRun,
  };
}

function prepareRunBodyContext(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly preloadedFeatureSwitchContext: FeatureSwitchContext | undefined;
    readonly timing: ApiDispatchTimingCollector;
    readonly initialBody: CreateRunBody;
  },
  signal: AbortSignal,
): Computed<Promise<PreparedRunBodyContext | CreateRunErrorResult>> {
  return computed(async (get) => {
    const canonicalOkouRuntime =
      args.createArgs.includeOkouTokenSecret === true;
    const resolutionOptions = agentRunResolutionOptions(args.createArgs);
    const featureSwitchContext = await get(
      loadPreparedRunFeatureSwitchContext(
        {
          createArgs: args.createArgs,
          preloaded: args.preloadedFeatureSwitchContext,
          timing: args.timing,
        },
        signal,
      ),
    );
    const persistedResolved = await args.timing.measure(
      "api_dispatch_prepare_context_resolve_agent_execution",
      "nested",
      async () => {
        return await get(
          resolveAgentExecution(
            args.db,
            args.initialBody,
            args.createArgs.userId,
            args.createArgs.orgId,
            {
              ...resolutionOptions,
              timing: args.timing,
            },
          ),
        );
      },
    );
    signal.throwIfAborted();
    if (isRouteError(persistedResolved)) {
      return persistedResolved;
    }
    const resolved = persistedResolved;
    if (resolved.orgId !== args.createArgs.orgId) {
      return notFound("Resource not found");
    }
    const connectorScope = connectorScopeFromCreateArgs(args.createArgs);
    const persistedEnvironment = await args.timing.measure(
      "api_dispatch_prepare_context_load_persisted_environment",
      "nested",
      async () => {
        return await loadPersistedRunEnvironmentSnapshot(args.db, {
          orgId: args.createArgs.orgId,
          userId: args.createArgs.userId,
          content: resolved.content,
        });
      },
    );
    signal.throwIfAborted();
    const body = await args.timing.measure(
      "api_dispatch_prepare_context_build_resolved_body",
      "nested",
      async () => {
        return await buildResolvedRunBody(
          {
            initialBody: args.initialBody,
            resolved,
            persistedEnvironment,
            featureSwitchContext,
            canonicalOkouRuntime,
          },
          signal,
        );
      },
    );
    const requestedFrameworkResult = await args.timing.measure(
      "api_dispatch_prepare_context_resolve_framework",
      "nested",
      async () => {
        const frameworkValidation = validateRunFramework(
          resolved.content,
          body,
        );
        if (isRouteError(frameworkValidation)) {
          return frameworkValidation;
        }
        return await resolveRequestedRunFramework(
          args.db,
          args.createArgs,
          frameworkValidation.framework,
        );
      },
    );
    signal.throwIfAborted();
    if (isRouteError(requestedFrameworkResult)) {
      return requestedFrameworkResult;
    }
    return {
      body,
      resolved,
      connectorScope,
      requestedFramework: requestedFrameworkResult,
      featureSwitchContext,
    };
  });
}

async function prepareRunConnectorContexts(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly connectorScope: EffectiveConnectorScope;
    readonly threadConnectorSelectionIds:
      | ThreadConnectorSelectionIds
      | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly connectorCatalogSelection: RunConnectorCatalogSelection;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
): Promise<
  Awaited<ReturnType<typeof loadRunConnectorContexts>> | CreateRunErrorResult
> {
  const result = await settle(
    args.timing.measure(
      "api_dispatch_prepare_context_load_connector_contexts",
      "nested",
      async () => {
        if (args.connectorCatalogSelection.kind === "empty") {
          const [storedConnectorSnapshot, customConnectorContext] =
            await Promise.all([
              measureApiDispatchTiming(
                args.timing,
                "api_dispatch_prepare_context_load_stored_connectors",
                "nested",
                () => {
                  return null;
                },
                storedConnectorTimingDimensions({
                  scopeSource: args.connectorScope.source,
                }),
              ),
              measureApiDispatchTiming(
                args.timing,
                "api_dispatch_prepare_context_load_custom_connectors",
                "nested",
                () => {
                  return emptyCustomConnectorRuntimeContext();
                },
              ),
            ]);
          return {
            storedConnectorSnapshot,
            storedConnectorMetadataContext: emptyConnectorRuntimeContext(),
            customConnectorContext,
          };
        }
        return await loadRunConnectorContexts(
          args.db,
          {
            orgId: args.createArgs.orgId,
            userId: args.createArgs.userId,
            connectorScope: args.connectorScope,
            threadConnectorSelectionIds: args.threadConnectorSelectionIds,
            connectorCatalogSnapshot: args.connectorCatalogSelection.selection,
            featureSwitchContext: args.featureSwitchContext,
            timing: args.timing,
          },
          signal,
        );
      },
      storedConnectorTimingDimensions({
        scopeSource: args.connectorScope.source,
      }),
    ),
  );
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

async function resolvePreparedRunModelProvider(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly timing: ApiDispatchTimingCollector;
    readonly bodyContext: PreparedRunBodyContext;
  },
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  const { resolved, requestedFramework, featureSwitchContext } =
    args.bodyContext;
  return await args.timing.measure(
    "api_dispatch_prepare_context_resolve_model_provider",
    "nested",
    async () => {
      return await resolveRunModelProvider(
        args.db,
        args.createArgs,
        {
          content: resolved.content,
          framework: requestedFramework,
          featureSwitchContext,
        },
        signal,
      );
    },
  );
}

async function resolvePreparedThreadConnectorSelections(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly connectorScope: EffectiveConnectorScope;
  },
  signal: AbortSignal,
): Promise<ThreadConnectorSelectionIds | CreateRunErrorResult | undefined> {
  const chatThreadId = args.createArgs.chatThreadId;
  if (chatThreadId === undefined) {
    return undefined;
  }
  const resolved = await resolveChatThreadConnectorSelections(args.db, {
    orgId: args.createArgs.orgId,
    userId: args.createArgs.userId,
    chatThreadId,
    scope: {
      allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
      allowedCustomConnectorIds: args.connectorScope.allowedCustomConnectorIds,
      customConnectorGrants: args.connectorScope.customConnectorGrants ?? [],
    },
    connectorSourceId: args.createArgs.connectorSourceId,
  });
  signal.throwIfAborted();
  if (resolved.kind === "invalid") {
    return badRequestMessage(resolved.message);
  }
  return {
    connectorIdCandidatesBySlug: resolved.connectorIdCandidatesBySlug,
    connectorIdCandidatesByCustomConnectorId:
      resolved.connectorIdCandidatesByCustomConnectorId,
  };
}

function piConfigurationRouteError(
  error: unknown,
): ReturnType<typeof badRequestMessage> {
  if (error instanceof PiNativeConfigurationError) {
    return badRequestMessage(error.message);
  }
  throw error;
}

async function materializeResolvedPiProvider(
  createArgs: CreateAgentRunArgs,
  modelProviderResult: PromiseSettledResult<
    Awaited<ReturnType<typeof resolvePreparedRunModelProvider>>
  >,
  signal: AbortSignal,
): Promise<ResolvedModelProviderEnvironment | null | CreateRunErrorResult> {
  if (modelProviderResult.status === "rejected") {
    return piConfigurationRouteError(modelProviderResult.reason);
  }
  const resolvedModelProvider = modelProviderResult.value;
  if (isRouteError(resolvedModelProvider)) {
    return resolvedModelProvider;
  }
  const materializedProvider = await settle(
    materializePreparedPiProvider(createArgs, resolvedModelProvider),
    signal,
  );
  if (!materializedProvider.ok) {
    return piConfigurationRouteError(materializedProvider.error);
  }
  return materializedProvider.value;
}

async function prepareRunRuntimeContext(
  args: {
    readonly db: Db;
    readonly createArgs: CreateAgentRunArgs;
    readonly connectorScope: EffectiveConnectorScope;
    readonly preloadedConnectorCatalogSnapshot?: ConnectorRuntimeSelection;
    readonly timing: ApiDispatchTimingCollector;
    readonly bodyContext: PreparedRunBodyContext;
  },
  signal: AbortSignal,
): Promise<PreparedRuntimeContext | CreateRunErrorResult> {
  const { body, resolved, requestedFramework, featureSwitchContext } =
    args.bodyContext;
  const [
    connectorCatalogSelectionResult,
    threadConnectorSelectionIdsResult,
    modelProviderResult,
  ] = await Promise.allSettled([
    connectorCatalogSelectionForRun({
      ...args,
      orgId: args.createArgs.orgId,
    }),
    args.timing.measure(
      "api_dispatch_prepare_context_resolve_thread_connector_selections",
      "nested",
      () => {
        return resolvePreparedThreadConnectorSelections(
          {
            db: args.db,
            createArgs: args.createArgs,
            connectorScope: args.connectorScope,
          },
          signal,
        );
      },
    ),
    resolvePreparedRunModelProvider(args, signal),
  ]);
  if (connectorCatalogSelectionResult.status === "rejected") {
    throw connectorCatalogSelectionResult.reason;
  }
  const connectorCatalogSelection = connectorCatalogSelectionResult.value;
  signal.throwIfAborted();
  if (threadConnectorSelectionIdsResult.status === "rejected") {
    throw threadConnectorSelectionIdsResult.reason;
  }
  const threadConnectorSelectionIds = threadConnectorSelectionIdsResult.value;
  if (isRouteError(threadConnectorSelectionIds)) {
    return threadConnectorSelectionIds;
  }
  const connectorScope =
    connectorCatalogSelection.kind === "scoped"
      ? connectorScopeForRuntimeSnapshot(
          args.connectorScope,
          connectorCatalogSelection.selection,
        )
      : args.connectorScope;
  const modelProvider = await materializeResolvedPiProvider(
    args.createArgs,
    modelProviderResult,
    signal,
  );
  if (isRouteError(modelProvider)) {
    return modelProvider;
  }
  const framework = modelProvider
    ? modelProviderFramework(modelProvider)
    : requestedFramework;
  const connectorContexts = await prepareRunConnectorContexts(
    {
      ...args,
      connectorScope,
      threadConnectorSelectionIds,
      featureSwitchContext,
      connectorCatalogSelection,
    },
    signal,
  );
  if (isRouteError(connectorContexts)) {
    return connectorContexts;
  }
  const {
    storedConnectorSnapshot,
    storedConnectorMetadataContext,
    customConnectorContext,
  } = connectorContexts;
  signal.throwIfAborted();
  const preparedConnectorContext = await materializePreparedConnectorContext({
    db: args.db,
    connectorScope,
    connectorCatalogSelection,
    body,
    content: resolved.content,
    modelProvider,
    storedConnectorSnapshot,
    storedConnectorMetadataContext,
    customConnectorContext,
    featureSwitchContext,
    timing: args.timing,
  });
  signal.throwIfAborted();
  if (isRouteError(preparedConnectorContext)) {
    return preparedConnectorContext;
  }
  const { connectorContext, permissionManifest } = preparedConnectorContext;
  const modelUsageContext = prepareModelUsageContext({
    modelProvider,
    permissionManifest,
  });
  if (isRouteError(modelUsageContext)) {
    return modelUsageContext;
  }
  return {
    framework,
    modelProvider,
    connectorContext,
    customConnectorContext,
    permissionManifest,
    billableFirewalls: modelUsageContext.billableFirewalls,
    modelUsageProvider: modelUsageContext.modelUsageProvider,
    connectorScope,
    connectorCatalogSelection,
  };
}

async function materializePreparedConnectorContext(args: {
  readonly db: Db;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: CreateRunBody;
  readonly content: AgentExecutionConfig;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: ConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PreparedConnectorContext | CreateRunErrorResult> {
  const timingDimensions = storedConnectorTimingDimensions({
    scopeSource: args.connectorScope.source,
    connectorCount:
      args.storedConnectorSnapshot?.allowedConnectorRows.length ?? 0,
  });
  const overriddenSecretAliases = overriddenRuntimeSecretAliases([
    args.modelProvider?.secrets,
    args.modelProvider?.secretConnectorMap,
    args.body.secrets,
  ]);
  const [connectorContext, permissionManifest] = await Promise.all([
    materializeStoredConnectorContext(
      args.storedConnectorSnapshot,
      { timingDimensions },
      args.timing,
    ),
    args.timing.measure(
      "api_dispatch_prepare_context_build_permission_manifest",
      "nested",
      async () => {
        return await buildPreparedPermissionManifest({
          connectorCatalogSelection: args.connectorCatalogSelection,
          body: args.body,
          modelProvider: args.modelProvider,
          storedConnectorMetadataContext: args.storedConnectorMetadataContext,
          customConnectorContext: args.customConnectorContext,
          timing: args.timing,
        });
      },
    ),
  ]);
  if (isRouteError(permissionManifest)) {
    return permissionManifest;
  }
  return {
    connectorContext: await materializeEagerStoredConnectorSecrets(
      args.db,
      args.storedConnectorSnapshot,
      connectorContext,
      {
        featureSwitchContext: args.featureSwitchContext,
        ...eagerStoredConnectorSecretInputs({
          content: args.content,
          modelProvider: args.modelProvider,
          connectorContext,
        }),
        environmentSecretPlaceholders:
          permissionManifest?.environmentSecretPlaceholders,
        overriddenSecretAliases,
        timingDimensions,
      },
      args.timing,
    ),
    permissionManifest,
  };
}

async function connectorCatalogSelectionForRun(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly preloadedConnectorCatalogSnapshot?: ConnectorRuntimeSelection;
  readonly connectorScope: EffectiveConnectorScope;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<RunConnectorCatalogSelection> {
  return await args.timing.measure(
    "api_dispatch_prepare_context_select_connector_catalog",
    "nested",
    async () => {
      if (isEmptyRunConnectorScope(args.connectorScope)) {
        return { kind: "empty" };
      }
      if (args.preloadedConnectorCatalogSnapshot !== undefined) {
        return {
          kind: "scoped",
          selection: args.preloadedConnectorCatalogSnapshot,
        };
      }
      const metadataConnectorSlugs =
        await loadCustomConnectorPermissionBundleDependencySlugs(args.db, {
          orgId: args.orgId,
          customConnectorIds: args.connectorScope.allowedCustomConnectorIds,
        });
      const selection = await loadConnectorRuntimeSelection(args.db, {
        timing: args.timing,
        requestedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
        metadataConnectorSlugs,
      });
      return { kind: "scoped", selection };
    },
  );
}

function prepareRunOutputMetadata(args: {
  readonly createArgs: CreateAgentRunArgs;
  readonly systemSkillStorageResolution: SystemSkillStorageResolution;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly body: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}): {
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
} {
  const additionalVolumes = preparedRunAdditionalVolumes({
    createArgs: args.createArgs,
    systemSkillStorageResolution: args.systemSkillStorageResolution,
    connectorScope: args.connectorScope,
    connectorCatalogSelection: args.connectorCatalogSelection,
    customConnectorContext: args.customConnectorContext,
    skillsRoot: skillsRootForRun(args.framework, args.piSandbox),
    featureSwitchContext: args.featureSwitchContext,
    body: args.body,
    resolved: args.resolved,
    officialWorkflowRun: args.officialWorkflowRun,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    piSandbox: args.piSandbox,
    includeAutoMemory: true,
    bodyArtifacts: args.body.artifacts,
  }).artifacts;
  return {
    additionalVolumes: additionalVolumes.volumes,
    additionalVolumeSources: additionalVolumes.sources,
    artifacts,
  };
}

function skillsRootForRun(
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

interface PrepareRunContextInput {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly preloadedFeatureSwitchContext: FeatureSwitchContext | undefined;
  readonly preloadedUserTimezone: string | null | undefined;
  readonly preloadedConnectorCatalogSnapshot:
    | ConnectorRuntimeSelection
    | undefined;
}

function prepareRunContexts(
  input: PrepareRunContextInput,
  initialBody: CreateRunBody,
  signal: AbortSignal,
): Computed<
  Promise<
    | CreateRunErrorResult
    | {
        readonly bodyContext: PreparedRunBodyContext;
        readonly runtimeContext: PreparedRuntimeContext;
      }
  >
> {
  return computed(async (get) => {
    const bodyContext = await get(
      prepareRunBodyContext(
        {
          db: input.db,
          createArgs: input.args,
          preloadedFeatureSwitchContext: input.preloadedFeatureSwitchContext,
          timing: input.timing,
          initialBody,
        },
        signal,
      ),
    );
    if (isRouteError(bodyContext)) {
      return bodyContext;
    }
    const runtimeContext = await prepareRunRuntimeContext(
      {
        db: input.db,
        createArgs: input.args,
        connectorScope: bodyContext.connectorScope,
        preloadedConnectorCatalogSnapshot:
          input.preloadedConnectorCatalogSnapshot,
        timing: input.timing,
        bodyContext,
      },
      signal,
    );
    if (isRouteError(runtimeContext)) {
      return runtimeContext;
    }
    return { bodyContext, runtimeContext };
  });
}

function resolveCompatibleDirectResumeSession(args: {
  readonly resolved: ResolvedRunExecution;
  readonly next: SessionExecutionIdentity;
}): ResolvedRunExecution {
  const previous = args.resolved.resumeSessionIdentity;
  return previous && canReuseSession(previous, args.next)
    ? args.resolved
    : { ...args.resolved, resumeSession: undefined };
}

async function resolvePreparedOfficialWorkflowRun(
  db: Db,
  args: CreateAgentRunArgs,
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
  signal: AbortSignal,
): Promise<OfficialWorkflowRunObservation | CreateRunErrorResult | undefined> {
  const candidates = safeSync(() => {
    return officialWorkflowRunCandidates(
      args.injectSkillVolumes?.workflows ?? [],
      skillsRootForRun(framework, piSandbox),
      args.requiredOfficialWorkflowIds ?? [],
    );
  });
  if ("error" in candidates) {
    signal.throwIfAborted();
    if (candidates.error instanceof OfficialWorkflowRunAdmissionError) {
      return conflict(candidates.error.message);
    }
    throw candidates.error;
  }
  const resolved = await settle(
    resolveOfficialWorkflowRunObservation(db, candidates.ok, signal),
    signal,
  );
  if (resolved.ok) {
    return resolved.value;
  }
  signal.throwIfAborted();
  if (resolved.error instanceof OfficialWorkflowRunAdmissionError) {
    return conflict(resolved.error.message);
  }
  throw resolved.error;
}

async function resolvePreparedMediaModels(
  db: Db,
  args: CreateAgentRunArgs,
  signal: AbortSignal,
) {
  const models = await resolveMediaModelsForRun({
    db,
    orgId: args.orgId,
    userId: args.userId,
    chatThreadId: args.chatThreadId,
  });
  signal.throwIfAborted();
  return models;
}

function prepareRunContext(
  input: PrepareRunContextInput,
  signal: AbortSignal,
): Computed<Promise<PreparedRunContext | CreateRunErrorResult>> {
  const { db, args, timing } = input;
  return computed(
    async (get): Promise<PreparedRunContext | CreateRunErrorResult> => {
      const initialBody = initialRunBody(args);
      const captureGate = enforceCaptureNetworkBodiesGate(
        args.orgId,
        initialBody.captureNetworkBodies,
      );
      if (captureGate) {
        return captureGate;
      }

      const contexts = await get(
        prepareRunContexts(input, initialBody, signal),
      );
      if (isRouteError(contexts)) {
        return contexts;
      }
      const { bodyContext, runtimeContext } = contexts;
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

      const validation = await timing.measure(
        "api_dispatch_prepare_context_validate_environment",
        "nested",
        async () => {
          return await Promise.resolve(
            validateRunEnvironmentReferences({
              resolved,
              body,
              modelProvider: runtimeContext.modelProvider,
              connectorContext: runtimeContext.connectorContext,
              customConnectorContext: runtimeContext.customConnectorContext,
              permissionManifest: runtimeContext.permissionManifest,
              validateEnvironmentReferences: args.validateEnvironmentReferences,
            }),
          );
        },
      );
      if (validation) {
        return validation;
      }

      const userTimezone = await resolvePreparedUserTimezone(input);
      signal.throwIfAborted();

      const { selectedVideoModel, selectedImageModel } =
        await resolvePreparedMediaModels(db, args, signal);

      const officialWorkflowRun = await resolvePreparedOfficialWorkflowRun(
        db,
        args,
        runtimeContext.framework,
        piSandbox,
        signal,
      );
      signal.throwIfAborted();
      if (isRouteError(officialWorkflowRun)) {
        return officialWorkflowRun;
      }

      const outputMetadata = await timing.measure(
        "api_dispatch_prepare_context_prepare_output_metadata",
        "nested",
        async () => {
          return await Promise.resolve(
            prepareRunOutputMetadata({
              createArgs: args,
              systemSkillStorageResolution: get(systemSkillStorageResolution$),
              connectorScope: runtimeContext.connectorScope,
              connectorCatalogSelection:
                runtimeContext.connectorCatalogSelection,
              customConnectorContext: runtimeContext.customConnectorContext,
              framework: runtimeContext.framework,
              piSandbox,
              featureSwitchContext: bodyContext.featureSwitchContext,
              body,
              resolved,
              officialWorkflowRun,
            }),
          );
        },
      );

      return {
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
        artifacts: outputMetadata.artifacts,
        additionalVolumes: outputMetadata.additionalVolumes,
        additionalVolumeSources: outputMetadata.additionalVolumeSources,
        officialWorkflowRun,
        userTimezone,
        featureSwitchContext: bodyContext.featureSwitchContext,
        selectedVideoModel,
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
    },
  );
}

function committedAtomicLaunchResponse(args: {
  readonly createArgs: CreateAgentRunArgs;
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
  if (args.committed.kind === "queued") {
    recordQueuedRunEnqueueTelemetry({
      runId: args.committed.run.id,
      queueDepth: args.committed.queueDepth,
      timestamp: args.committed.telemetryTimestamp,
    });
    args.phaseTiming.appendTo(args.timing);
    ingestRunContextSnapshot(args.committed.runContextSnapshot);
    args.timing.flush({
      runId: args.committed.run.id,
      runnerGroup: args.committed.runnerJobPayload.runnerGroup,
      profile: args.committed.runnerJobPayload.profile,
      dispatchPath: "direct",
      dimensions: timingDimensionsForCreateArgs(args.createArgs),
      ...(args.createArgs.body.triggerSource
        ? { triggerSource: args.createArgs.body.triggerSource }
        : {}),
    });
    const response = createdRunResponse(args.committed.run, {
      status: "queued",
    });
    return args.committed.queueFirstClaim
      ? { ...response, queueFirstClaim: args.committed.queueFirstClaim }
      : response;
  }

  args.phaseTiming.checkpoint(
    "api_dispatch_phase_queue_insert",
    args.committed.runnerJobCreatedAt.getTime(),
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
    ...(args.committed.runnerJobPayload.executionContext.piLaunchConfig &&
    !args.committed.runnerJobPayload.executionContext.piLaunchConfig.maintenance
      ? {
          piApiFirstTurn: {
            runId: args.committed.run.id,
            runnerGroup: args.committed.runnerJobPayload.runnerGroup,
            userId: args.createArgs.userId,
            orgId: args.createArgs.orgId,
            prompt: args.createArgs.body.prompt,
            appendSystemPrompt: args.createArgs.body.appendSystemPrompt ?? null,
            executionContext: requirePiApiFirstTurnExecutionContext(
              args.committed.runnerJobPayload.executionContext,
            ),
          },
        }
      : {}),
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

function flushQueueFirstClaimLostTiming(args: {
  readonly createArgs: CreateAgentRunArgs;
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

const piPreparationAuthority = Symbol("creator-authorized-pi-preparation");

/** Issued only after authorization and finalized launch payload construction. */
export interface CreatorAuthorizedPiPreparation {
  readonly [piPreparationAuthority]: true;
  readonly activation: NonNullable<PendingRunActivation["piApiFirstTurn"]>;
  readonly triggerSource: CreateRunBody["triggerSource"];
}

interface AtomicLaunchRunInput {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly creditAdmitted: boolean;
  readonly context: FinalizedPreparedRunContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}

function isQueuePayloadRequiredResult(
  result: unknown,
): result is QueuePayloadRequiredResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    result.kind === "queue-payload-required"
  );
}

function finalizeAtomicLaunchCommit(
  args: {
    readonly input: AtomicLaunchRunInput;
    readonly identity: LaunchRunIdentity;
    readonly launch: PreparedRunnerLaunch;
    readonly committed: AtomicLaunchCommitCompletion;
  },
  signal: AbortSignal,
): QueueFirstAgentRunResult | QueuePayloadRequiredResult {
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
  if (committed.kind === "thread-session-snapshot-stale") {
    return committed;
  }
  if (committed.kind === "queue-payload-required") {
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

async function completeQueuePayloadLaunch(
  args: {
    readonly input: AtomicLaunchRunInput;
    readonly identity: LaunchRunIdentity;
    readonly callbackRows: readonly AgentRunCallbackInsert[];
    readonly launch: PreparedRunnerLaunch;
    readonly commitLaunch: CommitAtomicLaunch;
  },
  signal: AbortSignal,
): Promise<QueueFirstAgentRunResult> {
  signal.throwIfAborted();
  const encryptedQueuedParams = await settle(
    encryptQueuedRunnerJobPayload(
      args.launch.runnerJobPayload,
      args.input.context.featureSwitchContext,
    ),
  );
  signal.throwIfAborted();

  if (!encryptedQueuedParams.ok) {
    const retried = await args.commitLaunch(undefined);
    const finalizedRetry = finalizeAtomicLaunchCommit(
      {
        input: args.input,
        identity: args.identity,
        launch: args.launch,
        committed: retried,
      },
      signal,
    );
    if (!isQueuePayloadRequiredResult(finalizedRetry)) {
      return finalizedRetry;
    }
    signal.throwIfAborted();
    return await commitFailedLaunch({
      db: args.input.db,
      createArgs: args.input.args,
      context: args.input.context,
      identity: args.identity,
      callbackRows: args.callbackRows,
      launch: args.launch,
      error: encryptedQueuedParams.error,
      timing: args.input.timing,
    });
  }

  const committed = await args.commitLaunch(encryptedQueuedParams.value);
  const finalized = finalizeAtomicLaunchCommit(
    {
      input: args.input,
      identity: args.identity,
      launch: args.launch,
      committed,
    },
    signal,
  );
  if (isQueuePayloadRequiredResult(finalized)) {
    signal.throwIfAborted();
    throw new Error("Queued launch still required encrypted payload");
  }
  return finalized;
}

const commitAndActivateAtomicLaunch$ = command(
  async (
    { set },
    args: {
      readonly input: AtomicLaunchRunInput;
      readonly identity: LaunchRunIdentity;
      readonly callbackRows: readonly AgentRunCallbackInsert[];
      readonly launch: PreparedRunnerLaunch;
    },
    signal: AbortSignal,
  ): Promise<QueueFirstAgentRunResult> => {
    const { input, identity, callbackRows, launch } = args;
    const provider = input.context.modelProvider;
    const subscriptionAdmission =
      provider?.id &&
      isPersonalSubscriptionProviderType(provider.type) &&
      provider.credentialOwner === "member"
        ? await preparePersonalSubscriptionAdmission(
            {
              db: input.db,
              orgId: input.args.orgId,
              userId: input.args.userId,
              type: provider.type,
              sourceId: provider.id,
              featureSwitchContext: input.context.featureSwitchContext,
            },
            signal,
          )
        : null;
    signal.throwIfAborted();
    const executionContext = launch.runnerJobPayload.executionContext;
    const preparation =
      input.context.body.triggerSource !== "goal" &&
      executionContext.piLaunchConfig &&
      !executionContext.piLaunchConfig.maintenance
        ? set(prepareConfiguredPiApiFirstTurn$, {
            [piPreparationAuthority]: true,
            triggerSource: input.context.body.triggerSource,
            activation: {
              runId: identity.runId,
              runnerGroup: launch.runnerJobPayload.runnerGroup,
              userId: input.args.userId,
              orgId: input.args.orgId,
              prompt: input.context.body.prompt,
              appendSystemPrompt: input.context.body.appendSystemPrompt ?? null,
              executionContext:
                requirePiApiFirstTurnExecutionContext(executionContext),
            },
          })
        : undefined;
    let transferred = false;
    let discardReason: PiPreparationDiscardReason = "admission-failed";
    return await (async () => {
      const commitLaunch: CommitAtomicLaunch = async (
        encryptedQueuedParams: string | undefined,
      ) => {
        return await input.timing.measure(
          "api_dispatch_insert_run_with_concurrency",
          "top_level",
          async () => {
            return await commitPreparedLaunch({
              db: input.db,
              createArgs: input.args,
              creditAdmitted: input.creditAdmitted,
              context: input.context,
              identity,
              callbackRows,
              launch,
              encryptedQueuedParams,
              subscriptionAdmission,
              timing: input.timing,
            });
          },
        );
      };

      const committed = await commitLaunch(undefined);
      const finalized = finalizeAtomicLaunchCommit(
        {
          input,
          identity,
          launch,
          committed,
        },
        signal,
      );
      const result = isQueuePayloadRequiredResult(finalized)
        ? await completeQueuePayloadLaunch(
            { input, identity, callbackRows, launch, commitLaunch },
            signal,
          )
        : finalized;
      if (
        "status" in result &&
        result.status === 201 &&
        result.pendingActivation
      ) {
        // Commit determines ownership even if the initiating request disconnected.
        // The API branch is owned by waitUntil; Runner notification never joins it.
        transferred = true;

        await set(activatePendingRun$, {
          activation: result.pendingActivation,
          activationScheduledAt: now(),
          preparation,
        });
        const { pendingActivation: _pendingActivation, ...activated } = result;
        return activated;
      }
      if ("kind" in result) {
        if (result.kind === "queue-first-claim-lost") {
          discardReason = "claim-lost";
        }
        if (result.kind === "thread-session-snapshot-stale") {
          discardReason = "stale";
        }
      } else if (result.status === 201) {
        discardReason = "queued";
      }
      return result;
    })().finally(() => {
      if (!transferred && preparation) {
        // Discard immediately; waitUntil joins late SDK initialization without
        // delaying queued responses or making another attempt reuse this one.
        waitUntil(preparation.dispose(discardReason));
      }
    });
  },
);

const createAtomicLaunchRun$ = command(
  async (
    { get, set },
    input: AtomicLaunchRunInput,
    signal: AbortSignal,
  ): Promise<QueueFirstAgentRunResult> => {
    const identity = prepareLaunchRunIdentity({
      resolved: input.context.resolved,
    });
    if (!input.args.queueOnConcurrencyLimit) {
      const preflightConcurrency = await checkRunConcurrencyPreflight({
        db: input.db,
        orgId: input.args.orgId,
        timing: input.timing,
      });
      signal.throwIfAborted();
      if (preflightConcurrency) {
        return preflightConcurrency;
      }
    }

    const callbackRows = await prepareRunCallbackRows({
      runId: identity.runId,
      callbacks: input.args.callbacks,
      featureSwitchContext: input.context.featureSwitchContext,
      timing: input.timing,
    });
    signal.throwIfAborted();

    const launchResult = await settle(
      input.timing.measure(
        "api_dispatch_build_runner_job_payload",
        "top_level",
        async () => {
          return await get(
            buildAtomicLaunchPayload(
              input.db,
              {
                createArgs: input.args,
                context: input.context,
                run: {
                  id: identity.runId,
                  sessionId: identity.sessionId,
                  shouldCreateSession: identity.shouldCreateSession,
                },
                timing: input.timing,
              },
              signal,
            ),
          );
        },
        {
          pi_launch_resources:
            input.context.piSandbox === undefined ? "not_required" : "required",
        },
      ),
    );
    signal.throwIfAborted();
    if (!launchResult.ok) {
      if (
        launchResult.error instanceof OfficialWorkflowArtifactResolutionError
      ) {
        return conflict(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE);
      }
      return await commitFailedLaunch({
        db: input.db,
        createArgs: input.args,
        context: input.context,
        identity,
        callbackRows,
        error: launchResult.error,
        timing: input.timing,
      });
    }

    const launch = launchResult.value;
    input.phaseTiming.checkpoint("api_dispatch_phase_prepare_launch", now());

    return await set(
      commitAndActivateAtomicLaunch$,
      { input, identity, callbackRows, launch },
      signal,
    );
  },
);

interface PreparedAgentRun {
  readonly args: CreateAgentRunArgs;
  readonly context: PreparedRunContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}

interface PrepareAgentRunArgs {
  readonly args: CreateAgentRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
  readonly checkOrgPlanStatusBeforeContext: boolean;
  readonly preloadedFeatureSwitchContext?: FeatureSwitchContext;
  // Undefined means not preloaded; null is an authoritative missing value.
  readonly preloadedUserTimezone?: string | null;
  readonly preloadedConnectorCatalogSnapshot?: ConnectorRuntimeSelection;
}

interface CompleteAgentRunArgs {
  readonly prepared: PreparedAgentRun;
  readonly finalAppendSystemPrompt: CreateRunBody["appendSystemPrompt"];
}

function finalizePreparedRunContext(
  prepared: PreparedAgentRun,
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
      connectorSlugs: prepared.context.connectorContext.connectorSlugs,
      mcpConnectorSlugs:
        prepared.context.customConnectorContext.mcpConnectorSlugs,
      selectedImageModel: prepared.context.selectedImageModel,
      cliAvailable: prepared.args.includeOkouTokenSecret === true,
    }),
  };
}

export const prepareAgentRun$ = command(
  async (
    { get, set },
    input: PrepareAgentRunArgs,
    signal: AbortSignal,
  ): Promise<PreparedAgentRun | CreateRunErrorResult> => {
    if (
      isUnsupportedRunAdmission(
        input.args.body.triggerSource,
        input.args.queueFirstAssociation,
      )
    ) {
      return conflict("Unsupported run input");
    }
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
          return await checkOrgRunPlanStatus(db, { orgId: args.orgId });
        },
      );
      signal.throwIfAborted();
      if (tierGate) {
        return tierGate;
      }
    }

    const context = await timing.measure(
      "api_dispatch_prepare_run_context",
      "top_level",
      async () => {
        return await get(
          prepareRunContext(
            {
              db,
              args,
              timing,
              preloadedFeatureSwitchContext:
                input.preloadedFeatureSwitchContext,
              preloadedUserTimezone: input.preloadedUserTimezone,
              preloadedConnectorCatalogSnapshot:
                input.preloadedConnectorCatalogSnapshot,
            },
            signal,
          ),
        );
      },
    );
    signal.throwIfAborted();
    if (isRouteError(context)) {
      return context;
    }

    input.phaseTiming.checkpoint("api_dispatch_phase_prepare_context", now());
    return { args, context, timing, phaseTiming: input.phaseTiming };
  },
);

export const completeAgentRun$ = command(
  async (
    { set },
    input: CompleteAgentRunArgs,
    signal: AbortSignal,
  ): Promise<QueueFirstAgentRunResult> => {
    if (
      isUnsupportedRunAdmission(
        input.prepared.args.body.triggerSource,
        input.prepared.args.queueFirstAssociation,
      )
    ) {
      return conflict("Unsupported run input");
    }
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
    const creditAdmitted =
      args.enforceBuiltInCredits === true &&
      isBuiltInModelProviderType(context.modelProvider?.type);
    const admissionGate = await timing.measure(
      "api_dispatch_check_run_admission",
      "top_level",
      async () => {
        return await checkFinalRunAdmission(
          db,
          {
            orgId: args.orgId,
            userId: args.userId,
            modelProviderType,
            selectedModel,
            enforceBuiltInCredits: creditAdmitted,
            timing,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (admissionGate) {
      return admissionGate;
    }

    return await set(
      createAtomicLaunchRun$,
      {
        db,
        args,
        creditAdmitted,
        context,
        timing,
        phaseTiming: input.prepared.phaseTiming,
      },
      signal,
    );
  },
);

export const createAgentRun$ = command(
  async (
    { set },
    args: CreateAgentRunArgs,
    signal: AbortSignal,
  ): Promise<CreateRunRouteResult> => {
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    const phaseTiming = new ApiDispatchPhaseCollector(args.apiStartTime);
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_run",
      "top_level",
      args.apiStartTime,
    );
    phaseTiming.checkpoint("api_dispatch_phase_pre_create", now());
    const prepared = await set(
      prepareAgentRun$,
      {
        args,
        timing,
        phaseTiming,
        checkOrgPlanStatusBeforeContext: true,
      },
      signal,
    );
    if (isRouteError(prepared)) {
      return prepared;
    }
    const result = await set(
      completeAgentRun$,
      {
        prepared,
        finalAppendSystemPrompt: args.body.appendSystemPrompt,
      },
      signal,
    );
    if (isQueueFirstRunClaimLost(result)) {
      throw new Error("Direct run unexpectedly lost a queue-first claim");
    }
    if (isThreadSessionSnapshotStale(result)) {
      throw new Error("Direct run unexpectedly used a stale thread session");
    }
    return result;
  },
);
