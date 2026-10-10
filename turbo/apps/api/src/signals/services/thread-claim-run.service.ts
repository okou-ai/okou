import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  type ConnectorRuntimeTargetRegistration,
  DEFAULT_PROFILE,
  PI_AGENT_DIR,
  PI_MEMORY_ROOT,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  PI_SKILLS_ROOT,
  type PiInstalledCliRequirement,
  type PiLaunchConfig,
  type PiMemoryRecallSelection,
  piMemoryRecallSelectionSchema,
  type PiModelConfig,
  type SecretConnectorMetadata,
  type StorageMountEntry,
  type StoredExecutionContext,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import {
  resolveRunSkillVolumes,
  type SkillVolume,
} from "./run-prompt-and-skills";
import {
  type ConnectorScopeSource,
  createConnectedAccountsSignals,
  type EffectiveConnectorScope,
  isEmptyRunConnectorScope,
  type BuiltinConnectorRuntimeContext,
  type RunConnectorCatalogSelection,
} from "./thread-connected-accounts.signals";
import { countBucket } from "./dispatch-count-bucket";
import {
  type PersistedRunEnvironmentSnapshot,
  pendingOkouTokenSecrets,
  resolveRunBodyEnvironment,
  type RunBodyEnvironment,
  selectedAgentRunVariables,
  withoutLegacyAgentRunEnvironmentEntries,
} from "./run-body-environment";
import { createThreadContext } from "./thread-context.signals";
import {
  createConnectorRuntimeSignals,
  effectiveStoredConnectorEnvironment,
} from "./thread-connector-runtime.signals";
import { createOfficialWorkflowSignals } from "./thread-official-workflow.signals";
import type {
  QueuedModelContext,
  ThreadModelError,
} from "./thread-model.signals";
import type {
  FeishuThreadContext,
  TeamsThreadContext,
  TelegramThreadContext,
} from "./thread-run-context.service";
import {
  createPromptAndSkillVolumesSignals,
  type PromptAndSkillVolumes,
  PromptAndSkillVolumesError,
} from "./thread-run-prompt/prompt-and-skill-volumes";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env, optionalEnv } from "../../lib/env";
import {
  AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { logger } from "../../lib/log";
import { VERCEL_AUTOMATION_BYPASS_ENV } from "../../lib/preview-automation-bypass";

import { now, nowDate } from "../../lib/time";
import { previewAutomationBypass$ } from "../context/hono";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import { waitUntil } from "../context/wait-until";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import { safeSync, settle, tapError } from "../utils";
import {
  agentConnectorScopeFromRows,
  type AgentConnectorScopeSnapshot,
} from "./agent-connector-scope.service";
import { activatePendingRun$ as activateCommittedRun$ } from "./agent-run-activation.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type {
  AgentRunModelPin,
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
  PermissionManifest,
  ResolvedModelProviderEnvironment,
  RunCallback,
} from "./agent-run-contracts";
import {
  type AdmissionAttemptOutcome,
  AdmissionAttemptTiming,
} from "./api-dispatch-admission-timing.service";
import {
  prepareModelUsageContext,
  runRoutePricingFromSnapshot,
} from "./built-in-route-pricing";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { recordThreadRunActivationMarkers } from "./chat-first-assistant-event-metric.service";
import {
  isWebChatContextType,
  type QueuedUserMessage,
  type QueuedUserMessageContextType,
  type QueueFirstRunAssociation,
  type QueueFirstRunClaimResult,
} from "./chat-queued-event.service";
import { finalizeClaimedRunUserMessage } from "./chat-run-event.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import {
  type ExecutionCallback,
  prepareCallbacks$ as prepareExecutionCallbacks$,
} from "./execution-callbacks.service";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  createResolvedExecutionStorageObjects,
  type ExecutionStorageRequest,
  PreparedExecutionStorageMount,
  updateExecutionStoragePresignedUrlCache$,
} from "./execution-storage.service";
import {
  buildQueuedRunCommand,
  ChatCallbackPreCreateTimingCollector,
  type CreateQueuedChatRunInput,
  deliverQueuedPromptRejection$,
  deliverUnexpectedQueuedPromptRejection$,
  type QueuedChatPromptData,
  queuedChatRunCallbackInputs,
  queuedIntegrationLaunchFields,
  type QueuedLaunchMaterial,
  queuedMessageAdmissionFailure,
  type QueuedMessageAdmissionFailure,
  type QueuedMessageModelRouteResolution,
  queuedMessageRejection,
  type QueuedPromptLaunchContext,
  type QueuedRunAdmissionFailureInput,
  recordQueuedPromptRunLaunch$,
  rejectedQueuedRunAdmissionFailure,
  routeQueuedMessagePiExecution,
} from "./internal-chat-run-callback.service";
import type { ModelCatalog } from "./model-catalog.service";
import {
  morningBriefScheduleClaimBound$,
  morningBriefScheduleClaimSupersededCondition,
} from "./morning-brief-schedule-claim.service";
import {
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
  type OfficialWorkflowObservation,
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowRunObservation,
} from "./official-workflow-run.service";
import { pendingLaunchBillingAttributionSql } from "./pending-launch-billing-plan";
import {
  type PendingLaunchClaim,
  pendingLaunchClaimFenceSql,
  pendingLaunchClaimProducerStatements,
  requirePendingLaunchClaimFence,
} from "./pending-launch-claim-plan";
import {
  pendingLaunchAdmissionRowSchema as admissionRow,
  advancePendingOfficialAdmission,
  pendingOfficialAdmissionStart,
} from "./pending-launch-official-plan";
import {
  pendingLaunchInsertSql,
  pendingLaunchUpdateSql,
} from "./pending-launch-sql";
import {
  advancePendingLaunchTail,
  type PendingLaunchTailInput,
  pendingLaunchTailStart,
  pendingLaunchTailRowSchema as tailRow,
} from "./pending-launch-tail-plan";
import {
  type PiModelPreparationInput,
  resolvePreparedPiModelConfig,
  shouldUsePiExecution,
} from "./pi-sandbox-config";
import {
  checkCatalogRunRoute,
  checkOrgPlanRunAdmission,
  isFreePlanForCreditAdmission,
  type RunAdmissionInput,
} from "./run-admission.service";

import { agentphoneDeliveryTargetSchema } from "./agentphone-chat-callback-payload";

import {
  ApiDispatchPhaseCollector,
  type ApiDispatchTimingActionType,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingDimensionsInput,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { INITIAL_AUTONOMY_BUDGET } from "./autonomy-budget.constants";
import { childAutonomyBudget } from "./autonomy-budget.service";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
  parseCanonicalChatEventRequiredOfficialWorkflowIds,
} from "./canonical-chat-event-read.service";
import {
  chatEventInsertSql,
  chatEventReplacementInsertSql,
} from "./chat-event.service";
import { chatInputEnqueueCommits$ } from "./chat-input-enqueue-observation";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";
import { resolveReasoningEffortForDispatch } from "./chat-reasoning-effort.service";
import {
  capturedChatThreadSessionSnapshot,
  type ChatThreadExecutionSnapshot,
  type ChatThreadSessionResolution,
  type ChatThreadSessionResolutionAction,
  type ChatThreadSessionRoute,
  resolveChatThreadSessionSnapshot,
} from "./chat-session-continuity.service";
import { agentRunSourceAnnotation } from "./chat-user-message.service";
import {
  compactRecord,
  mergeRecords,
  type CustomConnectorRuntimeContext,
} from "./connector-runtime-preparation.service";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";

import { DiscordQueuedLaunchUnavailableError } from "./discord-queued-launch-context.service";
import { isMemberSubscriptionRoute } from "./effective-model-route.service";

import { recordGetStartedWorkflowSql } from "./get-started-workflow.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  type MemorySummaryProjectionReadInput,
  memorySummaryProjectionReadResult,
  type MemorySummaryProjectionReadResult,
} from "./memory-summary-projection.service";

import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  getFrameworkForType,
  isBuiltInModelProviderType,
  type ModelProviderCredentialScope,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  type RunContextResponse,
  runCreateBodySchema,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  type CreateRunResponse,
  type RunStatus,
  unifiedRunRequestSchema,
} from "@okouai/api-contracts/contracts/runs";
import type { FirewallPermissionGrant } from "@okouai/connectors/firewall-metadata/policy";
import type { FirewallPolicies } from "@okouai/connectors/firewall-types";
import {
  type FeatureSwitchContext,
  getAllFeatureStates,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  getInstructionsFilename,
  type SupportedFramework,
} from "@okouai/core/frameworks";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { piCatalogModel } from "@okouai/core/pi-execution";
import { isStaffOrg } from "@okouai/core/staff-org";
import {
  getInstructionsStorageName,
  MEMORY_ARTIFACT_NAME,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  expandVariables,
  expandVariablesInString,
  extractAndGroupVariables,
} from "@okouai/core/variable-expander";
import {
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
  VERSION_ID_LENGTH,
} from "@okouai/core/version-id";
import type {
  AgentRunFullLaunchSnapshot,
  AgentRunLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentSessions } from "@okouai/db/schema/agent-session";

import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";

import {
  chatEventRunlessInputPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";

import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";

import { memorySummaryProjections } from "@okouai/db/schema/memory-summary-projection";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";

import { storages, storageVersions } from "@okouai/db/schema/storage";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";

import { workflowAutomations } from "@okouai/db/schema/workflow";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { command, type Command, computed, type Computed, state } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  like,
  ne,
  notExists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";
import { alias, QueryBuilder, unionAll } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import { generateOkouToken } from "../auth/tokens";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  normalizeRunMetadata,
  type RunMetadataValues,
} from "./agent-run-metadata-write.service";
import {
  type ChatThreadRequestFacts,
  chatThreadRequestSelection,
} from "./chat-thread-request-facts";
import {
  cacheRowsFromProjection,
  storageVersionCacheKeySql,
} from "./execution-storage-cache-read.service";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import {
  isPersonalSubscriptionProviderType,
  type MemberModelAccountSnapshot,
} from "./model-provider-account.service";
import {
  type ModelFirstPin,
  modelProviderWriteTypeForLaunch,
} from "./model-selection.service";
import type { OfficialWorkflowContextFacts } from "./official-workflow-context.signals";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  featureFlagsRecordToEntries,
  networkPoliciesRecordToEntries,
  type RunContextAxiomSnapshot,
} from "./run-context-snapshot.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "./session-compatibility";
import {
  type CompressedSessionHistoryBlobEncoding,
  isCompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
} from "./session-history-blobs";
import {
  exactStorageVersionsFromIndex,
  mergeStorageIndexes,
  readStorageBaseIndex,
  type StorageIndex,
  type StorageIndexEntry,
  type StorageLookup,
  type StorageRequest,
  storageRequestKey,
  type StorageVersionIndexEntry,
} from "./storage-index.service";
import { projectLegacyWritebackArtifacts } from "./storage-legacy-projection.service";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import type {
  StorageManifestCacheBranch,
  StorageManifestCacheEntryKind,
  SystemStoragePresignedUrlCacheStatus,
  WorkflowSkillStoragePresignedUrlCacheStatus,
} from "./system-storage-presigned-url-cache.service";
import { teamsDeliveryTargetSchema } from "./teams-chat-callback-payload";

import { telegramDeliveryTargetSchema } from "./telegram-chat-callback-payload";

import { isWebChatContextId } from "./web-chat-queue-context.service";

import {
  EVENT_POLICY,
  restoredWorkflowAutomationEventPayload,
  type WorkflowAutomationEventPayload,
  workflowAutomationEventTypeSchema,
} from "./workflow-automation-context.service";
import {
  AutomationRow,
  DueWorkflowAutomation,
} from "./workflow-automation-enqueue.service";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import type { RunWorkflowRef } from "./workflow-data.service";
import { recordWorkflowAdmissionDuration } from "./workflow-queue-admission-timing.service";
import { settleRejectedAutomationInput$ } from "./workflow-schedule-failure.service";

export interface ThreadClaim {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly claimId: string;
}

interface QueuedPromptGraphInput {
  readonly head: ChatQueueHeadContext;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly runTiming: ApiDispatchTimingCollector;
}

class QueuedPromptInputInvalidError extends Error {}

function resolveQueuedOfficialWorkflowContext(args: {
  readonly contextType: QueuedUserMessageContextType;
  readonly contextId: string | null;
  readonly requiredOfficialWorkflowIds: readonly string[] | null;
}) {
  const hasClaim = args.requiredOfficialWorkflowIds !== null;
  if (hasClaim && !isWebChatContextType(args.contextType)) {
    throw new QueuedPromptInputInvalidError(
      `Queued ${args.contextType} input cannot carry an Official Workflow source claim`,
    );
  }
  const hasWebContextId = isWebChatContextId(args.contextId);
  if (args.contextType === "web" && !hasWebContextId) {
    throw new QueuedPromptInputInvalidError("Invalid Web chat context");
  }
  // Official agent inputs use Web identity, never a source Run pointer. Their
  // private claim and server-owned annotation retain source/budget authority.
  const officialAgentClaim =
    args.contextType === "agent_run" && hasWebContextId;
  if ((officialAgentClaim && !hasClaim) || (hasClaim && !hasWebContextId)) {
    throw new QueuedPromptInputInvalidError(
      "Queued Official Workflow context and source claim do not match",
    );
  }
  return officialAgentClaim;
}

function queuedUserMessageAutonomyBudget(
  contextType: QueuedUserMessageContextType,
  sourceAutonomyBudget: number | null,
): QueuedUserMessage["autonomyBudget"] {
  if (contextType !== "agent_run") {
    return { kind: "ok", autonomyBudget: INITIAL_AUTONOMY_BUDGET };
  }
  if (sourceAutonomyBudget === null) {
    return {
      kind: "unavailable",
      message: "Agent source run no longer exists",
    };
  }
  return childAutonomyBudget(sourceAutonomyBudget);
}

function queuedFeishuDelivery(context: NonNullable<FeishuThreadContext>) {
  return {
    installationId: context.installationId,
    connectionId: context.connectionId,
    chatId: context.chatId,
    messageId: context.messageId,
    threadId: context.routeThreadId,
    replyInThread: context.replyInThread,
    ...(context.reactionId ? { reactionId: context.reactionId } : {}),
    files: [...context.messageFiles],
  };
}

function queuedTeamsDelivery(context: NonNullable<TeamsThreadContext>) {
  return teamsDeliveryTargetSchema.parse({
    tenantId: context.tenantId,
    tenantName: context.tenantName,
    teamId: context.teamId,
    teamName: context.teamName,
    channelId: context.channelId,
    conversationId: context.conversationId,
    conversationType: context.conversationType,
    threadId: context.threadId,
    activityId: context.activityId,
    serviceUrl: context.serviceUrl,
    connectionId: context.connectionId,
    teamsUserId: context.senderUserId,
    teamsUserDisplayName: context.senderDisplayName,
    teamsUserPrincipalName: context.senderPrincipalName,
    botId: context.installationBotId,
    botName: context.installationBotName,
    files: context.messageFiles.map((file) => {
      return { fileId: file.fileId, ...file.payload };
    }),
  });
}

function queuedTelegramDelivery(context: NonNullable<TelegramThreadContext>) {
  return telegramDeliveryTargetSchema.parse({
    installationId: OFFICIAL_TELEGRAM_BOT_ID,
    chatId: context.chatId,
    messageId: context.messageId,
    rootMessageId: context.rootMessageId,
    userLinkId: context.userLinkId,
    userLinkKind: context.userLinkKind,
    agentId: context.agentId,
    isDM: context.chatType === "private",
    ...(context.messageThreadId !== null
      ? { messageThreadId: context.messageThreadId }
      : {}),
    ...(context.thinkingMessageId !== null
      ? { thinkingMessageId: context.thinkingMessageId }
      : {}),
  });
}

class QueuedPromptLaunchUnavailableError extends Error {
  constructor() {
    super("This conversation is no longer available.");
    this.name = "QueuedPromptLaunchUnavailableError";
  }
}

function queuedPromptRunInput(args: {
  readonly input: CreateQueuedChatRunInputArgs;
  readonly launch: QueuedLaunchMaterial;
  readonly promptAndSkills: PromptAndSkillVolumes;
  readonly model: Exclude<
    QueuedMessageModelRouteResolution,
    { readonly error: unknown }
  >;
  readonly session: ChatThreadSessionResolution;
  readonly host: CreateQueuedChatRunInput["computerUseHostGrant"];
  readonly capture: boolean;
  readonly features: FeatureSwitchContext;
  readonly catalog: ModelCatalog;
}): CreateQueuedChatRunInput {
  const { input, launch } = args;
  if (input.queuedMessage.autonomyBudget.kind !== "ok") {
    throw new Error("Rejected autonomy input cannot become a run");
  }
  const { piExecution, routedModel } = routeQueuedMessagePiExecution({
    input,
    modelRoute: args.model.route,
  });
  return {
    orgId: input.agent.orgId,
    userId: input.userId,
    agentId: input.agent.id,
    expectedThreadAgentId: input.expectedThreadAgentId,
    threadSessionResolution: args.session,
    featureSwitchContext: args.features,
    prompt: args.promptAndSkills.userPrompt,
    appendSystemPrompt: args.promptAndSkills.appendedSystemPrompt,
    threadId: input.threadId,
    queuedMessage: input.queuedMessage,
    requiredOfficialWorkflowIds:
      input.queuedMessage.requiredOfficialWorkflowIds,
    modelPin: routedModel.modelPin,
    memberAccountSnapshot: routedModel.memberAccountSnapshot,
    effectiveModelProvider: routedModel.effectiveModelProvider,
    builtInModelRuntimeRoute: routedModel.builtInModelRuntimeRoute,
    cliAgentType: routedModel.cliAgentType,
    piExecution,
    codexServiceTier: routedModel.codexServiceTier,
    reasoningEffort: resolveReasoningEffortForDispatch({
      catalog: args.catalog,
      selectedModel: routedModel.modelPin.selectedModel,
      modelProviderType: routedModel.effectiveModelProvider,
      effort: routedModel.reasoningEffort ?? undefined,
      runtimeProviderType:
        routedModel.builtInModelRuntimeRoute?.providerType ??
        routedModel.effectiveModelProvider,
      piExecution,
    }),
    computerUseHostGrant: args.host,
    triggerSource: launch.triggerSource,
    realAgentInPreview: isFeatureEnabled(
      FeatureSwitchKey.RealAgentInPreview,
      args.features,
    ),
    captureNetworkBodies: args.capture,
    ...queuedIntegrationLaunchFields(launch, input.agent.id),
    autonomyBudget: input.queuedMessage.autonomyBudget.autonomyBudget,
  };
}

type ChatQueueRunAssembly =
  | {
      readonly kind: "assembled";
      readonly run: ClaimQueueRunCommandArgs;
      readonly producerBinding: ClaimProducerBinding;
      readonly rejection: ClaimRejectionContext;
      readonly launchRecord: ClaimLaunchRecord;
    }
  | { readonly kind: "rejected"; readonly rejection: ChatQueueHeadRejection }
  | { readonly kind: "not-ready" };

function queuedPromptPreparationRejection(
  error: unknown,
  head: ChatQueueHeadContext,
): ChatQueueRunAssembly {
  if (
    !(error instanceof DiscordQueuedLaunchUnavailableError) &&
    !(error instanceof QueuedPromptLaunchUnavailableError) &&
    !(error instanceof QueuedPromptInputInvalidError) &&
    !(error instanceof PromptAndSkillVolumesError)
  ) {
    throw error;
  }
  return {
    kind: "rejected",
    rejection: {
      userId: head.userId,
      error: {
        code:
          error instanceof PromptAndSkillVolumesError
            ? error.code
            : error instanceof DiscordQueuedLaunchUnavailableError
              ? "DISCORD_ACCESS_REVOKED"
              : error instanceof QueuedPromptInputInvalidError
                ? "INTERNAL_ERROR"
                : "CONFLICT",
        message: error.message,
      },
    },
  };
}

function missingQueuedAgentRejection(
  head: ChatQueueHeadContext,
): ChatQueueRunAssembly {
  return {
    kind: "rejected",
    rejection: {
      userId: head.userId,
      error: {
        code: "BAD_REQUEST",
        message: "The organization default agent is unavailable",
      },
      delivery: { kind: "source", head },
    },
  };
}

function workflowModelProviderBody(modelProvider: string | null | undefined) {
  return modelProvider
    ? { modelProvider: modelProviderWriteTypeForLaunch(modelProvider) }
    : {};
}

interface QueuedAutomationEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly automationId: string;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
  readonly connectorSourceId: string | null;
}

interface LaunchTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly agentId: string;
}

type AutonomyBudgetResult =
  | { readonly kind: "ok"; readonly autonomyBudget: number }
  | {
      readonly kind: "invalid";
      readonly error: { readonly code: string; readonly message: string };
    };

function buildWorkflowAutomationQueuedLaunchMaterial(args: {
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly chatThreadId: string;
}): WorkflowAutomationQueuedLaunchMaterial | null {
  if (
    args.workflowName === null ||
    args.eventType === null ||
    args.eventPayload === null ||
    !restoredWorkflowAutomationEventPayload(args.eventPayload)
  ) {
    return null;
  }
  const eventType = workflowAutomationEventTypeSchema.parse(args.eventType);
  return {
    callbacks: buildWorkflowAutomationCallbacks(
      args.automation,
      args.agentId,
      args.chatThreadId,
      args.workflowName,
    ),
    ...EVENT_POLICY[eventType],
    allowClaimedOnceScheduleAutomation: args.automation.scheduleType === "once",
  };
}

interface AssembleWorkflowAutomationRunArgs extends WorkflowAutomationLaunchArgs {
  readonly queueEventId: string;
}

type RunFailure =
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunErrorResponse };

function workflowAutomationRunMetadata(
  automation: AutomationRow,
  triggerBrief: string | undefined,
  autonomyBudget: number,
) {
  return {
    workflowAutomationId: automation.id,
    triggerBrief,
    autonomyBudget,
  };
}

type ModelContext =
  | {
      readonly ok: true;
      readonly memberAccountSnapshot: MemberModelAccountSnapshot | null;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
      readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
      readonly cliAgentType: string | null;
      readonly codexServiceTier: "fast" | undefined;
      readonly reasoningEffort: ReasoningEffort | null;
      readonly piExecution: boolean;
    }
  | { readonly ok: false; readonly failure: RunFailure };

function workflowModelContext(
  catalog: ModelCatalog,
  chatThreadId: string,
  threadModelContext: QueuedModelContext,
): ModelContext {
  if ("status" in threadModelContext) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: {
          status: threadModelContext.status,
          body: threadModelContext.body,
        },
      },
    };
  }

  const { pin, providerAdmission, runCodexServiceTier } = threadModelContext;
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  const effectiveModelProvider = providerAdmission.effectiveModelProvider;
  const selectedModel = pin.selectedModel;
  const builtInModelRuntimeRoute = threadModelContext.builtInModelRuntimeRoute;
  if (
    isBuiltInModelProviderType(effectiveModelProvider) &&
    !builtInModelRuntimeRoute
  ) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: {
          status: 503,
          body: {
            error: {
              code: "MODEL_PROVIDER_UNAVAILABLE",
              message:
                "Every built-in model route for this model is temporarily unavailable",
            },
          },
        },
      },
    };
  }

  const piExecution = shouldUsePiExecution({
    chatThreadId,
    modelProviderType: effectiveModelProvider,
    catalogModel: piCatalogModel(catalog, selectedModel),
    codexServiceTier: runCodexServiceTier,
    builtInModelRuntimeRoute: builtInModelRuntimeRoute ?? undefined,
  });
  return {
    ok: true,
    modelPin: pin,
    memberAccountSnapshot: threadModelContext.memberAccountSnapshot,
    effectiveModelProvider,
    builtInModelRuntimeRoute: builtInModelRuntimeRoute ?? undefined,
    cliAgentType: piExecution ? "pi" : providerAdmission.cliAgentType,
    codexServiceTier: runCodexServiceTier,
    reasoningEffort:
      resolveReasoningEffortForDispatch({
        catalog,
        selectedModel,
        modelProviderType: effectiveModelProvider,
        effort: threadModelContext.reasoningEffort,
        runtimeProviderType:
          builtInModelRuntimeRoute?.providerType ?? effectiveModelProvider,
        piExecution,
      }) ?? null,
    piExecution,
  };
}

interface AssembledWorkflowAutomationRun {
  readonly kind: "assembled";
  readonly run: ClaimQueueRunCommandArgs;
  readonly producerBinding: Extract<
    ClaimProducerBinding,
    { kind: "automation" }
  >;
  readonly launchRecord: Extract<ClaimLaunchRecord, { kind: "automation" }>;
}

function workflowAutomationRunOwner(automation: {
  readonly orgId: string;
  readonly ownerUserId: string;
}) {
  return { orgId: automation.orgId, userId: automation.ownerUserId };
}

function automationSelectionCommand(
  args: Pick<
    AssembleWorkflowAutomationRunArgs,
    | "due"
    | "apiStartTime"
    | "queueEventId"
    | "triggerSource"
    | "connectorSourceId"
  >,
  model: Extract<ModelContext, { readonly ok: true }>,
  timing: ApiDispatchTimingCollector,
): ThreadRunSelection &
  Pick<
    ThreadRunCommand,
    "chatThreadId" | "queueFirstAssociation" | "agentRunModelPin"
  > {
  const { automation, agentId, chatThreadId } = args.due;
  return {
    owner: workflowAutomationRunOwner(automation),
    body: {
      agentId,
      ...workflowModelProviderBody(model.effectiveModelProvider),
    },
    apiStartTime: args.apiStartTime,
    triggerSource: args.triggerSource ?? "automation-schedule",
    chatThreadId,
    connectorSourceId: args.connectorSourceId,
    modelProviderId: model.modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      model.modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: model.modelPin.selectedModel ?? undefined,
    builtInModelRuntimeRoute: model.builtInModelRuntimeRoute,
    threadSessionRoute: workflowThreadSessionRoute(model),
    codexServiceTier: model.codexServiceTier,
    reasoningEffort: model.reasoningEffort,
    ...(automation.officialBlueprintKey === null
      ? {}
      : { requiredOfficialWorkflowIds: [automation.workflowId] }),
    queueFirstAssociation: {
      threadId: chatThreadId,
      eventId: args.queueEventId,
    },
    agentRunModelPin: {
      modelProvider: model.effectiveModelProvider ?? null,
      modelProviderId: model.modelPin.modelProviderId,
      modelProviderCredentialScope: model.modelPin.modelProviderCredentialScope,
      selectedModel: model.modelPin.selectedModel,
    },
    piExecution: model.piExecution,
    timing,
  };
}

function workflowAutomationTiming(
  timing: ApiDispatchTimingCollector,
  apiStartTime: number,
): ApiDispatchTimingCollector {
  timing.recordElapsed(
    "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
    "nested",
    apiStartTime,
  );
  return timing;
}

type RejectedQueueRunAssembly = Extract<
  ChatQueueRunAssembly,
  { readonly kind: "rejected" }
>;

/** The queued automation's launch arguments, or the rejection of its head. */
type QueuedAutomationLaunch =
  | {
      readonly kind: "launch";
      readonly args: AssembleWorkflowAutomationRunArgs;
    }
  | { readonly kind: "rejected"; readonly assembly: RejectedQueueRunAssembly };

function rejectedAutomationLaunch(
  assembly: RejectedQueueRunAssembly,
): QueuedAutomationLaunch {
  return { kind: "rejected", assembly };
}

function queuedAutomationLaunchArguments(args: {
  readonly head: ChatQueueHeadContext;
  readonly event: QueuedAutomationEvent;
  readonly target: LaunchTarget;
  readonly material: NonNullable<
    ReturnType<typeof buildWorkflowAutomationQueuedLaunchMaterial>
  >;
  readonly autonomyBudget: number;
}) {
  const { head, event, target, material, autonomyBudget } = args;
  const triggerSource: TriggerSource = manualTriggerSource(target.automation);
  return {
    due: {
      automation: target.automation,
      agentId: target.agentId,
      chatThreadId: event.chatThreadId,
      allowClaimedOnceScheduleAutomation:
        material.allowClaimedOnceScheduleAutomation,
    },
    queueEventId: event.id,
    apiStartTime: head.apiStartTime,
    triggerBrief: event.triggerBrief ?? undefined,
    triggerSource,
    ...(event.connectorSourceId
      ? { connectorSourceId: event.connectorSourceId }
      : {}),
    callbacks: material.callbacks,
    autonomyBudget,
    recordLastRunId: material.recordLastRunId,
    recordLastRunAt: material.recordLastRunAt,
  };
}

const log = logger("ChatQueueConsume");

function isDirectSendContext(contextType: string | null): boolean {
  return contextType === "web" || contextType === "agent_run";
}

/** Runner payload facts the Thread assembles privately for one run. */
type ThreadRunnerFacts = Omit<BuildRunnerJobPayloadInput, "run" | "timing">;

interface RunPlan {
  readonly args: ProductRunArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly enforceBuiltInCredits: boolean;
  readonly runner: ThreadRunnerFacts;
  readonly persisted: PendingRunContext;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
}

function unreadyQueueHeadRejection(
  head: ChatQueueHeadContext,
): ChatQueueHeadRejection {
  return {
    userId: head.userId,
    error: {
      code: "INTERNAL_ERROR",
      message: "The input could not be started",
    },
  };
}

function claimAssemblyRejection(
  assembly: ChatQueueRunAssembly,
  head: ChatQueueHeadContext,
  error: { readonly code: string; readonly message: string },
): ChatQueueHeadRejection {
  if (assembly.kind === "rejected") {
    return assembly.rejection;
  }
  if (assembly.kind !== "assembled") {
    return { userId: head.userId, error };
  }
  return assembly.rejection.kind === "prompt"
    ? queuedMessageRejection(
        rejectedQueuedRunAdmissionFailure(assembly.rejection.runInput, error),
      )
    : { userId: assembly.rejection.userId, error };
}

/**
 * Dispatch timing for one pick, created by the parent after its claim and
 * passed as a plain argument; it is not part of the prepared ThreadRunContext.
 */
interface ClaimRunTiming {
  readonly run: ApiDispatchTimingCollector;
  readonly phase: ApiDispatchPhaseCollector;
}

export interface ThreadRunContext {
  readonly kind: "prepared";
  readonly planCapabilities: OrgPlanCapabilities | null;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly input: {
    readonly enforceBuiltInCredits: boolean;
    readonly context: PendingRunContext;
    readonly args: PendingRunArguments;
  };
  readonly identity: CommitPreparedLaunchArgs["identity"];
  readonly callbackRows: CommitPreparedLaunchArgs["callbackRows"];
  readonly launch: CommitPreparedLaunchArgs["launch"];
  readonly persistence: ReturnType<typeof prepareAtomicLaunchPersistence>;
  readonly head: ChatQueueHeadContext;
  readonly producerBinding: ClaimProducerBinding;
  readonly rejection:
    | {
        readonly kind: "prompt";
        readonly runInput: QueuedRunAdmissionFailureInput;
      }
    | Extract<ClaimRejectionContext, { readonly kind: "automation" }>;
  readonly launchRecord: ClaimLaunchRecord;
}

function claimCommitArguments(
  args: PendingRunArguments,
): ThreadRunContext["input"]["args"] {
  return {
    userId: args.userId,
    orgId: args.orgId,
    body: args.body,
    apiStartTime: args.apiStartTime,
    chatThreadId: args.chatThreadId,
    agentRunMetadata: args.agentRunMetadata,
    agentRunModelPin: args.agentRunModelPin,
    codexServiceTier: args.codexServiceTier,
    queueFirstAssociation: args.queueFirstAssociation,
    timingDimensions: args.timingDimensions,
    threadSessionResolution: args.threadSessionResolution
      ? {
          action: args.threadSessionResolution.action,
          previousAgentId: args.threadSessionResolution.previousAgentId,
          resetNativeSession: args.threadSessionResolution.resetNativeSession,
          expected: args.threadSessionResolution.expected,
        }
      : undefined,
  };
}

/**
 * The first route error among prepared resources, in plan, credit admission,
 * storage and stored-context order.
 */
function firstPreparationFailure(
  results: readonly unknown[],
): CreateRunErrorResult | null {
  for (const result of results) {
    if (isRouteError(result)) {
      return result;
    }
  }
  return null;
}

/** Encode the final pending payload before it crosses the claim boundary. */
function finalizeClaimRunContext(
  context: Omit<ThreadRunContext, "persistence">,
  timing: ApiDispatchTimingCollector,
): ThreadRunContext {
  return {
    ...context,
    persistence: prepareAtomicLaunchPersistence({
      createArgs: context.input.args,
      enforceBuiltInCredits: context.input.enforceBuiltInCredits,
      context: context.input.context,
      identity: context.identity,
      callbackRows: context.callbackRows,
      launch: context.launch,
      timing,
    }),
  };
}

type ClaimProducerBinding =
  | { readonly kind: "automation"; readonly queueEventId: string }
  | {
      readonly kind: "reassign-agent";
      readonly agentId: string;
      readonly expectedAgentId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly orgId: string;
    }
  | null;

type ClaimQueueRunCommandArgs = ThreadRunCommand;

type ClaimRejectionContext =
  | { readonly kind: "prompt"; readonly runInput: CreateQueuedChatRunInput }
  | { readonly kind: "automation"; readonly userId: string };

/** Queued prompt data with this preparation's read handle and timing. */
interface CreateQueuedChatRunInputArgs extends QueuedChatPromptData {
  readonly db: ReadonlyDb;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}

type ClaimLaunchRecord =
  | {
      readonly kind: "prompt";
      readonly context: QueuedPromptLaunchContext;
      readonly timing: ChatCallbackPreCreateTimingCollector;
    }
  | {
      readonly kind: "automation";
      readonly automationId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly recordLastRunId: boolean;
      readonly recordLastRunAt: boolean;
      readonly disableClaimedOnceSchedule: boolean;
    };

interface WorkflowAutomationQueuedLaunchMaterial {
  readonly callbacks: ReturnType<typeof buildWorkflowAutomationCallbacks>;
  readonly recordLastRunId: boolean;
  readonly recordLastRunAt: boolean;
  readonly allowClaimedOnceScheduleAutomation: boolean;
}

function buildWorkflowAutomationCallbacks(
  automation: AutomationRow,
  agentId: string,
  chatThreadId: string,
  workflowName: string,
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  if (automation.kind === "schedule") {
    if (automation.scheduleType === "loop") {
      callbacks.push({
        internalKind: "workflow-automation:loop",
        payload: {
          automationId: automation.id,
        },
      });
    } else {
      callbacks.push({
        internalKind: "workflow-automation:cron",
        payload: {
          automationId: automation.id,
          timezone: automation.timezone,
          ...(automation.cronExpression
            ? { cronExpression: automation.cronExpression }
            : {}),
        },
      });
    }
  }
  if (automation.officialResultEmailEnabled === true) {
    callbacks.push({
      internalKind: "workflow-automation:result-email",
      payload: {
        automationId: automation.id,
        workflowName,
      },
    });
  }
  callbacks.push({
    internalKind: "chat",
    payload: { threadId: chatThreadId, agentId },
  });
  return callbacks;
}

interface WorkflowAutomationLaunchArgs {
  readonly due: DueWorkflowAutomation;
  readonly apiStartTime: number;
  readonly triggerBrief?: string;
  readonly triggerSource?: TriggerSource;
  readonly connectorSourceId?: string;
  readonly callbacks: readonly InternalRunCallbackInput[];
  readonly autonomyBudget: number;
  readonly recordLastRunId: boolean;
  readonly recordLastRunAt: boolean;
  readonly timing?: ApiDispatchTimingCollector;
}

type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

interface InternalRunCallbackInput {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

function workflowThreadSessionRoute(
  modelContext: Extract<ModelContext, { readonly ok: true }>,
) {
  return {
    selectedModel: modelContext.modelPin.selectedModel,
    cliAgentType: modelContext.cliAgentType,
  };
}

function claimCommitInput(input: RunPlan): ThreadRunContext["input"] {
  return {
    args: claimCommitArguments(input.args),
    enforceBuiltInCredits: input.enforceBuiltInCredits,
    context: input.persisted,
  };
}

function claimRejectionContext(
  rejection: ClaimRejectionContext,
): ThreadRunContext["rejection"] {
  if (rejection.kind === "automation") {
    return rejection;
  }
  const input = rejection.runInput;
  return {
    kind: "prompt",
    runInput: {
      orgId: input.orgId,
      userId: input.userId,
      agentId: input.agentId,
      threadId: input.threadId,
      queuedMessage: input.queuedMessage,
      triggerSource: input.triggerSource,
      slackDelivery: input.slackDelivery,
      feishuDelivery: input.feishuDelivery,
      teamsDelivery: input.teamsDelivery,
      discordDelivery: input.discordDelivery,
      telegramDelivery: input.telegramDelivery,
      agentphoneDelivery: input.agentphoneDelivery,
    },
  };
}
function claimLaunchRecord(record: ClaimLaunchRecord): ClaimLaunchRecord {
  if (record.kind === "automation") {
    return record;
  }
  const input = record.context.runInput;
  return {
    kind: "prompt",
    timing: record.timing,
    context: {
      userId: record.context.userId,
      runInput: {
        orgId: input.orgId,
        threadId: input.threadId,
        prompt: input.prompt,
        discordDelivery: input.discordDelivery,
        triggerSource: input.triggerSource,
      },
    },
  };
}

type RunnerInputResult =
  ReturnType<typeof prepareRunnerStorageInput> | CreateRunErrorResult | null;

type PendingClaimRun = {
  readonly kind: "pending";
  readonly runId: string;
  readonly activation: PendingRunActivation;
  readonly context: ThreadRunContext;
};

type ClaimRunCommit =
  | PendingClaimRun
  | { readonly kind: "passed" }
  | {
      readonly kind: "rejected";
      readonly error: { readonly code: string; readonly message: string };
    };

/** A picked input whose preparation or commit failed unexpectedly. */
const ABANDONED_HEAD_ERROR = {
  code: "INTERNAL_ERROR",
  message: "The input could not be started",
} as const;

/** Revalidate only the captured admission facts under the pending transaction. */

/** Producer ownership is persisted with the run rather than carried as a callback. */

/** All writes here use the parent's one pending transaction. */

/**
 * Reuse this outer graph for one organization pass. Each successful claim gets
 * one isolated child graph in the same request Store. The cursor advances over
 * selected work; it never retries a failed launch within this pass.
 */
/**
 * Replace an unconsumed queued input with `input.rejected` and append its
 * visible error. Returns null when the input was already consumed.
 */

/** A picked queue head a rejection records, publishes and reports. */
interface RejectedQueueHead {
  readonly id: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  /** Null once the thread's agent is deleted; the source reply needs it. */
  readonly agentId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
}

/** The Thread child's public surface: input readiness and run start. */
export interface ThreadClaimRunObjects {
  readonly hasFirstPickableChatEvent$: Computed<Promise<boolean>>;
  readonly startRun$: Command<Promise<string | null>, [signal: AbortSignal]>;
}

/** The admission input with the instant its reads are taken. */
export function createThreadClaimRunObjects(
  claim: ThreadClaim,
  context: AgentRunContextSignals,
  prefetchOutcome: "hit" | "not_provided" | "identity_mismatch",
  requestFacts?: ChatThreadRequestFacts,
): ThreadClaimRunObjects {
  // Re-resolve the queued pin against one current catalog snapshot per claim.
  const claimCatalog$ = context.modelCatalog$;
  const pickStartedAt$ = computed(() => {
    return now();
  });
  const internalCommittedRunId$ = state<string | null>(null);
  const publishChatQueueHeadConsumed$ = command(
    async (
      _context,
      head: {
        readonly chatThreadId: string;
        readonly orgId: string;
        readonly userId: string;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      await publishChatThreadMessageCreatedSafely({
        userId: head.userId,
        orgId: head.orgId,
        threadId: head.chatThreadId,
      });
      signal.throwIfAborted();
      await publishThreadListChangedSafely({
        userId: head.userId,
        orgId: head.orgId,
      });
      signal.throwIfAborted();
    },
  );
  const recordQueuedInputAdmissionTiming$ = command(
    async (
      { get },
      head: ChatQueueHeadContext,
      timing: ApiDispatchTimingCollector,
      signal: AbortSignal,
    ) => {
      const apiStartTime = head.apiStartTime;
      const committedAt = get(chatInputEnqueueCommits$).get(head.id);
      if (committedAt !== undefined) {
        timing.recordDuration(
          "api_dispatch_enqueue_commit_to_consume_start",
          "top_level",
          apiStartTime - committedAt,
          apiStartTime,
          { capture_scope: "request_observed_commit" },
        );
      }
      if (head.contextType === "automation") {
        const picked = await get(pickedEvent$);
        signal.throwIfAborted();
        if (!picked) {
          throw new Error("Prepared claim has no picked queue head");
        }
        // Queue age includes enqueue work and legitimate FIFO waiting. It must
        // not be added to S1 or reported as enqueue-commit-to-consume latency.
        await recordWorkflowAdmissionDuration(
          timing,
          "api_dispatch_workflow_event_created_to_consume_start",
          Math.max(0, apiStartTime - picked.createdAt.getTime()),
        );
        signal.throwIfAborted();
      }
    },
  );

  const threadRow$ = computed(async (get) => {
    if (requestFacts) {
      return requestFacts.thread;
    }
    const [row] = await get(db$)
      .select(chatThreadRequestSelection())
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, claim.chatThreadId),
          eq(chatThreads.userId, context.userId),
          eq(chatThreads.agentId, context.agentId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  const pickedEvent$ = computed(
    async (get): Promise<PickedThreadInputEvent | null> => {
      const revoker = alias(chatEvents, "picked_input_revoker");
      const [thread, [row]] = await Promise.all([
        get(threadRow$),
        get(db$)
          .select({
            id: chatEvents.id,
            chatThreadId: chatEvents.chatThreadId,
            createdAt: chatEvents.createdAt,
            seqId: chatEvents.seqId,
            eventType: chatEvents.eventType,
            contextType: chatEvents.contextType,
            contextId: chatEvents.contextId,
            userMessage: canonicalChatEventUserMessage(),
            requiredOfficialWorkflowIds: chatEvents.requiredOfficialWorkflowIds,
            modelSelection: chatEvents.modelSelection,
            canonicalModelSelection: canonicalChatInputModelSelection(),
            sourceAutonomyBudget: agentRuns.autonomyBudget,
          })
          .from(chatEvents)
          .leftJoin(
            agentRuns,
            and(
              eq(chatEvents.contextType, "agent_run"),
              eq(agentRuns.id, chatEvents.contextId),
            ),
          )
          .where(
            and(
              eq(chatEvents.chatThreadId, claim.chatThreadId),
              chatEventRunlessInputPredicate(
                chatEvents.runId,
                chatEvents.eventType,
              ),
              inArray(chatEvents.eventType, [
                "input.prompt",
                "input.automation",
              ]),
              notExists(
                new QueryBuilder()
                  .select({ id: revoker.id })
                  .from(revoker)
                  .where(eq(revoker.revokesEventId, chatEvents.id)),
              ),
            ),
          )
          .orderBy(asc(chatEvents.seqId))
          .limit(1),
      ]);
      if (!thread || !row) {
        return null;
      }
      const owned =
        requestFacts?.input.id === row.id ? requestFacts.input : undefined;
      return {
        ...row,
        ...(owned
          ? {
              userMessage: owned.userMessage,
              modelSelection: owned.modelSelection,
              canonicalModelSelection: owned.modelSelection,
              requiredOfficialWorkflowIds:
                owned.requiredOfficialWorkflowIds ?? null,
            }
          : {}),
        userId: thread.userId,
        agentId: thread.agentId,
        thread,
      };
    },
  );
  const threadContext = createThreadContext(context, pickedEvent$);
  const sessionRead$ = threadContext.sessionRead$;
  const slackContext$ = threadContext.slackContext$;
  const feishuContext$ = threadContext.feishuContext$;
  const teamsContext$ = threadContext.teamsContext$;
  const telegramContext$ = threadContext.telegramContext$;
  const agentPhoneContext$ = threadContext.agentPhoneContext$;
  const discordContext$ = threadContext.discordContext$;
  const automationContext$ = threadContext.automationContext$;
  // Per-claim dispatch timing collectors, created once per graph like the run
  // ids; commands record into them in their own order.
  const claimRunTiming$ = computed((get): ClaimRunTiming => {
    return {
      run: get(threadContext.dispatchTiming$),
      phase: new ApiDispatchPhaseCollector(get(pickStartedAt$)),
    };
  });
  const promptTiming$ = computed(() => {
    return new ChatCallbackPreCreateTimingCollector();
  });
  // Generated once per claim graph; read after authorization admits the head.
  const runIds$ = computed(() => {
    return { runId: randomUUID(), newSessionId: randomUUID() };
  });
  const input$ = computed(async (get) => {
    const head = await get(pickedEvent$);
    if (!head) {
      throw new Error("Claim has no picked event");
    }
    return { orgId: claim.orgId, chatThreadId: claim.chatThreadId, head };
  });
  const queueHeadContext$ = computed(async (get) => {
    const { head } = await get(input$);
    return {
      contextType: head.contextType,
      contextId: head.contextId,
      userId: head.userId,
      agentId: z.string().parse(head.agentId),
    };
  });
  const head$ = computed(async (get) => {
    const [input, context] = await Promise.all([
      get(input$),
      get(queueHeadContext$),
    ]);
    const apiStartTime = get(pickStartedAt$);
    return context
      ? {
          id: input.head.id,
          chatThreadId: claim.chatThreadId,
          orgId: claim.orgId,
          apiStartTime,
          ...context,
        }
      : null;
  });
  const queuedIdentityContext$ = threadContext.executionBootstrap$;
  const resolveQueuedModel$ = threadContext.queuedModel$;
  const promptInputInput$ = computed(
    async (get): Promise<QueuedPromptGraphInput> => {
      const head = await get(head$);
      if (!head) {
        throw new Error("Prompt preparation has no selected head");
      }
      return {
        head,
        timing: get(promptTiming$),
        runTiming: get(claimRunTiming$).run,
      };
    },
  );
  const promptQueuedEventQueuedEvent$ = computed(async (get) => {
    const { head } = await get(promptInputInput$);
    const picked = await get(pickedEvent$);
    // The picked head already excludes consumed and revoked inputs.
    const event =
      picked?.id === head.id && picked.eventType === "input.prompt"
        ? picked
        : null;
    if (!event) {
      return null;
    }
    if (!event.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }
    if (!event.contextType) {
      throw new Error("Queued user message is missing its context type");
    }
    const parsedClaim = safeSync(() => {
      return parseCanonicalChatEventRequiredOfficialWorkflowIds(
        event.requiredOfficialWorkflowIds,
      );
    });
    if ("error" in parsedClaim) {
      throw new QueuedPromptInputInvalidError(
        "Invalid Official Workflow source claim",
      );
    }
    const requiredOfficialWorkflowIds = parsedClaim.ok;
    const officialAgentClaim = resolveQueuedOfficialWorkflowContext({
      contextType: event.contextType,
      contextId: event.contextId,
      requiredOfficialWorkflowIds,
    });
    return {
      ...event,
      userMessage: event.userMessage,
      contextType: event.contextType,
      requiredOfficialWorkflowIds,
      officialAgentClaim,
    };
  });
  const promptSourceAutonomyBudgetSourceAutonomyBudget$ = computed(
    async (get) => {
      const event = await get(promptQueuedEventQueuedEvent$);
      if (!event) {
        return null;
      }
      if (!event.officialAgentClaim) {
        return event.sourceAutonomyBudget;
      }
      const source = agentRunSourceAnnotation(event.userMessage);
      if (!source) {
        throw new QueuedPromptInputInvalidError(
          "Queued Official agent input is missing its source Run annotation",
        );
      }
      const db = get(db$);
      const [run] = await db
        .select({ autonomyBudget: agentRuns.autonomyBudget })
        .from(agentRuns)
        .where(eq(agentRuns.id, source.runId))
        .limit(1);
      return run?.autonomyBudget ?? null;
    },
  );
  const promptQueuedMessageQueuedMessage$ = computed(
    async (get): Promise<QueuedUserMessage | null> => {
      const [event, sourceBudget] = await Promise.all([
        get(promptQueuedEventQueuedEvent$),
        get(promptSourceAutonomyBudgetSourceAutonomyBudget$),
      ]);
      if (!event) {
        return null;
      }
      return {
        id: event.id,
        createdAt: event.createdAt,
        userMessage: event.userMessage,
        requiredOfficialWorkflowIds:
          event.requiredOfficialWorkflowIds ?? undefined,
        selectedModel: event.modelSelection?.selectedModel ?? null,
        contextType: event.contextType,
        contextId: event.contextId,
        autonomyBudget: queuedUserMessageAutonomyBudget(
          event.contextType,
          sourceBudget,
        ),
      };
    },
  );
  const promptAgentAgent$ = threadContext.agentSelection$;
  const promptExecutionContext$ = threadContext.executionBootstrap$;
  const promptArgsArgs$ = computed(
    async (get): Promise<CreateQueuedChatRunInputArgs> => {
      const { head, timing } = await get(promptInputInput$);
      const db = get(db$);
      const [queuedMessage, agent] = await Promise.all([
        get(promptQueuedMessageQueuedMessage$),
        get(promptAgentAgent$),
      ]);
      if (!queuedMessage || queuedMessage.id !== head.id || !agent) {
        throw new Error("Prompt preparation lost its selected head or agent");
      }
      return {
        db,
        threadId: head.chatThreadId,
        userId: head.userId,
        agent: { id: agent.agentId, orgId: head.orgId },
        expectedThreadAgentId: agent.expectedThreadAgentId,
        queuedMessage,
        timing,
      };
    },
  );
  const promptFeaturesFeatures$ = computed(
    (get): Promise<FeatureSwitchContext> => {
      return get(context.featureSwitches$);
    },
  );
  const promptMaterialMaterial$ = computed(
    async (get): Promise<QueuedLaunchMaterial> => {
      const { queuedMessage } = await get(promptArgsArgs$);
      switch (queuedMessage.contextType) {
        case "web":
        case "agent_run": {
          return {
            triggerSource:
              queuedMessage.contextType === "agent_run" ? "agent" : "web",
            delivery: {},
          };
        }
        case "slack": {
          const context = await get(slackContext$);
          if (!context) {
            break;
          }
          return {
            triggerSource: "slack",
            delivery: {
              slackDelivery: {
                channelId: context.channelId,
                threadTs: context.threadTs,
                ...(context.routeThreadTs
                  ? { routeThreadTs: context.routeThreadTs }
                  : {}),
              },
            },
          };
        }
        case "feishu": {
          const context = await get(feishuContext$);
          if (!context) {
            break;
          }
          return {
            triggerSource: context.platform,
            connectorSourceId: context.connectorSourceId,
            delivery: {
              feishuDelivery: queuedFeishuDelivery(context),
            },
          };
        }
        case "teams": {
          const context = await get(teamsContext$);
          if (!context) {
            break;
          }
          return {
            triggerSource: "teams",
            delivery: {
              teamsDelivery: queuedTeamsDelivery(context),
            },
          };
        }
        case "telegram": {
          const context = await get(telegramContext$);
          if (!context || getOfficialTelegramBotConfig().botId === null) {
            break;
          }
          return {
            triggerSource: "telegram",
            delivery: {
              telegramDelivery: queuedTelegramDelivery(context),
            },
          };
        }
        case "agentphone": {
          const context = await get(agentPhoneContext$);
          if (!context) {
            break;
          }
          return {
            triggerSource: "agentphone",
            delivery: {
              agentphoneDelivery: agentphoneDeliveryTargetSchema.parse({
                messageId: context.messageId,
                conversationId: context.conversationId,
                ...(context.isGroup ? { groupId: context.groupId } : {}),
                channel: context.channel,
                isGroup: context.isGroup,
                rootMessageId: context.rootMessageId,
                phoneHandle: context.phoneHandle,
                fromNumber: context.fromNumber,
                toNumber: context.toNumber,
                userLinkId: context.userLinkId,
                agentId: context.agentId,
                agentphoneAgentId: context.agentphoneAgentId,
              }),
            },
          };
        }
        case "discord": {
          const context = await get(discordContext$);
          if (!context) {
            throw new DiscordQueuedLaunchUnavailableError();
          }
          return {
            triggerSource: "discord",
            delivery: { discordDelivery: context.target },
          };
        }
        case "automation": {
          throw new Error("Automation cannot enter the prompt assembler");
        }
      }
      throw new QueuedPromptLaunchUnavailableError();
    },
  );
  const promptModelModel$ = computed(async (get) => {
    return await get(promptResolvePromptModelResolvePromptModel$);
  });
  const promptSessionSession$ = computed(
    async (get): Promise<ChatThreadSessionResolution | null> => {
      const [args, model] = await Promise.all([
        get(promptArgsArgs$),
        get(promptModelModel$),
      ]);
      if ("error" in model) {
        return null;
      }
      const { routedModel } = routeQueuedMessagePiExecution({
        input: args,
        modelRoute: model.route,
      });
      const thread = await get(threadContext.executionThread$);
      if (!thread) {
        throw new Error(
          "Chat thread not found while resolving session binding",
        );
      }
      const agent = await get((await get(promptExecutionContext$)).agent$);
      return resolveChatThreadSessionSnapshot(
        capturedChatThreadSessionSnapshot(
          thread,
          await get(sessionRead$),
          agent,
        ),
        {
          route: {
            selectedModel: routedModel.modelPin.selectedModel,
            cliAgentType: routedModel.cliAgentType,
          },
        },
      );
    },
  );
  const runTemplates$ = threadContext.templates$;
  const promptHostHost$ = threadContext.computerUseHostGrant$;
  const promptCaptureCapture$ = computed(async (get) => {
    const { head } = await get(promptInputInput$);
    if (requestFacts?.input.id === head.id) {
      return requestFacts.input.captureNetworkBodies;
    }
    const db = get(db$);
    const [row] = await db
      .select({ id: chatNetworkBodyCaptures.chatEventId })
      .from(chatNetworkBodyCaptures)
      .where(eq(chatNetworkBodyCaptures.chatEventId, head.id))
      .limit(1);
    return row !== undefined;
  });
  const promptRunInputRunInput$ = computed(
    async (
      get,
    ): Promise<CreateQueuedChatRunInput | QueuedMessageAdmissionFailure> => {
      const [args, launch, model, session, host, capture, features, templates] =
        await Promise.all([
          get(promptArgsArgs$),
          get(promptMaterialMaterial$),
          get(promptModelModel$),
          get(promptSessionSession$),
          get(promptHostHost$),
          get(promptCaptureCapture$),
          get(promptFeaturesFeatures$),
          get(runTemplates$),
        ]);
      const autonomy = args.queuedMessage.autonomyBudget;
      if (autonomy.kind !== "ok") {
        return queuedMessageAdmissionFailure(args, launch, {
          code:
            autonomy.kind === "exhausted"
              ? "AUTONOMY_BUDGET_EXHAUSTED"
              : "AUTONOMY_SOURCE_UNAVAILABLE",
          message:
            autonomy.kind === "exhausted"
              ? AUTONOMY_BUDGET_EXHAUSTED_MESSAGE
              : autonomy.message,
        });
      }
      if ("error" in model) {
        return queuedMessageAdmissionFailure(args, launch, model.error);
      }
      if ("error" in templates) {
        return queuedMessageAdmissionFailure(args, launch, templates.error);
      }
      const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
      if (isRouteError(promptAndSkills)) {
        return queuedMessageAdmissionFailure(
          args,
          launch,
          promptAndSkills.body.error,
        );
      }
      if (!session) {
        throw new Error("A valid prompt model is missing session preparation");
      }
      return queuedPromptRunInput({
        catalog: await get(claimCatalog$),
        input: args,
        launch,
        promptAndSkills,
        model,
        session,
        host,
        capture,
        features,
      });
    },
  );
  const promptResolvePromptModelResolvePromptModel$ = computed(
    async (get): Promise<QueuedMessageModelRouteResolution> => {
      const model = await get(resolveQueuedModel$);
      if ("status" in model) {
        return { error: model.body.error };
      }
      if (model.providerAdmission.error) {
        return { error: model.providerAdmission.error.body.error };
      }
      if (
        isBuiltInModelProviderType(
          model.providerAdmission.effectiveModelProvider,
        ) &&
        !model.builtInModelRuntimeRoute
      ) {
        return {
          error: {
            code: "MODEL_PROVIDER_UNAVAILABLE",
            message:
              "Every built-in model route for this model is temporarily unavailable",
          },
        };
      }
      return {
        route: {
          modelPin: model.pin,
          memberAccountSnapshot: model.memberAccountSnapshot,
          effectiveModelProvider:
            model.providerAdmission.effectiveModelProvider,
          builtInModelRuntimeRoute: model.builtInModelRuntimeRoute ?? undefined,
          piCatalogModel: piCatalogModel(
            await get(claimCatalog$),
            model.pin.selectedModel,
          ),
          cliAgentType: model.providerAdmission.cliAgentType,
          codexServiceTier: model.runCodexServiceTier,
          reasoningEffort: model.reasoningEffort,
        },
      };
    },
  );
  const internalEarlyAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly | null> => {
      const head = await get(head$);
      if (!head) {
        return { kind: "not-ready" };
      }
      const selected = await settle(
        Promise.all([
          get(promptQueuedMessageQueuedMessage$),
          get(promptAgentAgent$),
        ]),
      );
      if (!selected.ok) {
        return queuedPromptPreparationRejection(selected.error, head);
      }
      const [queued, agent] = selected.value;
      if (queued?.id !== head.id) {
        return { kind: "not-ready" };
      }
      return agent ? null : missingQueuedAgentRejection(head);
    },
  );
  const initializeQueuedPrompt$ = command(
    async (
      { get },
      head: ChatQueueHeadContext,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const early = await get(internalEarlyAssembly$);
      signal.throwIfAborted();
      if (early) {
        return false;
      }
      const queued = await get(promptQueuedMessageQueuedMessage$);
      signal.throwIfAborted();
      if (!queued) {
        throw new Error("Prepared prompt has no selected queue input");
      }
      get(promptTiming$).recordElapsed({
        actionType:
          "api_dispatch_pre_create_agent_chat_callback_auto_send_queue_age",
        spanKind: "nested",
        startedAt: queued.createdAt.getTime(),
        finishedAt: head.apiStartTime,
      });
      return true;
    },
  );
  const promptAssembleQueuedPromptRunAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const early = await get(internalEarlyAssembly$);
      if (early) {
        return early;
      }
      const input = await get(promptInputInput$);
      const { head, timing } = input;
      const prepared = await settle(
        timing.measure(
          "api_dispatch_pre_create_agent_chat_callback_auto_send_build_input",
          "top_level",
          () => {
            return get(promptRunInputRunInput$);
          },
        ),
      );
      if (!prepared.ok) {
        return queuedPromptPreparationRejection(prepared.error, head);
      }
      const runInput = prepared.value;
      if ("kind" in runInput) {
        return {
          kind: "rejected",
          rejection: queuedMessageRejection(runInput),
        };
      }
      const agent = await get(promptAgentAgent$);
      if (!agent) {
        return missingQueuedAgentRejection(head);
      }
      return {
        kind: "assembled",
        run: {
          ...buildQueuedRunCommand(runInput, head.apiStartTime),
          timing: input.runTiming,
        },
        producerBinding: agent.producerBinding ?? null,
        rejection: { kind: "prompt", runInput },
        launchRecord: {
          kind: "prompt",
          timing,
          context: { userId: head.userId, runInput },
        },
      };
    },
  );
  const resourceValidation$ = computed(async (get) => {
    const [material, templates] = await Promise.all([
      settle(get(promptMaterialMaterial$)),
      get(runTemplates$),
    ]);
    if (!material.ok) {
      queuedPromptPreparationRejection(
        material.error,
        (await get(promptInputInput$)).head,
      );
      return false;
    }
    return !("error" in templates);
  });
  const promptExecutionSelectionIdentityInput$ = computed(async (get) => {
    if (await get(internalEarlyAssembly$)) {
      return null;
    }
    const { head, runTiming: timing } = await get(promptInputInput$);
    const db = get(db$);
    const args = await get(promptArgsArgs$);
    return {
      db,
      timing,
      owner: { userId: args.userId, orgId: args.agent.orgId },
      apiStartTime: head.apiStartTime,
      agentId: args.agent.id,
      chatThreadId: args.threadId,
      expectedThreadAgentId: args.expectedThreadAgentId,
      queueFirstAssociation: {
        threadId: args.threadId,
        eventId: args.queuedMessage.id,
      },
    };
  });
  const promptExecutionSelectionSelectionInput$ = computed(async (get) => {
    const identity = await get(promptExecutionSelectionIdentityInput$);
    if (!identity) {
      return null;
    }
    const [args, model] = await Promise.all([
      get(promptArgsArgs$),
      get(promptModelModel$),
    ]);
    if ("error" in model || args.queuedMessage.autonomyBudget.kind !== "ok") {
      return null;
    }
    const { piExecution, routedModel } = routeQueuedMessagePiExecution({
      input: args,
      modelRoute: model.route,
    });
    return {
      db: identity.db,
      timing: identity.timing,
      command: {
        owner: identity.owner,
        apiStartTime: identity.apiStartTime,
        body: {
          agentId: identity.agentId,
          ...workflowModelProviderBody(routedModel.effectiveModelProvider),
        },
        chatThreadId: args.threadId,
        expectedThreadAgentId: args.expectedThreadAgentId,
        queueFirstAssociation: identity.queueFirstAssociation,
        agentRunModelPin: {
          modelProvider: routedModel.effectiveModelProvider ?? null,
          modelProviderId: routedModel.modelPin.modelProviderId,
          modelProviderCredentialScope:
            routedModel.modelPin.modelProviderCredentialScope,
          selectedModel: routedModel.modelPin.selectedModel,
        },
        modelProviderId: routedModel.modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          routedModel.modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: routedModel.modelPin.selectedModel ?? undefined,
        builtInModelRuntimeRoute: routedModel.builtInModelRuntimeRoute,
        threadSessionRoute: {
          selectedModel: routedModel.modelPin.selectedModel,
          cliAgentType: routedModel.cliAgentType,
        },
        codexServiceTier: routedModel.codexServiceTier,
        reasoningEffort: resolveReasoningEffortForDispatch({
          catalog: await get(claimCatalog$),
          selectedModel: routedModel.modelPin.selectedModel,
          modelProviderType: routedModel.effectiveModelProvider,
          effort: routedModel.reasoningEffort ?? undefined,
          runtimeProviderType:
            routedModel.builtInModelRuntimeRoute?.providerType ??
            routedModel.effectiveModelProvider,
          piExecution,
        }),
        requiredOfficialWorkflowIds:
          args.queuedMessage.requiredOfficialWorkflowIds,
        piExecution,
        timing: identity.timing,
      },
    };
  });
  const promptExecutionResourcesThreadSession$ = computed(async (get) => {
    if (await get(internalEarlyAssembly$)) {
      return undefined;
    }
    return (await get(promptSessionSession$)) ?? undefined;
  });
  const command$ = computed(async (get) => {
    const assembly = await get(promptAssembleQueuedPromptRunAssembly$);
    return assembly.kind === "assembled" ? assembly.run : null;
  });
  const promptExecutionResourcesFeatureSwitchContext$ = computed(
    async (get) => {
      return (await get(internalEarlyAssembly$))
        ? undefined
        : await get(promptFeaturesFeatures$);
    },
  );
  const availableMaterial$ = computed(async (get) => {
    if (await get(internalEarlyAssembly$)) {
      return null;
    }
    const material = await settle(get(promptMaterialMaterial$));
    if (!material.ok) {
      queuedPromptPreparationRejection(
        material.error,
        (await get(promptInputInput$)).head,
      );
      return null;
    }
    return material.value;
  });
  const promptExecutionResourcesCallbackInputs$ = computed(async (get) => {
    if (await get(internalEarlyAssembly$)) {
      return undefined;
    }
    const [args, material] = await Promise.all([
      get(promptArgsArgs$),
      get(availableMaterial$),
    ]);
    if (!material) {
      return undefined;
    }
    return queuedChatRunCallbackInputs({
      threadId: args.threadId,
      agentId: args.agent.id,
      queuedMessage: args.queuedMessage,
      ...queuedIntegrationLaunchFields(material, args.agent.id),
    });
  });
  const event$ = automationContext$;
  const capturedAutomationTarget$ = threadContext.automationTarget$;
  const target$ = capturedAutomationTarget$;
  const queuedAutomationRunSources = {
    event$: event$,
    target$: target$,
  };
  const {
    event$: queuedAutomationBudgetEvent$,
    target$: queuedAutomationBudgetTarget$,
  } = queuedAutomationRunSources;
  const queuedAutomationBudgetSourceAutonomyBudget$ = computed(async (get) => {
    const event = await get(queuedAutomationBudgetEvent$);
    if (!event) {
      return null;
    }
    const sourceRunId =
      event.eventType === "chat-run-finished"
        ? event.eventPayload?.["runId"]
        : event.eventType === "manual"
          ? event.eventPayload?.["sourceRunId"]
          : undefined;
    if (typeof sourceRunId !== "string") {
      return { sourceRunId, autonomyBudget: null };
    }
    const [run] = await get(db$)
      .select({ autonomyBudget: agentRuns.autonomyBudget })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, sourceRunId), isNotNull(agentRuns.triggerSource)),
      )
      .limit(1);
    return { sourceRunId, autonomyBudget: run?.autonomyBudget ?? null };
  });
  const autonomyBudget$ = computed(
    async (get): Promise<AutonomyBudgetResult> => {
      const [event, target, source] = await Promise.all([
        get(queuedAutomationBudgetEvent$),
        get(queuedAutomationBudgetTarget$),
        get(queuedAutomationBudgetSourceAutonomyBudget$),
      ]);
      if (!event || !target || !source) {
        return {
          kind: "invalid",
          error: {
            code: "CONFLICT",
            message: "Workflow automation no longer exists",
          },
        };
      }
      if (
        event.eventType !== "chat-run-finished" &&
        source.sourceRunId === undefined
      ) {
        return { kind: "ok", autonomyBudget: target.automation.autonomyBudget };
      }
      const label =
        event.eventType === "manual"
          ? "Manual automation"
          : "Chat run finished";
      if (typeof source.sourceRunId !== "string") {
        return {
          kind: "invalid",
          error: {
            code: "AUTONOMY_SOURCE_UNAVAILABLE",
            message: `${label} event is missing its source run`,
          },
        };
      }
      if (source.autonomyBudget === null) {
        return {
          kind: "invalid",
          error: {
            code: "AUTONOMY_SOURCE_UNAVAILABLE",
            message: `${label} source run no longer exists`,
          },
        };
      }
      const derived = childAutonomyBudget(source.autonomyBudget);
      return derived.kind === "exhausted"
        ? {
            kind: "invalid",
            error: {
              code: "AUTONOMY_BUDGET_EXHAUSTED",
              message: AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
            },
          }
        : { kind: "ok", autonomyBudget: derived.autonomyBudget };
    },
  );
  const budget = {
    sourceAutonomyBudget$: queuedAutomationBudgetSourceAutonomyBudget$,
    autonomyBudget$: autonomyBudget$,
  };
  const {
    event$: queuedAutomationMaterialEvent$,
    target$: queuedAutomationMaterialTarget$,
  } = queuedAutomationRunSources;
  const launchMaterial$ = computed(async (get) => {
    const [event, target] = await Promise.all([
      get(queuedAutomationMaterialEvent$),
      get(queuedAutomationMaterialTarget$),
    ]);
    if (!event || !target) {
      return null;
    }
    return buildWorkflowAutomationQueuedLaunchMaterial({
      workflowName: event.workflowName,
      eventType: event.eventType,
      eventPayload: event.eventPayload,
      automation: target.automation,
      agentId: target.agentId,
      chatThreadId: event.chatThreadId,
    });
  });
  const material = { launchMaterial$: launchMaterial$ };
  // The admitted automation's launch arguments use its captured target.
  const automationLaunchReadinessInput$ = computed(
    async (get): Promise<AssembleWorkflowAutomationRunArgs> => {
      const [head, event, target, launchMaterial, autonomyBudget] =
        await Promise.all([
          get(head$),
          get(event$),
          get(target$),
          get(launchMaterial$),
          get(autonomyBudget$),
        ]);
      if (
        !head ||
        !event ||
        !target ||
        !launchMaterial ||
        autonomyBudget.kind === "invalid"
      ) {
        throw new Error("Automation launch requires an admitted queued input");
      }
      return queuedAutomationLaunchArguments({
        head,
        event,
        target,
        material: launchMaterial,
        autonomyBudget: autonomyBudget.autonomyBudget,
      });
    },
  );
  const workflowAutomationLaunchReadGraphSources = {
    input$: automationLaunchReadinessInput$,
  };
  const { input$: workflowAutomationLaunchReadGraphInput$ } =
    workflowAutomationLaunchReadGraphSources;
  const automationLaunchMaterialsComputerUseHostGrant$ =
    threadContext.computerUseHostGrant$;
  const workflowAutomationLaunchReadGraphComputerUseHostGrant$ =
    automationLaunchMaterialsComputerUseHostGrant$;
  // Both claim paths share one queued model graph; its input follows the head.
  const automationLaunchEffectsResolveQueuedModel$ = resolveQueuedModel$;
  const automationLaunchEffectsRecordQueuedWorkflowReward$ = command(
    async (
      { set },
      args: AssembleWorkflowAutomationRunArgs,
      signal: AbortSignal,
    ) => {
      const statement = recordGetStartedWorkflowSql(
        {
          orgId: args.due.automation.orgId,
          userId: args.due.automation.ownerUserId,
          workflowId: args.due.automation.workflowId,
          sourceEventId: args.queueEventId,
        },
        nowDate(),
      );
      await set(writeDb$).execute(statement);
      signal.throwIfAborted();
    },
  );
  const workflowAutomationLaunchReadGraphRecordQueuedWorkflowReward$ =
    automationLaunchEffectsRecordQueuedWorkflowReward$;
  const workflowAutomationLaunchReadGraphTiming$ = computed((get) => {
    return get(claimRunTiming$).run;
  });
  const workflowAutomationLaunchReadGraphModel$ = computed(
    async (get): Promise<ModelContext> => {
      const args = await get(automationExecutionInput$);
      if (!args) {
        return {
          ok: false,
          failure: {
            kind: "conflict",
            message: "Workflow automation no longer exists",
          },
        };
      }
      return workflowModelContext(
        await get(claimCatalog$),
        args.due.chatThreadId,
        await get(automationLaunchEffectsResolveQueuedModel$),
      );
    },
  );
  const automationExecutionInput$ = computed(async (get) => {
    const [head, event, target] = await Promise.all([
      get(head$),
      get(event$),
      get(capturedAutomationTarget$),
    ]);
    if (!head || !event || !target) {
      return null;
    }
    return {
      due: { ...target, chatThreadId: event.chatThreadId },
      apiStartTime: head.apiStartTime,
      queueEventId: event.id,
      connectorSourceId: event.connectorSourceId ?? undefined,
      triggerSource: manualTriggerSource(target.automation),
    };
  });
  const workflowAutomationLaunchReadGraphIdentityInput$ = computed(
    async (get) => {
      const args = await get(automationExecutionInput$);
      if (!args) {
        return null;
      }
      return {
        timing: get(workflowAutomationLaunchReadGraphTiming$),
        owner: workflowAutomationRunOwner(args.due.automation),
        apiStartTime: args.apiStartTime,
        agentId: args.due.agentId,
        chatThreadId: args.due.chatThreadId,
        queueFirstAssociation: {
          threadId: args.due.chatThreadId,
          eventId: args.queueEventId,
        },
      };
    },
  );
  const workflowAutomationLaunchReadGraphSelectionInput$ = computed(
    async (get) => {
      const [identity, model, args] = await Promise.all([
        get(workflowAutomationLaunchReadGraphIdentityInput$),
        get(workflowAutomationLaunchReadGraphModel$),
        get(automationExecutionInput$),
      ]);
      return identity && model.ok && args
        ? {
            timing: identity.timing,
            command: automationSelectionCommand(args, model, identity.timing),
          }
        : null;
    },
  );
  const workflowAutomationLaunchInput$ =
    workflowAutomationLaunchReadGraphInput$;
  const computerUseHostGrant$ =
    workflowAutomationLaunchReadGraphComputerUseHostGrant$;
  const recordQueuedWorkflowReward$ =
    workflowAutomationLaunchReadGraphRecordQueuedWorkflowReward$;
  const timing$ = workflowAutomationLaunchReadGraphTiming$;
  const workflowAutomationLaunchModel$ =
    workflowAutomationLaunchReadGraphModel$;
  const workflowAutomationLaunchIdentityInput$ =
    workflowAutomationLaunchReadGraphIdentityInput$;
  const workflowAutomationLaunchSelectionInput$ =
    workflowAutomationLaunchReadGraphSelectionInput$;
  const assembleWorkflowAutomationRun$ = computed(
    async (get): Promise<AssembledWorkflowAutomationRun | RunFailure> => {
      const args = await get(workflowAutomationLaunchInput$);
      const [selection, model, computerUseHostGrant] = await Promise.all([
        get(workflowAutomationLaunchSelectionInput$),
        get(workflowAutomationLaunchModel$),
        get(computerUseHostGrant$),
      ]);
      if (!model.ok) {
        return model.failure;
      }
      const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
      if (isRouteError(promptAndSkills)) {
        return { kind: "run_error", response: promptAndSkills };
      }
      if (!selection) {
        throw new Error(
          "A valid automation model is missing execution identity",
        );
      }
      return {
        kind: "assembled",
        run: {
          ...selection.command,
          triggerSource: args.triggerSource ?? "automation-schedule",
          body: {
            ...selection.command.body,
            prompt: promptAndSkills.userPrompt,
          },
          computerUseHostId: computerUseHostGrant?.hostId,
          appendSystemPrompt: promptAndSkills.appendedSystemPrompt,
          callbacks: args.callbacks,
          agentRunMetadata: workflowAutomationRunMetadata(
            args.due.automation,
            args.triggerBrief,
            args.autonomyBudget,
          ),
        },
        producerBinding: {
          kind: "automation",
          queueEventId: args.queueEventId,
        },
        launchRecord: {
          kind: "automation",
          automationId: args.due.automation.id,
          orgId: args.due.automation.orgId,
          userId: args.due.automation.ownerUserId,
          threadId: args.due.chatThreadId,
          recordLastRunId: args.recordLastRunId,
          recordLastRunAt: args.recordLastRunAt,
          disableClaimedOnceSchedule:
            args.due.allowClaimedOnceScheduleAutomation === true,
        },
      };
    },
  );
  const initializeWorkflowAutomationRun$ = command(
    async (
      { get },
      args: AssembleWorkflowAutomationRunArgs,
      signal: AbortSignal,
    ): Promise<AssembleWorkflowAutomationRunArgs | null> => {
      const assembly = await get(assembleWorkflowAutomationRun$);
      signal.throwIfAborted();
      if (assembly.kind === "assembled") {
        get(timing$).recordElapsed(
          "api_dispatch_pre_create_agent_workflow_automation_create_run",
          "nested",
          now(),
        );
      }
      // An assembled launch records its independent Get Started reward; the
      // caller runs it alongside the launch reads rather than ahead of them.
      return assembly.kind === "assembled" ? args : null;
    },
  );
  const workflowAutomationLaunchAssembly$ = assembleWorkflowAutomationRun$;
  const { target$: queuedAutomationAssemblerTarget$ } =
    queuedAutomationRunSources;
  const { launchMaterial$: queuedAutomationAssemblerLaunchMaterial$ } =
    material;
  // A head whose automation input can no longer be read is rejected from its
  // captured reads.
  const queuedAutomationAssemblerInternalEarlyAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly | null> => {
      if (await get(automationExecutionInput$)) {
        return null;
      }
      const head = await get(head$);
      if (!head) {
        return { kind: "not-ready" };
      }
      return {
        kind: "rejected",
        rejection: {
          userId: head.userId,
          error: {
            code: "CONFLICT",
            message: "Workflow automation no longer exists",
          },
        },
      };
    },
  );
  const {
    event$: initializeQueuedAutomationEvent$,
    target$: initializeQueuedAutomationTarget$,
  } = queuedAutomationRunSources;
  const {
    sourceAutonomyBudget$: initializeQueuedAutomationSourceAutonomyBudget$,
    autonomyBudget$: initializeQueuedAutomationAutonomyBudget$,
  } = budget;
  const { launchMaterial$: initializeQueuedAutomationLaunchMaterial$ } =
    material;
  const initializeAutomationExecution$ = command(
    (
      _store,
      head: ChatQueueHeadContext,
      runTiming: ApiDispatchTimingCollector,
      signal: AbortSignal,
    ): false => {
      signal.throwIfAborted();
      // Records the entrypoint gap on the claim's run timing.
      workflowAutomationTiming(runTiming, head.apiStartTime);
      return false;
    },
  );
  const initializeQueuedAutomationInitializeQueuedAutomation$ = command(
    async (
      { get },
      head: ChatQueueHeadContext,
      signal: AbortSignal,
    ): Promise<QueuedAutomationLaunch> => {
      const unreadable = (message: string): RejectedQueueRunAssembly => {
        return {
          kind: "rejected",
          rejection: {
            error: { code: "CONFLICT", message },
            userId: head.userId,
          },
        };
      };
      const [event, loadedTarget] = await Promise.all([
        get(initializeQueuedAutomationEvent$),
        get(initializeQueuedAutomationTarget$),
        get(initializeQueuedAutomationSourceAutonomyBudget$),
      ]);
      signal.throwIfAborted();
      if (!event || !loadedTarget) {
        return rejectedAutomationLaunch(
          unreadable(
            !event
              ? "Workflow queue event payload is unreadable"
              : "Workflow automation no longer exists",
          ),
        );
      }
      const target = loadedTarget;
      const [material, autonomyBudget] = await Promise.all([
        get(initializeQueuedAutomationLaunchMaterial$),
        get(initializeQueuedAutomationAutonomyBudget$),
      ]);
      signal.throwIfAborted();
      if (!material) {
        return rejectedAutomationLaunch({
          kind: "rejected",
          rejection: {
            userId: target.automation.ownerUserId,
            error: {
              code: "CONFLICT",
              message: "Workflow queue event payload is unreadable",
            },
          },
        });
      }
      if (autonomyBudget.kind === "invalid") {
        return rejectedAutomationLaunch({
          kind: "rejected",
          rejection: {
            userId: target.automation.ownerUserId,
            error: autonomyBudget.error,
          },
        });
      }
      return {
        kind: "launch",
        args: queuedAutomationLaunchArguments({
          head,
          event,
          target,
          material,
          autonomyBudget: autonomyBudget.autonomyBudget,
        }),
      };
    },
  );
  /** Resolve the automation's captured model context before launch preparation. */
  const resolveAutomationModelSnapshot$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      const args = await get(automationExecutionInput$);
      signal.throwIfAborted();
      if (!args) {
        return;
      }
      await measureApiDispatchTiming(
        get(timing$),
        "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context",
        "nested",
        async () => {
          await get(workflowAutomationLaunchModel$);
        },
      );
      signal.throwIfAborted();
    },
  );
  const queuedAutomationAssemblerAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const early = await get(queuedAutomationAssemblerInternalEarlyAssembly$);
      if (early) {
        return early;
      }
      const [assembled, target] = await Promise.all([
        get(workflowAutomationLaunchAssembly$),
        get(queuedAutomationAssemblerTarget$),
      ]);
      if (!target) {
        throw new Error(
          "Automation target disappeared within its captured reads",
        );
      }
      if (assembled.kind !== "assembled") {
        return {
          kind: "rejected",
          rejection: {
            userId: target.automation.ownerUserId,
            error:
              assembled.kind === "conflict"
                ? { code: "CONFLICT", message: assembled.message }
                : assembled.response.body.error,
          },
        };
      }
      return {
        kind: "assembled",
        run: assembled.run,
        producerBinding: assembled.producerBinding,
        rejection: {
          kind: "automation",
          userId: target.automation.ownerUserId,
        },
        launchRecord: assembled.launchRecord,
      };
    },
  );
  const queuedAutomationAssemblerIdentityInput$ = computed(async (get) => {
    return await get(workflowAutomationLaunchIdentityInput$);
  });
  const queuedAutomationAssemblerSelectionInput$ = computed(async (get) => {
    return await get(workflowAutomationLaunchSelectionInput$);
  });
  const queuedAutomationAssemblerCallbackInputs$ = computed(async (get) => {
    if (await get(queuedAutomationAssemblerInternalEarlyAssembly$)) {
      return undefined;
    }
    return (await get(queuedAutomationAssemblerLaunchMaterial$))?.callbacks;
  });
  const queuedAutomationAssemblerCommand$ = computed(async (get) => {
    const assembly = await get(queuedAutomationAssemblerAssembly$);
    return assembly.kind === "assembled" ? assembly.run : null;
  });
  const isAutomation$ = computed(async (get) => {
    return (await get(head$))?.contextType === "automation";
  });
  const assembly$ = computed(async (get) => {
    return get(
      (await get(isAutomation$))
        ? queuedAutomationAssemblerAssembly$
        : promptAssembleQueuedPromptRunAssembly$,
    );
  });
  const identityInput$ = computed(
    async (get): Promise<AgentRunIdentityInput | null> => {
      return (await get(isAutomation$))
        ? get(queuedAutomationAssemblerIdentityInput$)
        : get(promptExecutionSelectionIdentityInput$);
    },
  );
  const selectionInput$ = computed(
    async (get): Promise<AgentRunGraphInput | null> => {
      return (await get(isAutomation$))
        ? get(queuedAutomationAssemblerSelectionInput$)
        : get(promptExecutionSelectionSelectionInput$);
    },
  );
  const selectedCommand$ = computed(async (get) => {
    return get(
      (await get(isAutomation$)) ? queuedAutomationAssemblerCommand$ : command$,
    );
  });
  const featureSwitchContext$ = computed(async (get) => {
    return (await get(isAutomation$))
      ? undefined
      : get(promptExecutionResourcesFeatureSwitchContext$);
  });
  const callbackInputs$ = computed(
    async (get): Promise<readonly RunCallback[] | undefined> => {
      return (await get(isAutomation$))
        ? get(queuedAutomationAssemblerCallbackInputs$)
        : get(promptExecutionResourcesCallbackInputs$);
    },
  );
  const threadSession$ = computed(
    async (get): Promise<ChatThreadSessionResolution | undefined> => {
      return (await get(isAutomation$))
        ? get(preCreateThreadSessionThreadSession$)
        : get(promptExecutionResourcesThreadSession$);
    },
  );
  const preCreateInput$ = computed(async (get): Promise<AgentRunGraphInput> => {
    const input = await get(selectionInput$);
    if (!input) {
      throw new Error("Agent preparation has no selected input");
    }
    return input;
  });
  const selectedIdentityInputIdentityInput$ = computed(
    async (get): Promise<AgentRunGraphInput> => {
      const input = await get(identityInput$);
      if (!input) {
        throw new Error("Run identity is unavailable");
      }
      return {
        timing: input.timing,
        command: {
          owner: input.owner,
          apiStartTime: input.apiStartTime,
          body: { agentId: input.agentId },
          chatThreadId: input.chatThreadId,
          expectedThreadAgentId: input.expectedThreadAgentId,
          queueFirstAssociation: input.queueFirstAssociation,
        },
      };
    },
  );
  const preCreateAgentIdAgentId$ = computed(async (get) => {
    const { command: args, timing } = await get(
      selectedIdentityInputIdentityInput$,
    );
    // A Thread run always names its queue head's Agent.
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_resolve_agent_id",
      () => {
        return Promise.resolve(args.body.agentId);
      },
    );
  });
  const preCreateRequestObservationRequestObservation$ = computed(
    async (get) => {
      const { command } = await get(selectedIdentityInputIdentityInput$);
      const agentId = await get(preCreateAgentIdAgentId$);
      return agentId
        ? matchingAuthorizedRequestObservation(command, agentId)
        : undefined;
    },
  );
  const preCreateAgentAgent$ = computed(
    async (get): Promise<AgentRunRecord | null> => {
      const { timing } = await get(selectedIdentityInputIdentityInput$);
      const [agentId, observation] = await Promise.all([
        get(preCreateAgentIdAgentId$),
        get(preCreateRequestObservationRequestObservation$),
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
          // Authorization waits only for the context's Agent snapshot.
          return await get((await get(executionContext$)).agent$);
        },
        {
          authorized_request_agent_source:
            observation === undefined ? "database" : "request_observation",
        },
      );
    },
  );
  const executionContext$ = threadContext.executionBootstrap$;
  const connectedAccounts = createConnectedAccountsSignals(
    pickedEvent$,
    threadContext,
  );
  const connectorRuntime = createConnectorRuntimeSignals(
    threadContext,
    connectedAccounts,
  );
  const preCreateBootstrapMetadata$ = computed(async (get) => {
    const startedAt = now();
    const selected = await get(executionContext$);
    const [
      { timing },
      selection,
      memberMetadata,
      permissionGrants,
      workflows,
      featureSwitchContext,
    ] = await Promise.all([
      get(selectedIdentityInputIdentityInput$),
      get(selected.connectorSelection$),
      get(selected.memberMetadata$),
      get(selected.permissionGrants$),
      get(selected.workflows$),
      get(selected.featureSwitches$),
    ]);
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_load_bootstrap_snapshot_rows",
      "nested",
      startedAt,
      now(),
      {
        bootstrap_prefetch: prefetchOutcome === "hit" ? "hit" : "miss",
        ...(prefetchOutcome === "hit"
          ? {}
          : { bootstrap_prefetch_miss_reason: prefetchOutcome }),
      },
    );
    const connectorScope = agentConnectorScopeFromRows({
      connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
        return {
          connectorSlug,
        };
      }),
      customConnectorRows: selection.customConnectors,
    });
    const metadataSlugs = new Set(
      selection.customConnectors.flatMap((connector) => {
        const ref = connector.permissionBundleRef;
        const dependency =
          ref === null
            ? null
            : customConnectorPermissionBundleDependencySlug(ref);
        return dependency === null ? [] : [dependency];
      }),
    );
    return {
      ...connectorScope,
      userInfo: {
        name: memberMetadata.profile?.name ?? null,
        email: memberMetadata.profile?.email ?? null,
        timezone: memberMetadata.preferences?.timezone ?? null,
      },
      featureSwitchContext,
      workflows,
      permissionGrants: permissionGrants.map(
        ({ connectorSlug, permission, action }) => {
          return {
            connectorSlug,
            permission,
            action,
          };
        },
      ),
      connectorCatalogMetadataSlugs: [...metadataSlugs].sort(),
    };
  });
  const preCreateBootstrapBootstrap$ = computed(async (get) => {
    const { timing } = await get(selectedIdentityInputIdentityInput$);
    const metadata = await get(preCreateBootstrapMetadata$);
    return await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_materialize_bootstrap_context",
      () => {
        return metadata;
      },
      {
        agent_run_bootstrap_workflow_winner_count_bucket: countBucket(
          metadata.workflows.length,
        ),
      },
    );
  });
  const preCreateSubscriptionAccountSubscriptionAccount$ = computed(
    async (get) => {
      const { command } = await get(preCreateInput$);
      const model = await get(threadContext.subscriptionSelection$);
      if ("status" in model) {
        return model;
      }
      return {
        command: {
          ...command,
          modelProviderId: model.modelProviderId,
          agentRunModelPin: model.agentRunModelPin,
        },
      };
    },
  );
  const preCreateConnectorCatalogConnectorCatalog$ =
    connectedAccounts.connectorCatalog$;
  const preCreatePermissionPoliciesPermissionPolicies$ =
    connectorRuntime.permissionPolicies$;
  const sessionPrompt$ = computed(async (get) => {
    return (await get(selectedCommand$))?.appendSystemPrompt;
  });
  const preCreatePostAuthorizationPostAuthorization$ = computed(
    async (get): Promise<AgentRunAfterPreCreate | CreateRunErrorResult> => {
      const { timing } = await get(preCreateInput$);
      const [
        bootstrapResult,
        agentResult,
        accountResult,
        catalogResult,
        policiesResult,
        observationResult,
      ] = await Promise.all([
        get(preCreateBootstrapBootstrap$),
        get(preCreateAgentAgent$),
        get(preCreateSubscriptionAccountSubscriptionAccount$),
        get(preCreateConnectorCatalogConnectorCatalog$),
        get(preCreatePermissionPoliciesPermissionPolicies$),
        get(preCreateRequestObservationRequestObservation$),
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
        connectorCatalogSelection: catalog,
        runPermissionPolicies: policies,
        authorizedRequestObservation: observation ?? {
          userId: account.command.owner.userId,
          orgId: account.command.owner.orgId,
          agent,
          featureSwitchContext: bootstrap.featureSwitchContext,
        },
      };
    },
  );
  const cloudBrowserEnabled$ = computed(async (get) => {
    const thread = (await get(pickedEvent$))?.thread;
    if (!thread) {
      throw new Error("Agent prompt requires a chat thread");
    }
    return thread.cloudBrowserEnabled;
  });
  const preCreatePreparedInput$ = computed(async (get) => {
    const [input, resolution, appendSystemPrompt, fullCommand, catalog] =
      await Promise.all([
        get(preCreatePostAuthorizationPostAuthorization$),
        get(threadSession$),
        get(sessionPrompt$),
        get(selectedCommand$),
        get(claimCatalog$),
      ]);
    if (!fullCommand) {
      return null;
    }
    if ("status" in input) {
      return input;
    }
    const body: ThreadRunBody = { ...fullCommand.body };
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
      cloudBrowserEnabled: await get(cloudBrowserEnabled$),
    };
  });
  const preCreateRunArgsRunArgs$ = computed(async (get) => {
    const input = await get(preCreatePreparedInput$);
    if (!input || "status" in input) {
      return input;
    }
    return {
      input,
      args: await measureAgentRunPreCreate(
        input.timing,
        "api_dispatch_pre_create_agent_build_create_run_args",
        () => {
          return buildProductRunArgs(input);
        },
      ),
    };
  });
  const preCreateExecutionBootstrapMetadata$ = preCreateBootstrapMetadata$;
  const runDisabledPaidToolsSnapshot$ = computed(async (get) => {
    const selected = await get(executionContext$);
    return {
      orgId: selected.orgId,
      userId: selected.userId,
      toolIds: await get(selected.disabledPaidTools$),
    };
  });
  const runMemberSnapshot$ = computed(async (get) => {
    const selected = await get(executionContext$);
    return {
      orgId: selected.orgId,
      userId: selected.userId,
      member: (await get(selected.memberMetadata$)).preferences ?? undefined,
    };
  });
  const runEnvironmentSnapshot$ = computed(async (get) => {
    const selected = await get(executionContext$);
    return {
      orgId: selected.orgId,
      userId: selected.userId,
      variables: (await get(selected.environment$)).variables,
    };
  });
  const resources = {
    disabledPaidTools$: runDisabledPaidToolsSnapshot$,
    member$: runMemberSnapshot$,
    environment$: runEnvironmentSnapshot$,
  };
  const preCreateModelFeatureSwitchContext$ = computed(async (get) => {
    const observed = await get(featureSwitchContext$);
    return observed === undefined
      ? (await get(preCreateExecutionBootstrapMetadata$)).featureSwitchContext
      : observed;
  });
  const runFramework$ = threadContext.requestedFramework$;
  const modelRoute$ = threadContext.modelRoute$;
  const promptAndSkillVolumes$ = createPromptAndSkillVolumesSignals(
    context,
    pickedEvent$,
    threadContext,
  );
  const preparedPromptAndSkillVolumes$ = computed(
    async (get): Promise<PromptAndSkillVolumes | CreateRunErrorResult> => {
      if (!(await get(isAutomation$))) {
        const templates = await get(runTemplates$);
        if ("error" in templates) {
          return badRequestMessage(templates.error.message);
        }
      }
      // Preserve model and official-workflow admission before final rendering.
      const officialWorkflow = await get(officialWorkflow$);
      if (isRouteError(officialWorkflow)) {
        return officialWorkflow;
      }
      const result = await settle(get(promptAndSkillVolumes$));
      if (!result.ok) {
        if (result.error instanceof PromptAndSkillVolumesError) {
          // Source admission preserves the channel-specific rejection code;
          // independent storage preparation must also return a failed result.
          return result.error.code === "BAD_REQUEST"
            ? badRequestMessage(result.error.message)
            : conflict(result.error.message);
        }
        if (result.error instanceof OfficialWorkflowRunAdmissionError) {
          return conflict(result.error.message);
        }
        throw result.error;
      }
      return result.value;
    },
  );
  const model = {
    featureSwitchContext$: preCreateModelFeatureSwitchContext$,
    framework$: runFramework$,
    modelRoute$: modelRoute$,
  };
  const connectorSelection$ = connectedAccounts.connectorSelection$;
  const connectorSnapshot$ = connectedAccounts.connectorSnapshot$;
  const preCreateExecutionConnectors = {
    connectorSelection$,
    connectorSnapshot$,
  };
  const {
    bodyEnvironment$: preCreateBodyEnvironmentEnvironment$,
    eagerSecretPlan$: runConnectorEagerSecretPlan$,
    eagerCredentialContext$,
    connectorContext$,
  } = connectorRuntime;
  // Capture the exact eager plan before preloading its read-only context.
  const preloadEagerCredentials$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      if (!(await get(selectionInput$))) {
        signal.throwIfAborted();
        return;
      }
      const context = await get(eagerCredentialContext$);
      signal.throwIfAborted();
      waitUntil(settle(get(context.credentials$)));
    },
  );
  const prepared = { connectorContext$: connectorContext$ };
  const workflow = createOfficialWorkflowSignals(pickedEvent$, threadContext);
  const { officialWorkflow$ } = workflow;
  const userTimezone$ = computed(async (get) => {
    return (
      (await get(preCreateExecutionBootstrapMetadata$)).userInfo.timezone ??
      undefined
    );
  });
  const shared = {
    ...resources,
    ...model,
    ...preCreateExecutionConnectors,
    ...prepared,
    ...workflow,
    bodyEnvironment$: preCreateBodyEnvironmentEnvironment$,
    userTimezone$: userTimezone$,
  };
  const graph = {
    input$: preCreateInput$,
    identityInput$: selectedIdentityInputIdentityInput$,
    agentId$: preCreateAgentIdAgentId$,
    agent$: preCreateAgentAgent$,
    threadSession$: threadSession$,
    runArgs$: preCreateRunArgsRunArgs$,
    bootstrap$: preCreateBootstrapBootstrap$,
    shared: shared,
    bootstrapMetadata$: preCreateBootstrapMetadata$,
  };
  const preCreateThreadSessionThreadSession$ = computed(
    async (get): Promise<ChatThreadSessionResolution | undefined> => {
      const { command, timing } = await get(preCreateInput$);
      if (!command.chatThreadId) {
        return undefined;
      }
      const agent = await get(preCreateAgentAgent$);
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      const threadId = command.chatThreadId;
      const route = command.threadSessionRoute;
      if (!route) {
        throw new Error("Thread-bound agent run is missing its model route");
      }
      return await measureAgentRunPreCreate(
        timing,
        "api_dispatch_pre_create_agent_resolve_thread_session",
        async () => {
          const thread = await get(threadContext.executionThread$);
          if (!thread || thread.id !== threadId) {
            throw new Error(
              "Chat thread not found while resolving session binding",
            );
          }
          return resolveChatThreadSessionSnapshot(
            capturedChatThreadSessionSnapshot(
              thread,
              await get(sessionRead$),
              agent,
            ),
            {
              route,
            },
          );
        },
      );
    },
  );
  const capturedSelectedStorageInput$ = computed(
    async (get): Promise<AgentRunStorageInput | CreateRunErrorResult> => {
      const [
        input,
        agent,
        session,
        requestedFramework,
        modelProvider,
        officialWorkflowRun,
      ] = await Promise.all([
        get(preCreateInput$),
        get(preCreateAgentAgent$),
        get(threadSession$),
        get(runFramework$),
        get(modelRoute$),
        get(officialWorkflow$),
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
      if (isRouteError(officialWorkflowRun)) {
        return officialWorkflowRun;
      }
      const resolved = selectedRunStorageExecution(agent, session);
      if (isRouteError(resolved)) {
        return resolved;
      }
      const framework = modelProvider
        ? modelProviderFramework(modelProvider)
        : requestedFramework;
      const piSandbox = resolvePreparedPiModelConfig({
        input: {
          catalog: await get(claimCatalog$),
          piExecution: selectedRunPiExecution(input.command),
          codexServiceTier: input.command.codexServiceTier,
          reasoningEffort: input.command.reasoningEffort,
        },
        modelProvider,
      });
      const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
      if (isRouteError(promptAndSkills)) {
        return promptAndSkills;
      }
      const metadata = prepareRunOutputMetadata({
        skillVolumes: promptAndSkills.skillVolumes,
        officialWorkflow: officialWorkflowRun,
        framework,
        piSandbox,
        body: {},
        resolved,
      });
      return {
        kind: "requested",
        args: {
          db: get(db$),
          instructionsStorageName: resolved.instructionsStorageName,
          agentOrgId: resolved.orgId,
          runtimeOrgId: input.command.owner.orgId,
          userId: input.command.owner.userId,
          artifacts: metadata.artifacts,
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
  const storageInput$ = computed(async (get): Promise<AgentRunStorageInput> => {
    const input = await get(capturedSelectedStorageInput$);
    if (isRouteError(input)) {
      throw new Error("Rejected storage input cannot be materialized");
    }
    return input;
  });
  const storageSelection$ = computed(
    async (get): Promise<AgentRunStorageSelection> => {
      const input = await get(storageInput$);
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
    },
  );
  const capturedStorageBaseIndex$ = computed(async (get) => {
    const selection = await get(storageSelection$);
    const input = {
      db: selection.args.db,
      requests: selection.requests,
      timing: selection.args.timing,
    };
    const prefetched = await get((await get(executionContext$)).storage$);
    const ownedRequests = input.requests.filter((request) => {
      return !prefetched.lookupKeys.has(
        storageIndexKey(
          request.lookup.orgId,
          request.lookup.userId,
          request.lookup.name,
        ),
      );
    });
    const index = mergeStorageIndexes(
      prefetched.index,
      await loadStorageBaseIndex(input.db, ownedRequests, input.timing),
    );
    // Keep the query and its selection together so dependent version reads
    // reuse this snapshot without walking the same upstream graph again.
    const capturedVersionKeys = new Set(
      prefetched.requests.map(storageRequestKey),
    );
    return {
      selection,
      input: {
        ...input,
        requests: input.requests.filter((request) => {
          return !capturedVersionKeys.has(storageRequestKey(request));
        }),
      },
      index,
    };
  });
  const capturedStorageIndex$ = computed(async (get) => {
    const { selection, input, index } = await get(capturedStorageBaseIndex$);
    return {
      selection,
      storageIndex: await withStoragePrefixVersions(
        input.db,
        input.requests,
        index,
      ),
    };
  });
  const agentRunStorageStoragePlan$ = computed(
    async (get): Promise<AgentRunStoragePlan> => {
      const { selection, storageIndex } = await get(capturedStorageIndex$);
      return await measureApiDispatchTiming(
        selection.args.timing,
        "api_dispatch_prepare_storage_manifest_resolve_plan",
        "nested",
        async () => {
          if (selection.kind === "captured") {
            return {
              requested: await resolveValidatedPersistedStorageMounts({
                ...selection.args,
                bucket: selection.bucket,
                storageIndex,
                branch: "captured",
              }),
              sessionWriteback: undefined,
              missingArtifacts: [],
            };
          }
          const missingArtifacts = selection.remainingArtifacts.filter(
            (artifact) => {
              const entry = storageIndex.get(
                storageIndexKey(
                  selection.args.runtimeOrgId,
                  selection.args.userId,
                  artifact.name,
                ),
              );
              return !entry || entry.headVersionId === null;
            },
          );
          const missingNames = new Set(
            missingArtifacts.map((artifact) => {
              return artifact.name;
            }),
          );
          const [requested, sessionWriteback] = await Promise.all([
            resolveStorageEntries(
              {
                ...selection.request.input,
                artifacts: selection.remainingArtifacts.filter((artifact) => {
                  return !missingNames.has(artifact.name);
                }),
                storageIndex,
              },
              "requested",
            ),
            selection.canonicalWritebackMounts.length === 0
              ? undefined
              : resolveSessionWritebackStorageMounts({
                  db: selection.args.db,
                  bucket: selection.bucket,
                  storageIndex,
                  mounts: selection.canonicalWritebackMounts,
                  timing: selection.args.timing,
                  stats: selection.args.stats,
                }),
          ]);
          return {
            requested: {
              ...requested,
              input: {
                ...requested.input,
                artifacts: selection.remainingArtifacts,
              },
            },
            sessionWriteback,
            missingArtifacts,
          };
        },
      );
    },
  );
  const selectedStorageMetadata$ = computed(async (get) => {
    const plan = await get(storagePlan$);
    if (isRouteError(plan)) {
      return plan;
    }
    if (plan.missingArtifacts.length > 0) {
      throw new Error(
        `Run storage must be initialized before execution: ${plan.missingArtifacts
          .map((artifact) => {
            return artifact.name;
          })
          .join(", ")}`,
      );
    }
    const entries =
      plan.sessionWriteback === undefined
        ? storageEntriesMetadata(plan.requested)
        : combinePreparedStorageEntries({
            requested: storageEntriesMetadata(plan.requested),
            sessionWriteback: storageEntriesMetadata(plan.sessionWriteback),
          });
    const metadata = await finalizePreparedStorage({ entries });
    return { plan, entries, metadata };
  });
  const executionStorageObjects$ = computed(async (get) => {
    const selected = await get(selectedStorageMetadata$);
    if (isRouteError(selected)) {
      return selected;
    }
    const mounts = selected.metadata.storageMounts.map(
      (mount): ExecutionStorageRequest => {
        const identity = {
          orgId: mount.orgId,
          userId: mount.userId,
          storageId: mount.storageId,
          versionId: mount.versionId,
          name: mount.name,
          mountPath: mount.mountPath,
        };
        return mount.writeback
          ? {
              ...identity,
              mode: "writeback",
              missingRootPolicy: mount.missingRootPolicy ?? "fail",
            }
          : {
              ...identity,
              mode: "readonly",
              ...(mount.instructionsTargetFilename === undefined
                ? {}
                : {
                    instructionsTargetFilename:
                      mount.instructionsTargetFilename,
                  }),
            };
      },
    );
    const storageIndex = mergeStorageIndexes(
      selected.plan.requested.input.storageIndex,
      selected.plan.sessionWriteback?.input.storageIndex ?? new Map(),
    );
    const cache = await get((await get(executionContext$)).storageCache$);
    const versions = exactStorageVersionsFromIndex(mounts, storageIndex);
    const rows = [
      ...cache.rows,
      ...[...storageIndex.values()].flatMap((entry) => {
        return entry.cachedUrls ?? [];
      }),
    ];
    return {
      mounts,
      objects: createResolvedExecutionStorageObjects(mounts, versions, rows),
    };
  });
  const preparedStorage$ = computed(
    async (
      get,
    ): Promise<MaterializedAgentRunStorage | CreateRunErrorResult | null> => {
      if (!(await get(resourceAllowed$))) {
        return null;
      }
      const [selected, storage] = await Promise.all([
        get(selectedStorageMetadata$),
        get(executionStorageObjects$),
      ]);
      if (isRouteError(selected)) {
        return selected;
      }
      if (isRouteError(storage)) {
        return storage;
      }
      const mounts = await measureApiDispatchTiming(
        selected.plan.requested.input.timing,
        "api_dispatch_prepare_storage_manifest_generate_compose_urls",
        "nested",
        () => {
          return get(storage.objects.preparedMounts$);
        },
        { storage_manifest_signing_owner: "execution_storage" },
      );
      const byPath = new Map(
        mounts.map((mount) => {
          return [mount.mountPath, mount];
        }),
      );
      const attach = (
        mount: MaterializedAgentRunStorage["resolved"]["metadata"]["storageMounts"][number],
      ) => {
        const prepared = byPath.get(mount.mountPath);
        if (!prepared) {
          throw new Error("Selected storage mount has no prepared result");
        }
        return storedMountFromPrepared(
          prepared,
          mount.missingRootPolicy !== undefined,
        );
      };
      const entries = {
        ...selected.entries,
        composeEntries: selected.entries.composeEntries.map((entry) => {
          return {
            ...entry,
            storedMount: attach(entry.storedMount),
          };
        }),
        additionalEntries: selected.entries.additionalEntries.map((entry) => {
          return {
            ...entry,
            storedMount: attach(entry.storedMount),
          };
        }),
        writebackEntries: selected.entries.writebackEntries.map((entry) => {
          return {
            ...entry,
            storedMount: attach(entry.storedMount),
          };
        }),
      };
      const prepared = await finalizePreparedStorage({
        entries,
        timing: selected.plan.requested.input.timing,
        stats: selected.plan.requested.input.stats,
      });
      return {
        resolved: {
          metadata: selected.metadata,
          requested: selected.plan.requested,
          sessionWriteback: selected.plan.sessionWriteback,
        },
        prepared,
      };
    },
  );
  const updatePresignedUrlCache$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const storage = await get(executionStorageObjects$);
      signal.throwIfAborted();
      if (isRouteError(storage)) {
        throw new Error(
          "Committed execution is missing its storage preparation",
        );
      }
      const prepared = await get(storage.objects.preparedMounts$);
      signal.throwIfAborted();
      await set(
        updateExecutionStoragePresignedUrlCache$,
        storage.mounts,
        prepared,
        signal,
      );
    },
  );
  const storagePlan$ = computed(async (get) => {
    const input = await get(capturedSelectedStorageInput$);
    return isRouteError(input) ? input : get(agentRunStorageStoragePlan$);
  });
  const {
    runArgs$: selectedRunContextRunArgs$,
    shared: selectedRunContextShared,
  } = graph;
  const contextInput$ = computed(async (get) => {
    const selected = await get(selectedRunContextRunArgs$);
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
  });
  const execution$ = computed(async (get) => {
    // Agent/session resolution has no dependency on connector firewall policies
    // or the completed runner body. Use the already-authorized identity and
    // canonical session snapshot directly, as buildProductRunArgs does.
    const [{ command, timing }, agent, session] = await Promise.all([
      get(preCreateInput$),
      get(preCreateAgentAgent$),
      get(threadSession$),
    ]);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return await resolveProductAgentExecution(
      {
        agentId: agent.id,
        ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
      },
      command.owner.userId,
      command.owner.orgId,
      {
        instructionsStorageName: getInstructionsStorageName(agent.name),
        preloadedAgentExecutionObservation: {
          requestUserId: command.owner.userId,
          requestOrgId: command.owner.orgId,
          agentId: agent.id,
          ownerUserId: agent.owner,
          agentOrgId: agent.orgId,
        },
        resetNativeSession: session?.resetNativeSession,
        sessionSnapshot: session?.executionSnapshot,
        timing,
      },
    );
  });
  const body$ = computed(async (get) => {
    const [input, resolved, persistedEnvironment, resolvedEnvironment] =
      await Promise.all([
        get(contextInput$),
        get(execution$),
        get(runEnvironmentSnapshot$),
        selectedRunContextShared
          ? get(selectedRunContextShared.bodyEnvironment$)
          : undefined,
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
    return buildResolvedRunBody({
      initialBody: initialRunBody(input.args),
      persistedEnvironment,
      canonicalOkouRuntime: input.args.includeOkouTokenSecret === true,
      resolvedEnvironment,
    });
  });
  const runBodyBodyContext$ = computed(async (get) => {
    const [input, resolved, body, requestedFramework, featureSwitchContext] =
      await Promise.all([
        get(contextInput$),
        get(execution$),
        get(body$),
        get(runFramework$),
        get(preCreateModelFeatureSwitchContext$),
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
  });
  const body = { bodyContext$: runBodyBodyContext$, framework$: runFramework$ };
  const { connectorContext$: runRuntimeConnectorContext$ } =
    selectedRunContextShared;
  const runRuntimeRuntimeContext$ = computed(async (get) => {
    const [
      bodyResult,
      modelResult,
      selectionResult,
      snapshotResult,
      connectorResult,
    ] = await Promise.all([
      get(runBodyBodyContext$),
      get(modelRoute$),
      get(connectorSelection$),
      get(connectorSnapshot$),
      get(runRuntimeConnectorContext$),
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
    const catalog = await get(claimCatalog$);
    const usage = prepareModelUsageContext({
      catalog,
      modelProvider,
      permissionManifest: connectors.permissionManifest,
      routePricing: runRoutePricingFromSnapshot(
        {
          modelProvider,
          serviceTier: (await get(contextInput$)).args.codexServiceTier,
          resolution: get(usagePricingResolution$),
        },
        await get((await get(executionContext$)).modelPricing$),
      ),
    });
    if ("kind" in usage) {
      return providerUnavailable(usage.message);
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
  });
  const runContextRuntime = { runtimeContext$: runRuntimeRuntimeContext$ };
  const runContextUserTimezone$ = computed(async (get) => {
    return selectedRunContextShared
      ? get(selectedRunContextShared.userTimezone$)
      : ((await get(runMemberSnapshot$)).member?.timezone ?? undefined);
  });
  const imageModel$ = computed(async (get) => {
    return get((await get(executionContext$)).selectedImageModel$);
  });
  const disabledPaidTools$ = computed(async (get) => {
    return (await get(selectedRunContextShared.disabledPaidTools$)).toolIds;
  });
  const { officialWorkflow$: runContextOfficialWorkflow$ } =
    selectedRunContextShared;
  const { bodyContext$ } = body;
  const { runtimeContext$ } = runContextRuntime;
  const executionPlan$ = computed(async (get) => {
    const { args } = await get(contextInput$);
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
      get(runContextUserTimezone$),
      get(imageModel$),
      get(runContextOfficialWorkflow$),
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
    const { body } = bodyContext;
    const { modelProvider, framework } = runtimeContext;
    const piSandbox = resolvePreparedPiModelConfig({
      input: piModelPreparationInput(args),
      modelProvider,
    });
    const resolved = resolveCompatibleDirectResumeSession({
      resolved: bodyContext.resolved,
      next: {
        selectedModel: modelProvider?.selectedModel ?? null,
        cliAgentType: piSandbox ? "pi" : framework,
      },
    });
    const validation = validateRunEnvironmentReferences({
      body,
      modelProvider,
      connectorContext: runtimeContext.connectorContext,
      customConnectorContext: runtimeContext.customConnectorContext,
      permissionManifest: runtimeContext.permissionManifest,
      validateEnvironmentReferences: args.validateEnvironmentReferences,
    });
    if (validation) {
      return validation;
    }
    const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
    if (isRouteError(promptAndSkills)) {
      return promptAndSkills;
    }
    const metadata = prepareRunOutputMetadata({
      skillVolumes: promptAndSkills.skillVolumes,
      officialWorkflow: officialWorkflowRun,
      framework,
      piSandbox,
      body,
      resolved,
    });
    return {
      disabledPaidTools,
      body,
      resolved,
      framework,
      piSandbox,
      modelProvider,
      connectorContext: runtimeContext.connectorContext,
      customConnectorContext: runtimeContext.customConnectorContext,
      permissionManifest: runtimeContext.permissionManifest,
      billableFirewalls: runtimeContext.billableFirewalls,
      modelUsageProvider: runtimeContext.modelUsageProvider,
      modelUsageLongContextMinTotalInputTokens:
        runtimeContext.modelUsageLongContextMinTotalInputTokens,
      ...metadata,
      officialWorkflowFacts: await get(
        selectedRunContextShared.officialWorkflowFacts$,
      ),
      userTimezone,
      featureSwitchContext: bodyContext.featureSwitchContext,
      selectedImageModel,
    };
  });
  const preparedRunPlan$ = computed(async (get) => {
    const selected = await get(selectedRunContextRunArgs$);
    if (!selected || "status" in selected) {
      return selected;
    }
    return get(executionPlan$);
  });
  const authorizeSelectedAgentRun$ = computed(async (get) => {
    const [{ command: args }, agent] = await Promise.all([
      get(selectedIdentityInputIdentityInput$),
      get(preCreateAgentAgent$),
    ]);
    if (!agent || agent.orgId !== args.owner.orgId) {
      return notFound("Agent not found");
    }
    if (agent.visibility === "private" && agent.owner !== args.owner.userId) {
      return agentRunsCreateForbidden(
        "Only the private agent owner can run this agent",
      );
    }
    return undefined;
  });
  const runAdmissionCheckCheckAdmission$ = command(
    async ({ get }, input: RunAdmissionInput, signal: AbortSignal) => {
      signal.throwIfAborted();
      const identity = await get(queuedIdentityContext$);
      signal.throwIfAborted();
      const [models, memberModels] = await Promise.all([
        get(identity.modelFacts$),
        get(identity.memberModels$),
      ]);
      signal.throwIfAborted();
      const personalSubscription = isMemberSubscriptionRoute({
        catalog: input.catalog,
        member: memberModels.member,
        model: input.selectedModel,
        providerType: input.modelProviderType,
      });
      if (!input.enforceBuiltInCredits) {
        return (
          checkOrgPlanRunAdmission({
            ...input,
            capabilities: models.capabilities,
            personalSubscription,
          }) ?? null
        );
      }
      const balance = await get(identity.credits$);
      signal.throwIfAborted();
      const capabilities = models.capabilities;
      const availability =
        capabilities && balance ? { ...capabilities, ...balance } : null;
      const routeFailure = checkCatalogRunRoute(input.catalog, input);
      if (routeFailure) {
        return routeFailure;
      }
      if (!availability) {
        return insufficientCredits();
      }
      const failure = checkOrgPlanRunAdmission({
        ...input,
        capabilities: availability,
        personalSubscription,
      });
      if (failure) {
        return failure;
      }
      if (
        !isBuiltInModelProviderType(input.modelProviderType) ||
        availability.usagePackCredits > 0 ||
        availability.spendableCredits > 0
      ) {
        return null;
      }
      return insufficientCredits();
    },
  );

  const checkAdmission$ = runAdmissionCheckCheckAdmission$;
  const directSendInsufficientCreditsMessage$ = computed(async (get) => {
    const capabilities = await get(context.plan$);
    const appUrl = env("APP_URL");
    return [
      "Insufficient credits. This workspace has no spendable credits right now.",
      "",
      capabilities?.canBuyCredits === true
        ? `Buy more credits or adjust auto-recharge: ${appUrl}/?settings=usage`
        : `Upgrade to Pro to get more credits: ${appUrl}/?settings=billing&billingView=plans`,
    ].join("\n");
  });

  /**
   * The one rejection of a picked queue head, for business rejections and
   * unexpected preparation or commit failures alike: record the rejected input
   * and its error message, settle an automation tick, publish the realtime
   * event and deliver the failure to the source integration. With `lease`, the
   * rejection and the release of that lease commit together, and only while
   * the claim still holds it; otherwise the transaction rolls back and nothing
   * changes. The queue row is locked last, as enqueue does.
   */
  const rejectionInput$ = command(
    async ({ get }, head: RejectedQueueHead, signal: AbortSignal) => {
      const [source] = await get(db$)
        .select({
          id: chatEvents.id,
          chatThreadId: chatEvents.chatThreadId,
          eventType: chatEvents.eventType,
          userMessage: canonicalChatEventUserMessage(),
          createdAt: chatEvents.createdAt,
          contextType: chatEvents.contextType,
          contextId: chatEvents.contextId,
          modelSelection: canonicalChatInputModelSelection(),
        })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.id, head.id),
            eq(chatEvents.chatThreadId, head.chatThreadId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!source?.userMessage) {
        throw new Error("Queued input event is missing userMessage");
      }
      return { ...source, userMessage: source.userMessage };
    },
  );

  const commitQueueHeadRejection$ = command(
    async (
      { set },
      args: {
        readonly head: RejectedQueueHead;
        readonly errorMarker: string;
        readonly displayError: string;
        readonly lease?: ThreadClaim;
      },
      signal: AbortSignal,
    ) => {
      const source = await set(rejectionInput$, args.head, signal);
      const rejectedAt = new Date(
        Math.max(nowDate().getTime(), source.createdAt.getTime() + 1),
      );
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0261; new non-billing transactions are prohibited.
      return await set(writeDb$).transaction(async (tx) => {
        const rejected =
          parseRawRows(
            chatEventCommandResultSchema,
            await tx.execute(
              chatEventReplacementInsertSql(source, {
                chatThreadId: source.chatThreadId,
                eventType: "input.rejected",
                userMessage: source.userMessage,
                runId: null,
                error: args.errorMarker,
                createdAt: rejectedAt,
              }),
            ),
          )[0] ?? null;
        signal.throwIfAborted();
        let appended: {
          readonly assistantEventId: string;
          readonly contextType: string | null;
          readonly contextId: string | null;
        } | null = null;
        if (rejected) {
          const assistant =
            parseRawRows(
              chatEventCommandResultSchema,
              await tx.execute(
                chatEventInsertSql({
                  chatThreadId: source.chatThreadId,
                  eventType: "output.error",
                  content: args.displayError,
                  runId: null,
                  error: args.errorMarker,
                  createdAt: new Date(rejectedAt.getTime() + 1),
                }),
              ),
            )[0] ?? null;
          signal.throwIfAborted();
          if (!assistant) {
            throw new Error("Failed to append queued input rejection");
          }
          const [thread] = await tx
            .update(chatThreads)
            .set({
              lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${assistant.createdAt.toISOString()}::timestamp)`,
            })
            .where(
              and(
                eq(chatThreads.id, source.chatThreadId),
                isNotNull(chatThreads.agentId),
              ),
            )
            .returning({
              id: chatThreads.id,
              userId: chatThreads.userId,
              agentId: chatThreads.agentId,
              lastMessageAt: chatThreads.lastMessageAt,
            });
          signal.throwIfAborted();
          if (thread?.agentId) {
            await tx.execute(
              chatThreadEventInsertSql({
                kind: "sort_touched",
                userId: thread.userId,
                chatThreadId: thread.id,
                agentId: thread.agentId,
                createdAt: thread.lastMessageAt,
              }),
            );
            signal.throwIfAborted();
          }
          appended = {
            assistantEventId: assistant.id,
            contextType: source.contextType,
            contextId: source.contextId,
          };
        }
        if (args.lease) {
          const { lease } = args;
          const [released] = await tx
            .update(queuedChatThreads)
            .set({ claimId: null, claimExpiresAt: null })
            .where(
              and(
                eq(queuedChatThreads.orgId, lease.orgId),
                eq(queuedChatThreads.chatThreadId, lease.chatThreadId),
                eq(queuedChatThreads.claimId, lease.claimId),
              ),
            )
            .returning({ chatThreadId: queuedChatThreads.chatThreadId });
          signal.throwIfAborted();
          if (!released) {
            tx.rollback();
          }
        }
        return appended;
      });
    },
  );

  const rejectChatQueueHead$ = command(
    async (
      { get, set },
      args: {
        readonly head: RejectedQueueHead;
        readonly rejection: ChatQueueHeadRejection;
        readonly lease?: ThreadClaim;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      const { head, rejection, lease } = args;
      const { error } = rejection;
      const displayError =
        error.code === "CONFLICT"
          ? error.message
          : error.code === "INSUFFICIENT_CREDITS" &&
              isDirectSendContext(head.contextType)
            ? await get(directSendInsufficientCreditsMessage$)
            : await set(
                formatIntegrationRunError$,
                {
                  orgId: head.orgId,
                  userId: rejection.userId,
                  code: error.code,
                  message: error.message,
                },
                signal,
              );
      signal.throwIfAborted();
      const rejected = await set(
        commitQueueHeadRejection$,
        { head, errorMarker: error.code.toLowerCase(), displayError, lease },
        signal,
      );
      signal.throwIfAborted();
      if (!rejected) {
        return;
      }
      // Business rejections already have durable input.rejected/output.error
      // events. Only internal failures need an additional operational warning.
      if (
        error.code === "INTERNAL_ERROR" ||
        error.code === "INTERNAL_SERVER_ERROR"
      ) {
        log.warn("Rejected queued chat input", {
          chatThreadId: head.chatThreadId,
          eventId: head.id,
          contextType: head.contextType,
          code: error.code,
          error: error.message,
        });
      }
      if (head.contextType === "automation") {
        await set(
          settleRejectedAutomationInput$,
          { contextId: head.contextId, queueEventId: head.id, error },
          signal,
        );
      }
      await set(publishChatQueueHeadConsumed$, head, signal);
      const agentId = head.agentId;
      const delivery = rejection.delivery
        ? set(
            deliverQueuedPromptRejection$,
            rejection.delivery,
            rejected.assistantEventId,
            signal,
          )
        : error.code === "INTERNAL_ERROR" && agentId !== null
          ? set(
              deliverUnexpectedQueuedPromptRejection$,
              {
                head: { ...head, agentId },
                assistantEventId: rejected.assistantEventId,
              },
              signal,
            )
          : undefined;
      if (delivery) {
        await tapError(delivery, (deliveryError) => {
          log.warn("Failed to deliver queued input rejection", {
            chatThreadId: head.chatThreadId,
            eventId: head.id,
            error: deliveryError,
          });
        });
      }
    },
  );

  const preparePiLaunchResourcesInput$ = computed(async (get) => {
    const [args, storage] = await Promise.all([
      get(runnerArgs$),
      get(preparedStorage$),
    ]);
    if (!args || isRouteError(args) || !storage || isRouteError(storage)) {
      return null;
    }
    return {
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
      storagePlan: Promise.resolve(storage.resolved),
      piSandbox: args.piSandbox,
      chatThreadId: args.chatThreadId,
      piLaunchConfig: args.piLaunchConfig,
      timing: args.timing,
    } satisfies PreparePiLaunchResourcesArgs;
  });
  const capturedPiMemoryRecallSelection$ = computed(async (get) => {
    const args = await get(preparePiLaunchResourcesInput$);
    if (!args || args.piSandbox === undefined) {
      return { kind: "unavailable" as const };
    }
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
      };
    }
    return {
      kind: "projection" as const,
      identity,
      input: {
        args: { orgId: args.orgId, userId: args.userId, ...identity },
      } satisfies MemorySummaryProjectionReadInput,
    };
  });
  const projectionInput$ = computed(
    async (get): Promise<MemorySummaryProjectionReadInput | undefined> => {
      const selection = await get(capturedPiMemoryRecallSelection$);
      return selection.kind === "projection" ? selection.input : undefined;
    },
  );
  const memorySummaryProjectionRead$ = computed(
    async (get): Promise<MemorySummaryProjectionReadResult | null> => {
      const input = await get(projectionInput$);
      if (!input) {
        return null;
      }
      const { args } = input;
      const db = get(db$);
      const [row] = await db
        .select({
          storageId: storages.id,
          storageOrgId: storages.orgId,
          storageUserId: storages.userId,
          storageName: storages.name,
          projectionStatus: memorySummaryProjections.status,
          content: memorySummaryProjections.content,
          sourceHash: memorySummaryProjections.sourceHash,
          sourceSize: memorySummaryProjections.sourceSize,
          tokenCount: memorySummaryProjections.tokenCount,
        })
        .from(storages)
        .innerJoin(
          storageVersions,
          and(
            eq(storageVersions.storageId, storages.id),
            eq(storageVersions.id, args.storageVersionId),
          ),
        )
        .leftJoin(
          memorySummaryProjections,
          and(
            eq(memorySummaryProjections.memoryStorageId, storages.id),
            eq(memorySummaryProjections.storageVersionId, storageVersions.id),
            eq(memorySummaryProjections.orgId, args.orgId),
            eq(memorySummaryProjections.userId, args.userId),
          ),
        )
        .where(
          and(
            eq(storages.id, args.memoryStorageId),
            eq(storages.orgId, args.orgId),
            eq(storages.userId, args.userId),
            eq(storages.name, MEMORY_ARTIFACT_NAME),
            ne(storages.userId, VOLUME_ORG_USER_ID),
          ),
        )
        .limit(1);
      return memorySummaryProjectionReadResult(input, row);
    },
  );
  const piMemoryRecallProjection$ = memorySummaryProjectionRead$;
  const piMemoryRecall$ = computed(
    async (get): Promise<PiMemoryRecallSelection | undefined> => {
      const selection = await get(capturedPiMemoryRecallSelection$);
      if (selection.kind === "unavailable") {
        return undefined;
      }
      if (selection.kind === "captured") {
        return selection.recall;
      }
      const projection = await get(piMemoryRecallProjection$);
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
  const piLaunchResources$ = computed(
    async (get): Promise<PreparedPiLaunchResources | undefined> => {
      const [args, memoryRecall] = await Promise.all([
        get(preparePiLaunchResourcesInput$),
        get(piMemoryRecall$),
      ]);
      if (!args || args.piSandbox === undefined) {
        return undefined;
      }
      const piSandbox = args.piSandbox;
      return measureApiDispatchTiming(
        args.timing,
        "api_dispatch_prepare_pi_launch_resources",
        "nested",
        () => {
          return Promise.resolve(
            assemblePiLaunchResources({
              modelConfig: piSandbox,
              piLaunchConfig: args.piLaunchConfig,
              memoryRecall,
              resumeSession:
                args.chatThreadId === undefined
                  ? undefined
                  : args.resumeSession,
              sessionId: args.chatThreadId ?? args.runId,
            }),
          );
        },
      );
    },
  );
  const runIdentity$ = computed(async (get) => {
    const ids = get(runIds$);
    if (!(await get(selectionInput$))) {
      return null;
    }
    const session = await get(threadSession$);
    return {
      runId: ids.runId,
      sessionId: session?.sessionId ?? ids.newSessionId,
      shouldCreateSession: !session?.sessionId,
    };
  });
  const runPlan$ = computed(
    async (get): Promise<RunPlan | CreateRunErrorResult | null> => {
      if (!(await get(selectionInput$))) {
        return null;
      }
      const [selected, context, storagePlan] = await Promise.all([
        get(preCreateRunArgsRunArgs$),
        get(preparedRunPlan$),
        get(storagePlan$),
        // Start session-based execution alongside firewall/body assembly,
        // rather than only after the completed create arguments are available.
        get(execution$),
      ]);
      if (!selected || isRouteError(selected)) {
        return selected;
      }
      if (!context) {
        return context;
      }
      if ("status" in context) {
        return context;
      }
      if (isRouteError(storagePlan)) {
        return storagePlan;
      }
      const { args, timing } = await get(contextInput$);
      const launchSnapshot = {
        schemaVersion: 3 as const,
        framework:
          context.piSandbox === undefined ? context.framework : ("pi" as const),
        runnerProfile: DEFAULT_PROFILE,
      };
      const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
      if (isRouteError(promptAndSkills)) {
        return promptAndSkills;
      }
      const body = {
        ...context.body,
        prompt: promptAndSkills.userPrompt,
        appendSystemPrompt: promptAndSkills.appendedSystemPrompt,
      };
      const {
        officialWorkflowRun,
        officialWorkflowFacts,
        selectedImageModel,
        ...facts
      } = context;
      const modelProvider = context.modelProvider;
      return {
        args,
        timing,
        enforceBuiltInCredits:
          args.enforceBuiltInCredits === true &&
          isBuiltInModelProviderType(modelProvider?.type),
        officialWorkflowRun,
        persisted: {
          body,
          selectedImageModel,
          launchSnapshot,
          officialWorkflowRun,
          officialWorkflowFacts,
          resolved: {
            agentId: context.resolved.agentId,
            continuedFromAgentSessionId:
              context.resolved.continuedFromAgentSessionId,
          },
          modelProvider: modelProvider
            ? {
                credentialOwner: modelProvider.credentialOwner,
                id: modelProvider.id,
                type: modelProvider.type,
                selectedModel: modelProvider.selectedModel,
                builtInModelRuntimeRoute:
                  modelProvider.builtInModelRuntimeRoute,
              }
            : null,
        },
        runner: {
          ...facts,
          body,
          launchSnapshot,
          userId: args.userId,
          orgId: args.orgId,
          apiStartTime: args.apiStartTime,
          includeOkouTokenSecret: args.includeOkouTokenSecret,
          okouTokenComputerUseHostId: args.okouTokenComputerUseHostId,
          okouTokenCloudBrowserEnabled: args.okouTokenCloudBrowserEnabled,
          chatThreadId: args.chatThreadId,
          platformEnvironment: args.platformEnvironment,
          // Thread launches carry no producer Pi launch options or
          // artifact root-policy override.
          piLaunchConfig: undefined,
          artifactMissingRootPolicy: undefined,
        },
      };
    },
  );
  // Resource reads do not wait for credit admission: its failure is checked
  // with the prepared resources before anything is committed.
  const resourceAllowed$ = computed(async (get) => {
    const [selection, validSource] = await Promise.all([
      get(selectionInput$),
      (await get(isAutomation$)) ? true : get(resourceValidation$),
    ]);
    return !!selection && validSource;
  });
  /** Launch payload arguments without the run token; a pure read join. */
  const runnerArgs$ = computed(async (get) => {
    const [input, identity, allowed] = await Promise.all([
      get(runPlan$),
      get(runIdentity$),
      get(resourceAllowed$),
    ]);
    if (!allowed) {
      return null;
    }
    if (!input || isRouteError(input)) {
      return input;
    }
    if (!identity) {
      throw new Error("Selected claim has no run identity");
    }
    return {
      ...input.runner,
      run: {
        id: identity.runId,
        sessionId: identity.sessionId,
        shouldCreateSession: identity.shouldCreateSession,
      },
      timing: input.timing,
    };
  });
  /** The run token makes runner input a command; its result is passed on. */
  const prepareRunnerInput$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const args = await get(runnerArgs$);
      signal.throwIfAborted();
      if (!args || isRouteError(args)) {
        return args;
      }
      return prepareRunnerStorageInput({
        db: set(writeDb$),
        args,
        storageManifestStats: new StorageManifestBuildStats(),
      });
    },
  );
  const prepareCallbacks$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const identity = get(runIds$);
      const [callbacks, { command }] = await Promise.all([
        get(callbackInputs$),
        get(selectedIdentityInputIdentityInput$),
      ]);
      signal.throwIfAborted();
      const definitions = (callbacks ?? []).map(
        (callback): ExecutionCallback => {
          // Keep the JSON serialization previously performed by callback JSONB
          // persistence (optional fields omitted, Date values serialized).
          const serializedPayload = JSON.stringify(callback.payload);
          const payload =
            serializedPayload === undefined
              ? null
              : z.json().parse(JSON.parse(serializedPayload) as unknown);
          return "internalKind" in callback
            ? { kind: "internal", internalKind: callback.internalKind, payload }
            : {
                kind: "http",
                url: callback.url,
                secret: callback.secret,
                payload,
              };
        },
      );
      const prepared = await set(
        prepareExecutionCallbacks$,
        { orgId: command.owner.orgId, userId: command.owner.userId },
        definitions,
        signal,
      );
      return prepared.map((callback) => {
        return callback.kind === "internal"
          ? {
              runId: identity.runId,
              url: null,
              internalKind: callback.internalKind,
              encryptedSecret: null,
              payload: callback.payload,
            }
          : {
              runId: identity.runId,
              url: callback.url,
              internalKind: null,
              encryptedSecret: callback.encryptedSecret,
              payload: callback.payload,
            };
      });
    },
  );
  const storageMounts$ = computed((get) => {
    return get(preparedStorage$);
  });
  const prepareRunnerStorage$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await set(preloadEagerCredentials$, signal);
      const [input, preparedStorage, piResources] = await Promise.all([
        set(prepareRunnerInput$, signal),
        get(preparedStorage$),
        get(piLaunchResources$),
      ]);
      signal.throwIfAborted();
      if (!input || isRouteError(input)) {
        return input;
      }
      if (!preparedStorage || isRouteError(preparedStorage)) {
        return preparedStorage;
      }
      return { input, preparedStorage, piResources };
    },
  );
  const storedSecretsInput$ = computed(async (get) => {
    if (!(await get(selectionInput$))) {
      return null;
    }
    const [environment, connectors, model, snapshot] = await Promise.all([
      get(preCreateBodyEnvironmentEnvironment$),
      get(connectorContext$),
      get(modelRoute$),
      get(connectorSnapshot$),
    ]);
    if (isRouteError(environment)) {
      return environment;
    }
    if (isRouteError(connectors)) {
      return connectors;
    }
    if (isRouteError(model)) {
      return model;
    }
    if (isRouteError(snapshot)) {
      return snapshot;
    }
    return {
      secrets: buildStoredExecutionSecrets({
        connectorContext: connectors.connectorContext,
        modelProvider: model,
        bodySecrets: environment.secrets,
        customConnectorContext: snapshot.customConnectorContext,
      }).secrets,
    };
  });
  const prepareEncryptedSecrets$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await set(preloadEagerCredentials$, signal);
      const input = await get(storedSecretsInput$);
      signal.throwIfAborted();
      if (!input || isRouteError(input)) {
        return input;
      }
      const { observation } = await get(
        (await get(eagerCredentialContext$)).credentials$,
      );
      signal.throwIfAborted();
      const plan = await get(runConnectorEagerSecretPlan$);
      signal.throwIfAborted();
      // One owned consumer records the original completed intervals, never preload.
      if (observation && !isRouteError(plan)) {
        bestEffortTelemetry(() => {
          const dimensions = {
            ...plan.timingDimensions,
            connector_context_schema: "selected_eager_v1",
            connector_context_builtin_decrypt_count:
              observation.builtinDecryptCount,
            connector_context_observation:
              observation.builtinResolve && observation.builtinDecrypt
                ? "complete"
                : "partial",
            connector_context_builtin_decrypt_count_bucket: countBucket(
              observation.builtinDecryptCount,
            ),
          };
          for (const [actionType, duration] of [
            [
              "api_dispatch_prepare_context_connector_context_builtin_resolve",
              observation.builtinResolve,
            ],
            [
              "api_dispatch_prepare_context_connector_context_builtin_decrypt",
              observation.builtinDecrypt,
            ],
          ] as const) {
            if (duration) {
              plan.input.timing.recordDuration(
                actionType,
                "nested",
                duration.durationMs,
                duration.finishedAt,
                dimensions,
              );
            }
          }
        });
      }
      const encryptedSecrets = await set(
        encryptExecutionSecrets$,
        input.secrets ?? null,
        signal,
      );
      signal.throwIfAborted();
      return { encryptedSecrets };
    },
  );
  const checkClaimAdmission$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!(await get(selectionInput$))) {
        signal.throwIfAborted();
        return undefined;
      }
      const [input, model] = await Promise.all([
        get(preCreateInput$),
        get(modelRoute$),
      ]);
      signal.throwIfAborted();
      if (isRouteError(model)) {
        if (
          model.body.error.code === "PROVIDER_UNAVAILABLE" &&
          isBuiltInModelProviderType(input.command.body.modelProvider)
        ) {
          const credits = await set(
            checkAdmission$,
            {
              catalog: await get(claimCatalog$),
              orgId: claim.orgId,
              userId: input.command.owner.userId,
              modelProviderType: "built-in",
              selectedModel: input.command.selectedModelOverride,
              enforceBuiltInCredits: true,
            },
            signal,
          );
          if (credits) {
            return credits;
          }
        }
        return model;
      }
      return await set(
        checkAdmission$,
        {
          catalog: await get(claimCatalog$),
          orgId: claim.orgId,
          userId: input.command.owner.userId,
          modelProviderType: model?.type ?? input.command.body.modelProvider,
          selectedModel:
            model?.selectedModel ?? input.command.selectedModelOverride,
          enforceBuiltInCredits: isBuiltInModelProviderType(model?.type),
        },
        signal,
      );
    },
  );
  const authorizeIdentity$ = computed(async (get) => {
    const identityInput = await get(identityInput$);
    if (!identityInput) {
      return { identityInput, authorization: undefined };
    }
    return {
      identityInput,
      authorization: await get(authorizeSelectedAgentRun$),
    };
  });
  const authorizeClaimIdentity$ = command(
    async ({ get }, signal: AbortSignal) => {
      const authorized = await get(authorizeIdentity$);
      signal.throwIfAborted();
      return authorized;
    },
  );
  const initializeRunPreparation$ = command(
    async ({ get, set }, timing: ClaimRunTiming, signal: AbortSignal) => {
      signal.throwIfAborted();
      const head = await get(head$);
      signal.throwIfAborted();
      if (!head) {
        return null;
      }
      if (head.contextType === "automation") {
        await set(initializeAutomationExecution$, head, timing.run, signal);
      } else {
        await set(initializeQueuedPrompt$, head, signal);
      }
      signal.throwIfAborted();
      const { identityInput, authorization } = await set(
        authorizeClaimIdentity$,
        signal,
      );
      signal.throwIfAborted();
      if (!identityInput) {
        const assembly =
          head.contextType === "automation"
            ? await get(queuedAutomationAssemblerInternalEarlyAssembly$)
            : await get(assembly$);
        signal.throwIfAborted();
        await set(
          rejectChatQueueHead$,
          {
            head,
            rejection:
              assembly?.kind === "rejected"
                ? assembly.rejection
                : unreadyQueueHeadRejection(head),
          },
          signal,
        );
        return null;
      }
      if (authorization) {
        const rejection =
          head.contextType === "automation"
            ? {
                userId: identityInput.owner.userId,
                error: authorization.body.error,
              }
            : claimAssemblyRejection(
                await get(assembly$),
                head,
                authorization.body.error,
              );
        signal.throwIfAborted();
        await set(rejectChatQueueHead$, { head, rejection }, signal);
        return null;
      }
      return head;
    },
  );
  /** Runner input owns the random token; storage then reads its result. */
  const prepareRunnerResources$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const [plan, storage] = await Promise.all([
        get(runPlan$),
        set(prepareRunnerStorage$, signal),
      ]);
      signal.throwIfAborted();
      const runnerInput: RunnerInputResult =
        storage && !isRouteError(storage) ? storage.input : storage;
      return [plan, storage, runnerInput] as const;
    },
  );
  /**
   * Automation launch arguments are the only write-derived input of these
   * reads; Web input starts them at once.
   */
  const prepareLaunchResources$ = command(
    async ({ get, set }, head: ChatQueueHeadContext, signal: AbortSignal) => {
      let rewardArgs: AssembleWorkflowAutomationRunArgs | null = null;
      if (head.contextType === "automation") {
        const launch = await set(
          initializeQueuedAutomationInitializeQueuedAutomation$,
          head,
          signal,
        );
        signal.throwIfAborted();
        if (launch.kind === "rejected") {
          // The automation input was rejected from its captured reads;
          // no launch read can change that, so none starts.
          return { kind: "rejected" as const, assembly: launch.assembly };
        }
        rewardArgs = await set(
          initializeWorkflowAutomationRun$,
          launch.args,
          signal,
        );
        signal.throwIfAborted();
      }
      const [runner, , callbackRows, assembly, identity] = await Promise.all([
        set(prepareRunnerResources$, signal),
        rewardArgs
          ? set(recordQueuedWorkflowReward$, rewardArgs, signal)
          : undefined,
        set(prepareCallbacks$, signal),
        get(assembly$),
        get(runIdentity$),
        get(runMemberSnapshot$),
        get(runDisabledPaidToolsSnapshot$),
        get(runEnvironmentSnapshot$),
      ]);
      signal.throwIfAborted();
      return {
        kind: "prepared" as const,
        runner,
        callbackRows,
        assembly,
        identity,
      };
    },
  );
  const prepareClaimResources$ = command(
    async ({ get, set }, head: ChatQueueHeadContext, signal: AbortSignal) => {
      if (head.contextType === "automation") {
        await set(resolveAutomationModelSnapshot$, signal);
        signal.throwIfAborted();
      }
      // Storage mounts and runtime-secret KMS are independent of automation
      // launch material, so they start before launch preparation.
      const [encrypted, admission, launch] = await Promise.all([
        set(prepareEncryptedSecrets$, signal),
        set(checkClaimAdmission$, signal),
        set(prepareLaunchResources$, head, signal),
        get(storageMounts$),
        // Connector reads start independently of prompt/model material. A
        // prefetch miss joins the same loader once for this selected identity.
        get((await get(executionContext$)).connectors$),
        get(connectedAccounts.threadSelections$),
      ]);
      signal.throwIfAborted();
      if (launch.kind === "rejected") {
        return { kind: "rejected" as const, assembly: launch.assembly };
      }
      const [input, storage, runnerInput] = launch.runner;
      const contextDraft = claimRunStoredContextDraft(runnerInput, encrypted);
      return {
        kind: "prepared" as const,
        resources: [
          input,
          storage,
          launch.callbackRows,
          contextDraft,
          launch.assembly,
          launch.identity,
          admission,
        ] as const,
      };
    },
  );
  /**
   * An unresolvable Official Workflow artifact is a business rejection of the
   * head; any other preparation error propagates.
   */
  const rejectUnresolvedOfficialArtifact$ = command(
    async (
      { get, set },
      head: ChatQueueHeadContext,
      error: unknown,
      signal: AbortSignal,
    ): Promise<{ readonly kind: "passed" }> => {
      if (!(error instanceof OfficialWorkflowArtifactResolutionError)) {
        throw error;
      }
      const assembly = await get(assembly$);
      signal.throwIfAborted();
      await set(
        rejectChatQueueHead$,
        {
          head,
          rejection: claimAssemblyRejection(assembly, head, {
            code: "CONFLICT",
            message: OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
          }),
        },
        signal,
      );
      return { kind: "passed" };
    },
  );
  const claimAdmissionFacts$ = computed(async (get) => {
    const selected = await get(executionContext$);
    const [planCapabilities, featureSwitchContext] = await Promise.all([
      get(selected.plan$),
      get(selected.featureSwitches$),
    ]);
    return { planCapabilities, featureSwitchContext };
  });
  const prepareRunContext$ = command(
    async (
      { get, set },
      timing: ClaimRunTiming,
      signal: AbortSignal,
    ): Promise<ThreadRunContext | { readonly kind: "passed" }> => {
      const head = await set(initializeRunPreparation$, timing, signal);
      signal.throwIfAborted();
      if (!head) {
        return { kind: "passed" };
      }
      const resources = await settle(
        set(prepareClaimResources$, head, signal),
        signal,
      );
      if (!resources.ok) {
        return await set(
          rejectUnresolvedOfficialArtifact$,
          head,
          resources.error,
          signal,
        );
      }
      signal.throwIfAborted();
      if (resources.value.kind === "rejected") {
        const early = resources.value.assembly;
        await set(
          rejectChatQueueHead$,
          {
            head,
            rejection:
              early.kind === "rejected"
                ? early.rejection
                : unreadyQueueHeadRejection(head),
          },
          signal,
        );
        return { kind: "passed" };
      }
      const [
        input,
        storage,
        callbackRows,
        contextDraft,
        assembly,
        identity,
        admission,
      ] = resources.value.resources;
      if (assembly.kind !== "assembled") {
        await set(
          rejectChatQueueHead$,
          {
            head,
            rejection:
              assembly.kind === "rejected"
                ? assembly.rejection
                : unreadyQueueHeadRejection(head),
          },
          signal,
        );
        return { kind: "passed" };
      }
      const failure = firstPreparationFailure([
        input,
        admission,
        storage,
        contextDraft,
      ]);
      if (failure) {
        await set(
          rejectChatQueueHead$,
          {
            head,
            rejection: claimAssemblyRejection(
              assembly,
              head,
              failure.body.error,
            ),
          },
          signal,
        );
        return { kind: "passed" };
      }
      if (
        !input ||
        !storage ||
        !contextDraft ||
        !callbackRows ||
        !identity ||
        isRouteError(input) ||
        isRouteError(storage) ||
        isRouteError(contextDraft)
      ) {
        throw new Error("Prepared claim is missing launch resources");
      }
      await set(recordQueuedInputAdmissionTiming$, head, timing.run, signal);
      const admissionFacts = await get(claimAdmissionFacts$);
      signal.throwIfAborted();
      const preparedContext = await timing.run.measure(
        "api_dispatch_prepare_atomic_launch_persistence",
        "nested",
        () => {
          return Promise.resolve(
            finalizeClaimRunContext(
              {
                kind: "prepared",
                ...admissionFacts,
                input: claimCommitInput(input),
                identity,
                callbackRows,
                launch: finalizedMaterializedLaunch(storage, contextDraft),
                head,
                producerBinding: assembly.producerBinding,
                rejection: claimRejectionContext(assembly.rejection),
                launchRecord: claimLaunchRecord(assembly.launchRecord),
              },
              timing.run,
            ),
          );
        },
      );
      signal.throwIfAborted();
      timing.phase.checkpoint("api_dispatch_phase_prepare_launch", now());
      return preparedContext;
    },
  );
  const rejectEvent$ = command(
    async (
      { set },
      context: ThreadRunContext,
      error: { readonly code: string; readonly message: string },
      signal: AbortSignal,
    ): Promise<void> => {
      const rejection: ChatQueueHeadRejection =
        context.rejection.kind === "prompt"
          ? queuedMessageRejection(
              rejectedQueuedRunAdmissionFailure(
                context.rejection.runInput,
                error,
              ),
            )
          : { userId: context.rejection.userId, error };
      await set(
        rejectChatQueueHead$,
        { head: context.head, rejection },
        signal,
      );
    },
  );

  // Record the committed result and its activation metadata only after the
  // pending transaction returns. This command does no launch preparation.
  const recordRunCommit$ = command(
    (
      _store,
      context: ThreadRunContext,
      committed: AtomicLaunchCommitCompletion,
      timing: ClaimRunTiming,
      signal: AbortSignal,
    ): ClaimRunCommit => {
      const { input, identity, launch } = context;
      signal.throwIfAborted();
      if ("status" in committed.result) {
        return { kind: "rejected", error: committed.result.body.error };
      }
      if (committed.result.kind === "queue-first-claim-lost") {
        flushQueueFirstClaimLostTiming({
          createArgs: input.args,
          identity,
          launch,
          timing: timing.run,
          phaseTiming: timing.phase,
        });
        return { kind: "passed" };
      }
      const result = committedAtomicLaunchResponse({
        createArgs: { ...input.args, body: input.context.body },
        committed: committed.result,
        transactionReturnedAt: committed.transactionReturnedAt,
        timing: timing.run,
        phaseTiming: timing.phase,
      });
      if (!result.pendingActivation) {
        throw new Error("Pending run is missing activation metadata");
      }
      return {
        kind: "pending",
        runId: result.body.runId,
        activation: result.pendingActivation,
        context,
      };
    },
  );

  const createRun$ = command(
    async (
      { set },
      {
        claim,
        context,
        timing,
      }: {
        readonly claim: ThreadClaim;
        readonly context: ThreadRunContext;
        readonly timing: ClaimRunTiming;
      },
      signal: AbortSignal,
    ): Promise<ClaimRunCommit> => {
      signal.throwIfAborted();
      const { input, identity, callbackRows, launch } = context;
      if (
        input.args.orgId !== claim.orgId ||
        input.args.chatThreadId !== claim.chatThreadId ||
        context.head.chatThreadId !== claim.chatThreadId
      ) {
        throw new Error("Prepared run does not belong to this thread claim");
      }
      const commit: CommitPreparedLaunchArgs = {
        createArgs: input.args,
        enforceBuiltInCredits: input.enforceBuiltInCredits,
        context: input.context,
        identity,
        callbackRows,
        launch,
        timing: timing.run,
      };
      const admissionTiming = new AdmissionAttemptTiming({
        runId: identity.runId,
        runnerGroup: launch.runnerJobPayload.runnerGroup,
        profile: launch.runnerJobPayload.profile,
        dimensions: timingDimensionsForCreateArgs(input.args),
        ...(input.context.body.triggerSource
          ? { triggerSource: input.context.body.triggerSource }
          : {}),
      });
      const preparedCommit: PreparedCommitPreparedLaunchArgs = {
        ...commit,
        persistence: context.persistence,
        planCapabilities: context.planCapabilities,
        featureSwitchContext: context.featureSwitchContext,
        admissionTiming,
      };
      const committed: AtomicLaunchCommitCompletion = await timing.run.measure(
        "api_dispatch_insert_run_with_concurrency",
        "top_level",
        async () => {
          const result = await set(
            commitPreparedPendingLaunch$,
            preparedCommit,
            {
              orgId: claim.orgId,
              chatThreadId: claim.chatThreadId,
              claimId: claim.claimId,
              producer: context.producerBinding,
            },
            signal,
          );
          if ("kind" in result && result.kind === "pending") {
            set(internalCommittedRunId$, result.run.id);
          }
          const transactionReturnedAt = now();
          await admissionTiming.finish(admissionAttemptOutcome(result));
          return { result, transactionReturnedAt };
        },
      );
      signal.throwIfAborted();
      return set(recordRunCommit$, context, committed, timing, signal);
    },
  );

  const activatePendingRun$ = command(
    async ({ set }, pending: PendingClaimRun, signal: AbortSignal) => {
      signal.throwIfAborted();
      recordThreadRunActivationMarkers(
        pending.activation.runnerNotification,
        pending.activation.apiStartTime,
        pending.activation.timing.activationOrigin,
      );
      // A false publication result preserves the existing admitted-run policy.
      // Neither false nor an exception can undo this durable creation.
      await set(
        activateCommittedRun$,
        {
          notification: pending.activation.runnerNotification,
          timing: pending.activation.timing,
          activationScheduledAt: now(),
        },
        signal,
      );
      const launched = pending.context.launchRecord;
      if (launched.kind === "prompt") {
        set(
          recordQueuedPromptRunLaunch$,
          launched.context,
          pending.runId,
          launched.timing,
          signal,
        );
      } else {
        await finalizeClaimedRunUserMessage({
          orgId: launched.orgId,
          threadId: launched.threadId,
          userId: launched.userId,
        });
        signal.throwIfAborted();
        const database = set(writeDb$);
        const lastRunFields = () => {
          return {
            ...(launched.recordLastRunId ? { lastRunId: pending.runId } : {}),
            ...(launched.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
            ...(launched.disableClaimedOnceSchedule ? { enabled: false } : {}),
            updatedAt: nowDate(),
          };
        };
        if (await set(morningBriefScheduleClaimBound$, pending.runId, signal)) {
          signal.throwIfAborted();
          // Only journaled occurrences require this post-commit lock. Read
          // supersession after acquiring it so a concurrent claim is visible.
          // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0262; new non-billing transactions are prohibited.
          await database.transaction(async (tx) => {
            const [locked] = await tx
              .select({ id: workflowAutomations.id })
              .from(workflowAutomations)
              .where(eq(workflowAutomations.id, launched.automationId))
              .limit(1)
              .for("update");
            signal.throwIfAborted();
            if (!locked) {
              return;
            }
            const [observation] = await tx
              .select({
                superseded: morningBriefScheduleClaimSupersededCondition(
                  pending.runId,
                ).mapWith(pgBooleanDecoder),
              })
              .from(sql`(SELECT 1) AS schedule_claim_observation`);
            signal.throwIfAborted();
            if (!observation) {
              throw new Error("Schedule claim observation returned no row");
            }
            if (observation.superseded) {
              return;
            }
            await tx
              .update(workflowAutomations)
              .set(lastRunFields())
              .where(eq(workflowAutomations.id, launched.automationId));
          });
        } else {
          await database
            .update(workflowAutomations)
            .set(lastRunFields())
            .where(eq(workflowAutomations.id, launched.automationId));
        }
        signal.throwIfAborted();
      }
      await set(publishChatQueueHeadConsumed$, pending.context.head, signal);
    },
  );

  const hasFirstPickableChatEvent$ = computed(async (get) => {
    get(pickStartedAt$);
    return (await get(pickedEvent$)) !== null;
  });
  const startRun$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<string | null> => {
      const event = await get(pickedEvent$);
      signal.throwIfAborted();
      if (!event) {
        return null;
      }
      const timing = get(claimRunTiming$);
      const settled = await settle(
        (async (): Promise<PendingClaimRun | null> => {
          const context = await set(prepareRunContext$, timing, signal);
          signal.throwIfAborted();
          if (context.kind === "passed") {
            return null;
          }
          const committed = await set(
            createRun$,
            { claim, context, timing },
            signal,
          );
          if (committed.kind === "pending") {
            return committed;
          }
          if (committed.kind === "rejected") {
            await set(rejectEvent$, context, committed.error, signal);
          }
          return null;
        })(),
        signal,
      );
      if (!settled.ok) {
        // A durable run/job commit is creation success, even if subsequent
        // telemetry or cancellation fails. Never reject its consumed input.
        if (get(internalCommittedRunId$) !== null) {
          throw settled.error;
        }
        await settle(
          set(
            rejectChatQueueHead$,
            {
              head: {
                id: event.id,
                chatThreadId: claim.chatThreadId,
                orgId: claim.orgId,
                userId: event.userId,
                agentId: event.agentId,
                contextType: event.contextType,
                contextId: event.contextId,
              },
              rejection: { userId: event.userId, error: ABANDONED_HEAD_ERROR },
              lease: claim,
            },
            signal,
          ),
          signal,
        );
        throw settled.error;
      }
      const pending = settled.value;
      if (!pending) {
        return null;
      }
      // Both effects are deliberately outside the creation-failure boundary.
      waitUntil(set(updatePresignedUrlCache$, signal));
      await set(activatePendingRun$, pending, signal);
      return pending.runId;
    },
  );
  return { hasFirstPickableChatEvent$, startRun$ };
}

// --- Thread-private implementation: storage manifest ---

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly expectedStorageId?: string;
}

interface PrepareAgentRunStorageManifestArgs {
  readonly db: ReadonlyDb;
  readonly instructionsStorageName: string;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    readonly StorageManifestSource[] | undefined;
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

interface StorageManifestInputs {
  readonly artifacts: readonly ContextArtifact[];
  readonly composeVolumes: readonly ResolvedVolume[];
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
    readonly StorageManifestSource[] | undefined;
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

interface ResolvedStorageEntries {
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
interface AgentRunStoragePlan {
  readonly requested: ResolvedStorageEntries;
  readonly sessionWriteback: ResolvedStorageEntries | undefined;
  readonly missingArtifacts: readonly ContextArtifact[];
}

interface MaterializedAgentRunStorage {
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
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly resolved: StorageResolution;
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
      ApiDispatchTimingDimensionsInput | undefined,
    private readonly generateDimensions:
      ApiDispatchTimingDimensionsInput | undefined,
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

function runInstructionsVolume(args: {
  readonly instructionsStorageName: string;
  readonly framework: SupportedFramework | "pi";
}): ResolvedVolume {
  return {
    name: args.instructionsStorageName,
    mountPath: instructionsMountPath(args.framework),
    vasStorageName: args.instructionsStorageName,
    vasVersion: "latest",
    instructionsTargetFilename: instructionsFilename(args.framework),
  };
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

function storageIndexKey(orgId: string, userId: string, name: string): string {
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

interface StoragePrefixVersionRequest {
  readonly storageId: string;
  readonly version: string;
  readonly lookup: StorageLookup;
}

interface StoragePrefixVersionRow extends StorageVersionIndexEntry {
  readonly storageId: string;
  readonly cacheKey: string | null;
  readonly cacheScope: string | null;
  readonly presignedUrl: string | null;
  readonly expiresAt: Date | null;
}

function storagePrefixVersionRequests(
  requests: readonly StorageRequest[],
  index: StorageIndex,
): readonly StoragePrefixVersionRequest[] {
  const unique = new Map<string, StoragePrefixVersionRequest>();
  for (const request of requests) {
    const version = request.version;
    if (version === undefined || version === "latest") {
      continue;
    }
    const storage = index.get(
      storageIndexKey(
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
      ),
    );
    if (
      storage &&
      storage.headVersion?.id !== version &&
      !storage.exactVersions.has(version)
    ) {
      unique.set(JSON.stringify([storage.storageId, version]), {
        storageId: storage.storageId,
        version,
        lookup: request.lookup,
      });
    }
  }
  return [...unique.values()];
}

function storageIndexWithPrefixVersions(
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
              cachedUrls: [
                ...(entry.cachedUrls ?? []),
                ...versions
                  .filter((version) => {
                    return version.storageId === entry.storageId;
                  })
                  .flatMap(cacheRowsFromProjection),
              ],
            }
          : entry,
      ];
    }),
  );
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
    resolved: resolvedResult.ok,
  };
}

const CONNECTOR_SKILL_REGISTRATION_ERROR =
  "Connector skill registration is unavailable";

const CUSTOM_CONNECTOR_SKILL_REGISTRATION_ERROR =
  "Custom connector skill registration is unavailable";

class OfficialWorkflowArtifactResolutionError extends Error {
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

function resolveArtifactStorageInput(args: {
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

async function resolveStorageManifestInputs(
  args: PrepareAgentRunStorageManifestArgs,
): Promise<StorageManifestInputs> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_resolve_inputs",
    "nested",
    () => {
      return {
        artifacts: dedupArtifacts(args.artifacts),
        composeVolumes: [runInstructionsVolume(args)],
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
    readonly StorageManifestSource[] | undefined;
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

async function resolveStorageEntries(
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

/** Assemble runner mounts from immutable version plans and already signed URLs. */
function storageEntriesMetadata(
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

function assertUniquePersistedMountPaths(
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

function persistedStorageMountRequests(
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

function resolveValidatedPersistedStorageMounts(args: {
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

function resolveSessionWritebackStorageMounts(args: {
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

function combinePreparedStorageEntries<
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

interface SessionStorageOverlay {
  readonly canonicalWritebackMounts: readonly PersistedStorageMount[];
  readonly remainingArtifacts: readonly ContextArtifact[];
}

function resolveSessionStorageOverlay(args: {
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

function prepareRequestStorageResolution(
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

type AgentRunStorageInput =
  | {
      readonly kind: "requested";
      readonly args: PrepareAgentRunStorageManifestArgs;
    }
  | { readonly kind: "captured"; readonly args: CapturedAgentRunStorageArgs };

type AgentRunStorageSelection =
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

function frameworkSkillsMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? `${CANONICAL_CODEX_HOME_DIR}/skills`
    : `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`;
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

function skillsRootForRun(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  return piSandbox === undefined
    ? frameworkSkillsMountPath(framework)
    : PI_SKILLS_ROOT;
}

type AgentRunRecord = AgentRunRequestAgent;

type RunStorageExecution = Pick<
  ResolvedRunExecution,
  | "orgId"
  | "instructionsStorageName"
  | "artifacts"
  | "agentSessionId"
  | "persistedStorageMounts"
  | "additionalVolumes"
>;

function selectedRunStorageExecution(
  agent: AgentRunRecord,
  session: ChatThreadSessionResolution | undefined,
): RunStorageExecution | CreateRunErrorResult {
  const common = {
    orgId: agent.orgId,
    instructionsStorageName: getInstructionsStorageName(agent.name),
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
  };
}

/**
 * Shared storage index read: storage rows with their HEAD and exact requested
 * versions in one fixed-shape statement. Prefix versions are a separate read
 * ({@link withStoragePrefixVersions}) so callers can depend on this snapshot.
 */
async function loadStorageBaseIndex(
  db: ReadonlyDb,
  requests: readonly StorageRequest[],
  timing: ApiDispatchTimingCollector | undefined,
): Promise<StorageIndex> {
  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_storage_manifest_load_storage_index",
    "nested",
    () => {
      return readStorageBaseIndex(db, requests);
    },
  );
}

/** Resolve requested version prefixes against an already loaded index. */
async function withStoragePrefixVersions(
  db: ReadonlyDb,
  requests: readonly StorageRequest[],
  index: StorageIndex,
): Promise<StorageIndex> {
  const queries = storagePrefixVersionRequests(requests, index).map(
    (request) => {
      return db
        .select({
          storageId: storageVersions.storageId,
          id: storageVersions.id,
          s3Key: storageVersions.s3Key,
          archiveSize: storageVersions.archiveSize,
          fileCount: storageVersions.fileCount,
          cacheKey: systemStoragePresignedUrlCache.cacheKey,
          cacheScope: systemStoragePresignedUrlCache.scope,
          presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
          expiresAt: systemStoragePresignedUrlCache.expiresAt,
        })
        .from(storageVersions)
        .leftJoin(
          systemStoragePresignedUrlCache,
          eq(
            systemStoragePresignedUrlCache.cacheKey,
            storageVersionCacheKeySql({
              orgId: sql`${request.lookup.orgId}`,
              userId: sql`${request.lookup.userId}`,
              name: sql`${request.lookup.name}`,
              versionId: sql`${storageVersions.id}`,
              s3Key: sql`${storageVersions.s3Key}`,
            }),
          ),
        )
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
    },
  );
  const [first, second, ...remaining] = queries;
  const versions = first
    ? await (second ? unionAll(first, second, ...remaining) : first)
    : [];
  return storageIndexWithPrefixVersions(index, versions);
}
// --- Thread-private implementation: launch persistence ---

interface AgentRunCreateAdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly expectedStorageId?: string;
}

type StorageManifestSource =
  | SkillVolume["source"]
  | "compose_additional_volume"
  | "compose_volume"
  | "artifact"
  | "unknown";

type AdditionalVolumeSources = readonly StorageManifestSource[] | undefined;

interface ResolvedAgentExecution {
  readonly instructionsStorageName: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly orgId: string;
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes?: readonly AgentRunCreateAdditionalVolume[];
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
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

interface AgentExecutionRequestObservation {
  readonly requestUserId: string;
  readonly requestOrgId: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly agentOrgId: string;
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

interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

interface ValidatedThreadSessionSnapshot {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly threadAgentId: string | null;
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
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
  | QueueFirstRunClaimLost;

type CommittedAtomicLaunchResult = Exclude<
  AtomicLaunchCommitResult,
  QueueFirstRunClaimLost
>;

type PendingThreadSessionResolution = Pick<
  ChatThreadSessionResolution,
  "action" | "previousAgentId" | "resetNativeSession" | "expected"
>;
/** Explicit facts the atomic launch persists; owners assemble them privately. */
interface PendingRunArguments {
  readonly userId: string;
  readonly orgId: string;
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  readonly chatThreadId?: string;
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly agentRunModelPin?: AgentRunModelPin;
  readonly codexServiceTier?: "fast";
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
  readonly threadSessionResolution?: PendingThreadSessionResolution;
}

/** Explicit run facts persisted with the launch rows. */
interface PendingRunContext {
  readonly body: CreateRunBody;
  readonly selectedImageModel: ImageModel;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly officialWorkflowFacts: OfficialWorkflowContextFacts;
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
  readonly createArgs: PendingRunArguments;
  readonly enforceBuiltInCredits: boolean;
  readonly context: PendingRunContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
}

function timingDimensionsForCreateArgs(args: {
  readonly timingDimensions?: ApiDispatchTimingDimensions;
}): ApiDispatchTimingDimensions {
  return {
    api_start_source: "request",
    run_preparation_retry_count: "0",
    ...args.timingDimensions,
  };
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

interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly status: LaunchRunStatus;
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
  readonly officialWorkflowProvenance:
    AgentRunOfficialWorkflowProvenance | undefined;
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
  readonly planCapabilities: OrgPlanCapabilities | null;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly persistence: PreparedAtomicLaunchPersistence;
  readonly admissionTiming: AdmissionAttemptTiming;
}

function prepareAtomicLaunchPersistence(
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

type ReturnedIdCte = WithSubquery & { readonly id: SQLWrapper };

function returnedCteId(cte: ReturnedIdCte): SQL {
  // Child mutations read the returned key so their dependency is explicit;
  // data-modifying CTE declaration order alone does not order execution.
  return sql`(SELECT ${returnedCteColumn(cte, "id")} FROM ${cte})`;
}

function nullableReturnedCteId(cte: ReturnedIdCte | undefined): SQL {
  return cte ? returnedCteId(cte) : sql`NULL`;
}

function appendLaunchCallbackCte(args: {
  readonly ctes: WithSubquery[];
  readonly callbacks: readonly AgentRunCallbackInsert[];
  readonly insertedRun: ReturnedIdCte;
}): void {
  if (args.callbacks.length === 0) {
    return;
  }
  args.ctes.push(
    new QueryBuilder().$with("inserted_launch_callbacks", {}).as(
      pendingLaunchInsertSql(
        agentRunCallbacks,
        args.callbacks.map((callback) => {
          return { ...callback, runId: returnedCteId(args.insertedRun) };
        }),
      ),
    ),
  );
}

function launchThreadBindingCte(args: {
  readonly chatThreadId: string | undefined;
  readonly userId: string;
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
  return new QueryBuilder()
    .$with("updated_launch_thread_binding", { id: chatThreads.id })
    .as(
      pendingLaunchUpdateSql(
        chatThreads,
        {
          agentSessionId: args.identity.sessionId,
          agentSessionRunId: returnedCteId(args.insertedRun),
        },
        and(
          eq(chatThreads.id, args.chatThreadId),
          eq(chatThreads.userId, args.userId),
          sql`${chatThreads.agentId} IS NOT DISTINCT FROM ${args.validatedThreadSession.threadAgentId}::uuid`,
          sql`${chatThreads.agentSessionId} IS NOT DISTINCT FROM ${args.validatedThreadSession.agentSessionId}::uuid`,
          sql`${chatThreads.agentSessionRunId} IS NOT DISTINCT FROM ${args.validatedThreadSession.agentSessionRunId}::uuid`,
        ),
        ["id"],
      ),
    );
}

function buildAtomicLaunchCteContext(
  args: AtomicLaunchRowsPlanArgs,
  creditAdmitted: boolean,
) {
  const { rowsArgs, metadata } = args.commit.persistence.rows;
  const createdAt = nowDate();
  const ctes: WithSubquery[] = [];
  const insertedSession = rowsArgs.identity.shouldCreateSession
    ? new QueryBuilder()
        .$with("inserted_launch_session", { id: agentSessions.id })
        .as(
          pendingLaunchInsertSql(
            agentSessions,
            [launchSessionValues(rowsArgs)],
            ["id"],
          ),
        )
    : undefined;
  if (insertedSession) {
    ctes.push(insertedSession);
  }

  const insertedRun = new QueryBuilder()
    .$with("inserted_launch_run", {
      id: agentRuns.id,
      createdAt: agentRuns.createdAt,
    })
    .as(
      pendingLaunchInsertSql(
        agentRuns,
        [
          {
            ...launchRunValues(rowsArgs, createdAt, metadata),
            creditAdmitted,
            modelProviderAccountIdentity: args.validatedAccountIdentity,
            sessionId: insertedSession
              ? returnedCteId(insertedSession)
              : rowsArgs.identity.sessionId,
          },
        ],
        ["id", "createdAt"],
      ),
    );
  ctes.push(insertedRun);

  const insertedDiagnosticRegistration = new QueryBuilder()
    .$with("inserted_launch_connector_diagnostic_registration", {})
    .as(
      pendingLaunchInsertSql(agentRunConnectorDiagnosticRegistrations, [
        {
          runId: returnedCteId(insertedRun),
          payload: args.commit.persistence.diagnosticRegistrationPayload,
          createdAt,
        },
      ]),
    );
  // The insert executes with the statement and depends on insertedRun's ID.
  // Its returned row need not participate in the final result join.
  ctes.push(insertedDiagnosticRegistration);

  appendLaunchCallbackCte({
    ctes,
    callbacks: rowsArgs.callbackRows,
    insertedRun,
  });
  const chatThreadId = args.commit.createArgs.chatThreadId;
  const updatedThread = launchThreadBindingCte({
    chatThreadId,
    userId: args.commit.createArgs.userId,
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

interface AtomicLaunchRowsPlanArgs extends ValidatedPreparedLaunchAdmission {
  readonly commit: PreparedCommitPreparedLaunchArgs;
  readonly payload: RunnerJobPayload;
}
interface AdmittedPreparedLaunch extends ValidatedPreparedLaunchAdmission {
  readonly kind: "admitted";
  readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
}

function atomicThreadSessionBinding(args: {
  readonly context: AtomicLaunchCteContext;
  readonly commit: Omit<CommitPreparedLaunchArgs, "db">;
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

function committedAtomicLaunchResponse(args: {
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
// --- Thread-private implementation: connector context ---

function connectorScopeFromCreateArgs(args: {
  readonly connectorScope: ExplicitConnectorScope;
}): EffectiveConnectorScope {
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

// --- Thread-private implementation: model provider environment ---

function modelProviderFramework(
  modelProvider: ResolvedModelProviderEnvironment,
): SupportedFramework {
  return getFrameworkForType(modelProvider.type);
}

/** Post-reservation materializer. This never inserts a Run or invokes the API
 * first turn. Publication owns a fresh admission. */

// Selected-agent authorization, bootstrap and canonical session preparation.

type AgentRunCreateBody = z.infer<typeof runCreateBodySchema>;

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
  AgentRunsCreateHttpRunCallback | AgentRunsCreateInternalRunCallback;

interface AgentRunsCreateAgentRunMetadata {
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

/** The owner a claimed queue head runs as: its user in its organization. */
interface ThreadRunOwner {
  readonly userId: string;
  readonly orgId: string;
}

/** The run-request facts Thread sets for a claimed queue head. */
type ThreadRunBody = Pick<
  AgentRunCreateBody,
  | "modelProvider"
  | "prompt"
  | "realAgentInPreview"
  | "captureNetworkBodies"
  | "sessionId"
> & {
  /** The queue head's Agent; a Thread run always names it. */
  readonly agentId: string;
};

/** Thread's run command for one claimed, queue-first input. */
interface ThreadRunCommand {
  readonly owner: ThreadRunOwner;
  readonly body: ThreadRunBody;
  readonly apiStartTime: number;
  readonly triggerSource?: TriggerSource;
  readonly appendSystemPrompt?: string;
  readonly callbacks?: readonly AgentRunsCreateRunCallback[];
  readonly chatThreadId: string;
  readonly connectorSourceId?: string;
  readonly threadSessionRoute?: ChatThreadSessionRoute;
  /** A producer may atomically move an integration thread to this run's agent. */
  readonly expectedThreadAgentId?: string;
  readonly computerUseHostId?: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly agentRunMetadata?: AgentRunsCreateAgentRunMetadata;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly queueFirstAssociation: QueueFirstRunAssociation;
  readonly agentRunModelPin?: AgentRunModelPin;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly timing?: ApiDispatchTimingCollector;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
}

interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
}

/** The selection-time command: everything but the prompt-time facts. */
type ThreadRunSelection = Omit<
  ThreadRunCommand,
  "body" | "appendSystemPrompt" | "callbacks"
> & {
  readonly body: Omit<ThreadRunBody, "prompt">;
};
/** The identity read before Pi eligibility is decided. */
type ThreadRunIdentity = Omit<ThreadRunSelection, "piExecution"> & {
  readonly piExecution?: boolean;
};

function selectedRunPiExecution(command: ThreadRunIdentity): boolean {
  if (command.piExecution === undefined) {
    throw new Error("Selected model execution eligibility is unavailable");
  }
  return command.piExecution;
}

/** The plain facts of a Thread run that Pi model preparation reads. */
function piModelPreparationInput(
  args: Pick<
    RunModelProviderArgs,
    "catalog" | "piExecution" | "codexServiceTier" | "agentRunMetadata"
  >,
): PiModelPreparationInput {
  return {
    catalog: args.catalog,
    piExecution: args.piExecution,
    codexServiceTier: args.codexServiceTier,
    reasoningEffort: args.agentRunMetadata?.reasoningEffort,
  };
}

function selectedRunModelProviderArgs(
  command: ThreadRunIdentity,
): Omit<RunModelProviderArgs, "catalog"> {
  return {
    orgId: command.owner.orgId,
    userId: command.owner.userId,
    modelProviderId: command.modelProviderId,
    modelProviderCredentialScope: command.modelProviderCredentialScope,
    modelProviderType: command.body.modelProvider,
    selectedModelOverride: command.selectedModelOverride,
    builtInModelRuntimeRoute: command.builtInModelRuntimeRoute,
    piExecution: selectedRunPiExecution(command),
    codexServiceTier: command.codexServiceTier,
    agentRunMetadata: { reasoningEffort: command.reasoningEffort },
    ...("queueFirstAssociation" in command
      ? { queueFirstAssociation: command.queueFirstAssociation }
      : {}),
  };
}
// --- Thread-private implementation: Runner payload ---

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

type BuiltStoredExecutionContextDraft = Omit<
  BuiltStoredExecutionContext,
  "context" | "persistedStorageMounts" | "runContextStorage"
> & {
  readonly context: Omit<StoredExecutionContext, "storageMounts">;
};

function expandEnvironment(args: {
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): Record<string, string> | null {
  const storedConnectorEnvironment = expandStoredConnectorEnvironment({
    environment: effectiveStoredConnectorEnvironment({
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const mergedEnvironment = args.additionalEnvironment;
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

function expandStoredConnectorEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
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

function filterSecretConnectorMap(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly overriddenSecrets: readonly (
    Readonly<Record<string, unknown>> | undefined
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
    Record<string, SecretConnectorMetadata> | undefined;
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

/**
 * The Runner's model usage metering fields: billable firewalls, the provider
 * usage is reported under, and the long-context threshold captured from the
 * run's assigned Built-in route (`0`: the route explicitly bills a single
 * tier, so the Runner must not fall back to its generated map).
 */
function modelUsageExecutionFields(args: {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
}): Pick<
  StoredExecutionContext,
  | "billableFirewalls"
  | "modelUsageProvider"
  | "modelUsageLongContextMinTotalInputTokens"
> {
  return {
    billableFirewalls: [...args.billableFirewalls],
    modelUsageProvider: args.modelUsageProvider,
    modelUsageLongContextMinTotalInputTokens:
      args.modelUsageLongContextMinTotalInputTokens,
  };
}

/** The stored execution context draft from the runner input and its encrypted secrets. */
function claimRunStoredContextDraft<
  TEncrypted extends {
    readonly encryptedSecrets: Parameters<
      typeof buildStoredExecutionContextDraft
    >[1];
  },
>(
  input: RunnerInputResult,
  encrypted: TEncrypted | CreateRunErrorResult | null | undefined,
) {
  if (!input || isRouteError(input)) {
    return input;
  }
  if (!encrypted || isRouteError(encrypted)) {
    return encrypted;
  }
  const { args, body, platformEnvironment } = input;
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
    encrypted.encryptedSecrets,
  );
}

function buildStoredExecutionContextDraft(
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
    readonly modelUsageLongContextMinTotalInputTokens: number;
    readonly apiStartTime: number;
    readonly additionalVolumes:
      readonly AgentRunCreateAdditionalVolume[] | undefined;
    readonly platformEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly includeOkouTokenSecret: boolean | undefined;
  },
  encryptedSecrets: BuiltStoredExecutionContextDraft["context"]["encryptedSecrets"],
): BuiltStoredExecutionContextDraft {
  const permissions = args.permissionManifest;
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
  // fully expanded untrusted environment before the trusted overlay.
  const expandedEnvironment = withoutOkouNamespaceEntries(
    expandEnvironment({
      vars: args.body.vars,
      secrets: executionSecrets.secrets,
      additionalEnvironment: args.modelProvider?.environment,
      environmentSecretPlaceholders: permissions?.environmentSecretPlaceholders,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    }),
  );
  const platformEnvironment = buildStoredPlatformEnvironment({
    platformEnvironment: args.platformEnvironment,
    canonicalOkouRuntime: args.includeOkouTokenSecret === true,
  });
  const untrustedEnvironment = buildStoredUntrustedEnvironment({
    expandedEnvironment,
    canonicalOkouRuntime: args.includeOkouTokenSecret === true,
  });
  const environment = untrustedEnvironment;
  const effectiveEnvironment = {
    ...environment,
    ...platformEnvironment,
  };
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
      disallowedTools: args.body.disallowedTools,
      tools: args.body.tools,
      settings: args.body.settings,
      featureFlags: getAllFeatureStates(args.featureSwitchContext),
      ...modelUsageExecutionFields(args),
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

function buildStoredExecutionSecrets(args: {
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
  readonly modelUsageLongContextMinTotalInputTokens: number;
  readonly apiStartTime: number;
  readonly additionalVolumes:
    readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly okouTokenComputerUseHostId: string | undefined;
  readonly okouTokenCloudBrowserEnabled: boolean | undefined;
  readonly chatThreadId: string | undefined;
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly piLaunchConfig: PiLaunchConfigOverrides | undefined;
  readonly artifactMissingRootPolicy: ArtifactMissingRootPolicy | undefined;
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

function preparedRunnerGroup(): string {
  return officialRunnerGroup(optionalEnv("RUNNER_DEFAULT_GROUP"));
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

function withPaidToolPlatformEnvironment(
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
  // supplied by current runtime sources; a personal subscription does too.
  return (
    context.modelProvider === null ||
    !isBuiltInModelProviderType(context.modelProvider.type)
  );
}

/**
 * Final runner launch from explicit facts: the stored context draft with its
 * prepared storage, Pi launch resources, run-context snapshot, runner job
 * payload and persisted run/session storage mounts.
 */
function assembleRunnerLaunch(args: {
  readonly runId: string;
  readonly userId: string;
  readonly chatThreadId: string | undefined;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly runnerGroup: string;
  readonly body: CreateRunBody;
  readonly writebackArtifacts: readonly AgentRunCreateContextArtifact[];
  readonly preparedStorage: PreparedAgentRunStorage;
  readonly contextDraft: BuiltStoredExecutionContextDraft;
  readonly piResources: PreparedPiLaunchResources | undefined;
}): PreparedRunnerLaunch {
  const builtContext = resolveBuiltStoredExecutionContext(
    args.preparedStorage,
    args.contextDraft,
  );
  const storedContext = storedExecutionContextWithPiResources(
    builtContext.context,
    args.piResources,
    args.launchSnapshot.framework,
  );
  const persistedStorageMounts = withPiMemoryRecallEpoch(
    builtContext.persistedStorageMounts,
    args.piResources?.memoryRecall,
  );
  const runContextSnapshot = buildRunContextSnapshot({
    runId: args.runId,
    userId: args.userId,
    body: args.body,
    builtContext: { ...builtContext, context: storedContext },
  });
  const cliAgentSessionId =
    storedContext.piSessionId ?? storedContext.resumeSession?.sessionId ?? null;
  return {
    runnerJobPayload: runnerJobPayload({
      runnerGroup: args.runnerGroup,
      profile: args.launchSnapshot.runnerProfile,
      cliAgentSessionId,
      reuseKey: runnerReuseKey(args.chatThreadId),
      executionContext: storedContext,
    }),
    runContextSnapshot,
    runStorageMounts: persistedStorageMounts,
    sessionStorageMounts: sessionStorageMountsForPersistence({
      resolvedMounts: persistedStorageMounts,
      artifacts: args.writebackArtifacts,
    }),
  };
}

interface StorageMaterializationInput {
  readonly db: Db;
  readonly args: BuildRunnerJobPayloadInput;
  readonly storageManifestStats: StorageManifestBuildStats;
}

function runnerWritebackArtifacts(args: BuildRunnerJobPayloadInput) {
  return args.artifactMissingRootPolicy === undefined
    ? args.artifacts
    : args.artifacts.map((artifact) => {
        return {
          ...artifact,
          missingRootPolicy: args.artifactMissingRootPolicy,
        };
      });
}

function prepareRunnerStorageInput(input: StorageMaterializationInput) {
  const { db, args, storageManifestStats } = input;
  const body = preparedRunnerJobBody(args);
  return {
    db,
    args,
    storageManifestStats,
    body,
    writebackArtifacts: runnerWritebackArtifacts(args),
    group: preparedRunnerGroup(),
    platformEnvironment: args.includeOkouTokenSecret
      ? { ...args.platformEnvironment, ...okouTokenEnvironment(body) }
      : args.platformEnvironment,
  };
}

interface MaterializedRunnerStorage {
  readonly input: ReturnType<typeof prepareRunnerStorageInput>;
  readonly preparedStorage: MaterializedAgentRunStorage;
  readonly piResources: PreparedPiLaunchResources | undefined;
}

function finalizedMaterializedLaunch(
  storage: MaterializedRunnerStorage,
  contextDraft: BuiltStoredExecutionContextDraft,
): PreparedRunnerLaunch {
  const { args, group, body, writebackArtifacts } = storage.input;
  return assembleRunnerLaunch({
    runId: args.run.id,
    userId: args.userId,
    chatThreadId: args.chatThreadId,
    launchSnapshot: args.launchSnapshot,
    runnerGroup: group,
    body,
    writebackArtifacts,
    preparedStorage: storage.preparedStorage.prepared,
    contextDraft,
    piResources: storage.piResources,
  });
}
// --- Thread-private implementation: run body ---

const L: ReturnType<typeof logger> = logger("AgentRunCreate");

function withPendingOkouTokenSecret(body: CreateRunBody): CreateRunBody {
  return { ...body, secrets: pendingOkouTokenSecrets(body.secrets) };
}

interface ProductResolutionOptions {
  readonly instructionsStorageName: string;
  readonly timing?: ApiDispatchTimingCollector;
  readonly sessionSnapshot?: ChatThreadExecutionSnapshot;
}

interface ResolveAgentExecutionOptions {
  readonly instructionsStorageName: string;
  readonly agentObservation?: RunAgentObservation;
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  readonly timing?: ApiDispatchTimingCollector;
  readonly resetNativeSession?: boolean;
  readonly sessionSnapshot?: ChatThreadExecutionSnapshot;
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

function isRouteError(value: unknown): value is CreateRunErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { readonly status: unknown }).status === "number" &&
    (value as { readonly status: number }).status !== 201
  );
}

function missingEnvironmentReferences(args: {
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): string[] {
  assertStoredConnectorEnvironmentReferences({
    environment: effectiveStoredConnectorEnvironment({
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const environment = args.additionalEnvironment;
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
    Readonly<Record<string, string>> | undefined;
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
    Readonly<Record<string, string>> | undefined;
}): void {
  const missing = missingReferencesInEnvironment(args);
  if (missing.length > 0) {
    throw new Error(
      `Stored connector environment is missing required values: ${missing.join(", ")}`,
    );
  }
}

interface RunAgentObservation {
  readonly agentId: string;
  readonly agentOrgId: string;
  readonly agentOwner: string;
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
    instructionsStorageName: options.instructionsStorageName,
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
    instructionsStorageName: options.instructionsStorageName,
    ...resolvedSessionStorage(snapshot.session),
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

/** Product execution depends only on identity and the captured session/agent. */
async function resolveProductAgentExecution(
  body: Pick<CreateRunBody, "agentId" | "sessionId">,
  userId: string,
  orgId: string,
  options: ResolveAgentExecutionOptions,
): Promise<ResolvedRunExecution | CreateRunErrorResult> {
  if (body.sessionId) {
    const resolved = await measureApiDispatchTiming(
      options.timing,
      "api_dispatch_resolve_agent_execution_by_session_id",
      "nested",
      async () => {
        return await resolveSessionExecution(options.sessionSnapshot, {
          instructionsStorageName: options.instructionsStorageName,
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
      instructionsStorageName: options.instructionsStorageName,
      artifacts: [],
    };
  }
  return await measureApiDispatchTiming(
    options.timing,
    "api_dispatch_resolve_agent_execution_by_agent_id",
    "nested",
    () => {
      return resolveAgentObservation(options.agentObservation, {
        instructionsStorageName: options.instructionsStorageName,
        timing: options.timing,
      });
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

function initialRunBody(args: {
  readonly body: CreateRunBody;
  readonly includeOkouTokenSecret?: boolean;
}): CreateRunBody {
  return args.includeOkouTokenSecret
    ? withPendingOkouTokenSecret(args.body)
    : args.body;
}

function buildResolvedRunBody(args: {
  readonly initialBody: CreateRunBody;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly canonicalOkouRuntime: boolean;
  readonly resolvedEnvironment?: RunBodyEnvironment;
}): CreateRunBody {
  const runVars = args.initialBody.vars;
  const environment =
    args.resolvedEnvironment ??
    resolveRunBodyEnvironment({
      runVars,
      runSecrets: args.initialBody.secrets,
      persistedEnvironment: args.persistedEnvironment,
      canonicalOkouRuntime: args.canonicalOkouRuntime,
    });
  return {
    ...args.initialBody,
    ...environment,
  };
}

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

function agentRunsCreateForbidden(
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

function buildAgentRunPlatformEnvironment(args: {
  readonly agentId: string;
  readonly triggerSource: TriggerSource;
  readonly chatThreadId: string | undefined;
  readonly codexServiceTier: "fast" | undefined;
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
  readonly command: ThreadRunCommand;
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

function agentRunOrigin(args: {
  readonly command: ThreadRunCommand;
}): AgentRunOrigin {
  if (args.command.agentRunMetadata?.workflowAutomationId) {
    return "workflow_automation";
  }
  return "direct";
}

function createRunBody(args: {
  readonly body: AgentRunCreateBody;
  readonly agent: AgentRunRecord;
  readonly permissionPolicies: FirewallPolicies | null | undefined;
  readonly triggerSource: TriggerSource | undefined;
  readonly appendSystemPrompt: string | undefined;
}) {
  const triggerSource = args.triggerSource ?? "web";
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
    appendSystemPrompt: args.appendSystemPrompt,
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: selectedAgentRunVariables(args.agent.id),
  };
}

function measureAgentRunPreCreate<T>(
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

interface AgentRunAfterBootstrap extends RunBootstrapContext {
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly timing: ApiDispatchTimingCollector;
  readonly command: ThreadRunIdentity;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
}

interface AgentRunAfterPreCreate extends AgentRunAfterBootstrap {
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

interface ProductRunArgsInput {
  /** One catalog snapshot per run, loaded by the entry point. */
  readonly catalog: ModelCatalog;
  readonly command: ThreadRunCommand;
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants: readonly AgentCustomConnectorGrant[];
  readonly timing: ApiDispatchTimingCollector;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly cloudBrowserEnabled: boolean;
}

/**
 * Explicit run arguments a product entry point (chat/automation) prepares for
 * Thread: exactly the facts this builder sets, no legacy direct-run knobs.
 */
interface ProductRunArgs {
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly piExecution: boolean;
  readonly codexServiceTier?: "fast";
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  readonly chatThreadId?: string;
  readonly connectorSourceId?: string;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly platformEnvironment?: Record<string, string>;
  readonly callbacks?: readonly RunCallback[];
  readonly includeOkouTokenSecret?: boolean;
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  readonly okouTokenComputerUseHostId?: string;
  readonly okouTokenCloudBrowserEnabled?: boolean;
  readonly enforceBuiltInCredits?: boolean;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly connectorScope: ExplicitConnectorScope;
  readonly validateEnvironmentReferences?: boolean;
  readonly agentRunModelPin?: AgentRunModelPin;
  readonly timing?: ApiDispatchTimingCollector;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
}

function buildProductRunArgs(args: ProductRunArgsInput): ProductRunArgs {
  const command = args.command;
  return {
    ...selectedRunModelProviderArgs(command),
    catalog: args.catalog,
    body: createRunBody({
      body: command.body,
      agent: args.agent,
      permissionPolicies: args.runPermissionPolicies,
      triggerSource: command.triggerSource,
      appendSystemPrompt: command.appendSystemPrompt,
    }),
    apiStartTime: command.apiStartTime,
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

interface RunBootstrapContext extends AgentConnectorScopeSnapshot {
  readonly userInfo: UserInfo;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly workflows: readonly RunWorkflowRef[];
  readonly permissionGrants: readonly FirewallPermissionGrant[];
  readonly connectorCatalogMetadataSlugs: readonly ConnectorSlug[];
}
interface AgentRunIdentityInput {
  readonly timing: ApiDispatchTimingCollector;
  readonly owner: ThreadRunOwner;
  readonly agentId: string;
  readonly apiStartTime: number;
  readonly chatThreadId: string;
  readonly expectedThreadAgentId?: string;
  readonly queueFirstAssociation: QueueFirstRunAssociation;
}
interface AgentRunGraphInput {
  readonly command: ThreadRunIdentity;
  readonly timing: ApiDispatchTimingCollector;
}

function matchingAuthorizedRequestObservation(
  args: ThreadRunIdentity,
  agentId: string,
): AuthorizedAgentRunRequestObservation | undefined {
  const observation = args.authorizedRequestObservation;
  if (
    !observation ||
    observation.userId !== args.owner.userId ||
    observation.orgId !== args.owner.orgId ||
    observation.agent.id !== agentId ||
    observation.agent.orgId !== args.owner.orgId ||
    observation.featureSwitchContext.userId !== args.owner.userId ||
    observation.featureSwitchContext.orgId !== args.owner.orgId
  ) {
    return undefined;
  }
  return observation;
}
// --- Thread-private implementation: execution context prompts ---

const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";

interface RunArtifacts {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
}

interface PreparedAdditionalVolumes {
  readonly volumes: readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly sources: AdditionalVolumeSources;
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

function artifactsForRun(args: {
  readonly resolved: Pick<ResolvedRunExecution, "artifacts">;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
}): RunArtifacts {
  return {
    artifacts: [
      ...args.resolved.artifacts.filter((artifact) => {
        return (
          artifact.name !== AUTO_MEMORY_ARTIFACT_NAME &&
          artifact.mountPath !==
            autoMemoryMountPath(args.framework, args.piSandbox)
        );
      }),
      {
        name: AUTO_MEMORY_ARTIFACT_NAME,
        mountPath: autoMemoryMountPath(args.framework, args.piSandbox),
        missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
      },
    ],
  };
}

function validateRunEnvironmentReferences(args: {
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
  if (args.validateEnvironmentReferences === false) {
    return null;
  }
  const missing = missingEnvironmentReferences({
    vars: args.body.vars,
    secrets: validationSecrets.secrets,
    environmentSecretPlaceholders:
      args.permissionManifest?.environmentSecretPlaceholders,
    additionalEnvironment: args.modelProvider?.environment,
    storedConnectorEnvironment: args.connectorContext.storedEnvironment,
    connectorVars: args.connectorContext.vars,
  });
  return missing.length === 0
    ? null
    : badRequestMessage(`Missing required values: ${missing.join(", ")}`);
}

function preparedRunAdditionalVolumes(args: {
  readonly skillVolumes: readonly SkillVolume[];
  readonly skillsRoot: string;
  readonly body: Pick<CreateRunBody, "additionalVolumes">;
  readonly resolved: Pick<ResolvedRunExecution, "additionalVolumes">;
}): PreparedAdditionalVolumes {
  const bodyAdditionalVolumes = args.body.additionalVolumes;
  const rendered = resolveRunSkillVolumes(args.skillVolumes, args.skillsRoot);
  const hasTemplateVolumes = args.skillVolumes.some((volume) => {
    return volume.source === "request_additional_volume";
  });
  const additionalVolumes =
    bodyAdditionalVolumes ??
    (hasTemplateVolumes ? [] : (args.resolved.additionalVolumes ?? []));
  return {
    volumes: [...rendered.skillVolumes, ...additionalVolumes],
    sources: [
      ...rendered.skillVolumeSources,
      ...additionalVolumes.map((): StorageManifestSource => {
        return bodyAdditionalVolumes ? "request_additional_volume" : "unknown";
      }),
    ],
  };
}

function prepareRunOutputMetadata(args: {
  readonly skillVolumes: readonly SkillVolume[];
  readonly officialWorkflow: OfficialWorkflowObservation | undefined;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly body: Pick<CreateRunBody, "additionalVolumes">;
  readonly resolved: RunStorageExecution;
}): {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes:
    readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
} {
  const skillsRoot = skillsRootForRun(args.framework, args.piSandbox);
  const additionalVolumes = preparedRunAdditionalVolumes({
    skillVolumes: args.skillVolumes,
    skillsRoot,
    body: args.body,
    resolved: args.resolved,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    piSandbox: args.piSandbox,
  }).artifacts;
  return {
    additionalVolumes: additionalVolumes.volumes,
    additionalVolumeSources: additionalVolumes.sources,
    artifacts,
    officialWorkflowRun: args.officialWorkflow && {
      ...args.officialWorkflow,
      definitions: args.officialWorkflow.definitions.map((definition) => {
        return {
          ...definition,
          mountPath: `${skillsRoot}/${definition.workflowName}`,
        };
      }),
    },
  };
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

// --- Thread-private implementation: Pi launch resources ---

function noContentPiMemoryRecall(args: {
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
}): PiMemoryRecallSelection {
  return { ...args, status: "no-content" };
}

interface PreparePiLaunchResourcesArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly piMemoryEnabled: boolean;
  readonly runId: string;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly storagePlan: Promise<ResolvedAgentRunStorage>;
  readonly piSandbox: PiModelConfig | undefined;
  readonly chatThreadId: string | undefined;
  readonly timing: ApiDispatchTimingCollector;
  readonly piLaunchConfig: PiLaunchConfigOverrides | undefined;
}

// --- Thread-private implementation: launch admission ---

type AtomicLaunchCommitAttempt =
  AtomicLaunchCommitResult | CreateRunErrorResult;

interface AtomicLaunchCommitCompletion {
  readonly result: AtomicLaunchCommitAttempt;
  readonly transactionReturnedAt: number;
}

function admissionAttemptOutcome(
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

function flushQueueFirstClaimLostTiming(args: {
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

// --- Private implementation: launch persistence ---

type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;

type CreateRunBody = Omit<
  z.infer<typeof unifiedRunRequestSchema>,
  "triggerSource"
> & {
  readonly triggerSource: TriggerSource;
};

interface AgentRunCreateContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
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

// --- Private implementation: connector context ---

// --- Private implementation: Runner payload ---

interface BuiltStoredExecutionContext {
  readonly context: StoredExecutionContext;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: PreparedAgentRunStorage["runContextStorage"];
  readonly secretNames: readonly string[];
  // Plain secret values used for run-context redaction; values, not names.
  readonly secretValues: readonly string[];
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
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
  readonly body: Pick<CreateRunBody, "prompt" | "appendSystemPrompt">;
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

function officialRunnerGroup(group: string | undefined): string {
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

// --- Private implementation: Pi launch resources ---

/** Producer-supplied Pi runtime options, independent of the thread context. */
type PiLaunchConfigOverrides = Omit<
  PiLaunchConfig,
  "schemaVersion" | "memoryRecall"
>;

interface PreparedPiLaunchResources {
  readonly modelConfig: PiModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly sessionId: string;
}

function assemblePiLaunchResources(args: {
  readonly modelConfig: PiModelConfig;
  readonly piLaunchConfig: PiLaunchConfigOverrides | undefined;
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

// --- Private implementation: storage manifest ---

// Storage planning and explicit resource materialization.

type StorageManifestEntryKind = StorageManifestCacheEntryKind;

type StorageManifestCountBucket =
  (typeof STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS)[number];

interface PresignCandidateInput {
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number;
  readonly filename: string | undefined;
  readonly usePublicEndpoint: boolean;
}

interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: PersistedStorageMount["missingRootPolicy"];
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

interface PreparedStorageEntries<
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

interface ResolvedManifestArtifactInput {
  readonly artifact: ContextArtifact;
  readonly resolved: StorageResolution;
  readonly source: StorageManifestSource;
}

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

class StorageManifestBuildStats {
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

function knownArchiveSize(resolved: StorageResolution): number | undefined {
  return Number.isSafeInteger(resolved.archiveSize) && resolved.archiveSize > 0
    ? resolved.archiveSize
    : undefined;
}

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

async function finalizePreparedStorage<
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

// Execution context, launch preparation and pending atomic commit.

const AUTO_MEMORY_ARTIFACT_NAME = MEMORY_ARTIFACT_NAME;

/** Runner storage mount for one prepared exact execution storage mount. */
function storedMountFromPrepared(
  prepared: PreparedExecutionStorageMount,
  preserveExplicitMissingRootPolicy: boolean,
): StoredStorageMountEntry {
  const identity = {
    orgId: prepared.orgId,
    userId: prepared.userId,
    storageId: prepared.storageId,
    versionId: prepared.versionId,
    name: prepared.name,
    mountPath: prepared.mountPath,
  };
  if (prepared.writeback) {
    const policy = preserveExplicitMissingRootPolicy
      ? { missingRootPolicy: prepared.missingRootPolicy }
      : {};
    return prepared.empty
      ? { ...identity, writeback: true, empty: true, ...policy }
      : {
          ...identity,
          writeback: true,
          archiveUrl: prepared.archiveUrl,
          ...(prepared.archiveSize > 0
            ? { archiveSize: prepared.archiveSize }
            : {}),
          ...policy,
        };
  }
  return {
    ...identity,
    archiveUrl: prepared.archiveUrl,
    ...(prepared.archiveSize > 0 ? { archiveSize: prepared.archiveSize } : {}),
    ...(prepared.instructionsTargetFilename === undefined
      ? {}
      : { instructionsTargetFilename: prepared.instructionsTargetFilename }),
  };
}
// --- Private implementation: launch persistence ---

interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

type QueueFirstRunClaimed = Extract<
  QueueFirstRunClaimResult,
  { readonly kind: "claimed" }
>;

type CreateRunSuccessResult = {
  readonly status: 201;
  readonly body: CreateRunResponse;
  readonly queueFirstClaim?: QueueFirstRunClaimed;
  readonly pendingActivation?: PendingRunActivation;
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
  | (ApiErrorResponse<409, "CONFLICT"> & {
      /** Producer-facing classification; the HTTP response body is unchanged. */
      readonly admissionFailure?: "subscription_account_disconnected";
    })
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<402, "PRO_REQUIRED">
  | ApiErrorResponse<
      503,
      "PROVIDER_UNAVAILABLE" | "MODEL_PROVIDER_UNAVAILABLE"
    >;

type CreateRunErrorResult =
  Exclude<CreateRunRouteResult, { readonly status: 201 }> | ThreadModelError;

/** The model-selection facts of one run that its model environment reads. */
interface RunModelProviderArgs {
  /** The run's single catalog snapshot; every model decision reads it. */
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly codexServiceTier?: "fast";
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly queueFirstAssociation?: QueueFirstRunAssociation;
}

// Pending persistence uses connection-free SQL plans owned by one command.
function pendingLaunchCommitResult(
  args: PreparedCommitPreparedLaunchArgs,
  admission: AdmittedPreparedLaunch,
  persisted: PersistedAtomicLaunchRows,
): AtomicLaunchCommitResult {
  return {
    ...persisted,
    runnerJobPayload: args.persistence.payload,
    runContextSnapshot: args.launch.runContextSnapshot,
    queueFirstClaim: admission.queueFirstClaim,
  };
}

function tailFacts(
  args: PreparedCommitPreparedLaunchArgs,
  claim: PendingLaunchClaim | undefined,
  admission: AdmittedPreparedLaunch,
  persisted: PersistedAtomicLaunchRows,
): PendingLaunchTailInput {
  return {
    orgId: args.createArgs.orgId,
    userId: args.createArgs.userId,
    runId: persisted.run.id,
    sessionId: args.identity.sessionId,
    runCreatedAt: persisted.run.createdAt,
    snapshot: args.persistence.rows.rowsArgs.launchSnapshot,
    triggerSource: args.persistence.rows.metadata.triggerSource,
    chatThreadId: args.persistence.rows.metadata.chatThreadId,
    bindingThreadId: args.createArgs.chatThreadId,
    action: args.createArgs.threadSessionResolution?.action,
    // Memory flags are captured, not a launch-time transaction fence.
    requestMemory:
      Boolean(claim) &&
      isFeatureEnabled(FeatureSwitchKey.PiMemory, args.featureSwitchContext),
    threadAgentId:
      claim?.producer?.kind === "reassign-agent"
        ? claim.producer.expectedAgentId
        : args.context.resolved.agentId,
    threadBindingFencesOwnership:
      Boolean(admission.validatedThreadSession) &&
      admission.validatedThreadSession?.threadAgentId ===
        args.context.resolved.agentId &&
      claim?.producer?.kind !== "reassign-agent",
    needsBinding:
      Boolean(args.createArgs.chatThreadId) &&
      !admission.validatedThreadSession,
    binding: persisted.threadSessionBinding,
  };
}

function assertPendingLaunchClaim(
  args: PreparedCommitPreparedLaunchArgs,
  claim: PendingLaunchClaim | undefined,
) {
  if (
    claim &&
    (args.createArgs.orgId !== claim.orgId ||
      args.createArgs.chatThreadId !== claim.chatThreadId ||
      args.createArgs.queueFirstAssociation?.threadId !== claim.chatThreadId ||
      !args.createArgs.agentRunModelPin)
  ) {
    throw new Error(
      "Chat run commit requires its captured input association and model pin",
    );
  }
}

function pendingActiveRunInsertSql(
  args: CommitPreparedLaunchArgs,
  run: RunRecord,
) {
  return pendingLaunchInsertSql(activeAgentRuns, [
    pendingLaunchActiveRunValues(args, run),
  ]);
}

function pendingLaunchActiveRunValues(
  commit: CommitPreparedLaunchArgs,
  run: RunRecord,
) {
  return {
    runId: run.id,
    orgId: commit.createArgs.orgId,
    userId: commit.createArgs.userId,
    chatThreadId: commit.createArgs.chatThreadId ?? null,
    lastHeartbeatAt: run.createdAt,
  };
}

function preparedSessionUpdateStatements(
  commit: PreparedCommitPreparedLaunchArgs,
) {
  const resolution = commit.createArgs.threadSessionResolution;
  if (
    !resolution ||
    resolution.expected.sessionId === null ||
    (!resolution.resetNativeSession &&
      resolution.previousAgentId === commit.context.resolved.agentId)
  ) {
    return [];
  }
  return [
    pendingLaunchUpdateSql(
      agentSessions,
      {
        agentId: commit.context.resolved.agentId,
        ...(resolution.resetNativeSession
          ? {
              conversationId: null,
              storageMounts: [...commit.launch.sessionStorageMounts],
            }
          : {}),
      },
      eq(agentSessions.id, commit.identity.sessionId),
    ),
  ];
}

const pendingLaunchRowSchema = z.object({
  runId: z.string(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
  runnerJobCreatedAt: pgTimestampWithoutTimezoneToDateSchema,
  boundThreadId: z.string().nullable(),
  billingAttributionId: z.string().nullable(),
});

function pendingAtomicLaunchResult(
  args: AtomicLaunchRowsPlanArgs,
  context: AtomicLaunchCteContext,
  row:
    | {
        readonly runId: string;
        readonly createdAt: Date;
        readonly runnerJobCreatedAt: Date;
        readonly boundThreadId: string | null;
        readonly billingAttributionId: string | null;
      }
    | undefined,
) {
  if (row && context.updatedThread && !row.boundThreadId) {
    throw new ChatThreadBindingChanged();
  }
  if (!row) {
    throw new Error("Atomic pending launch persistence returned no row");
  }
  if (row.billingAttributionId !== row.runId) {
    throw new Error("New Run billing attribution conflicts with history");
  }
  const persisted: PersistedAtomicLaunchRows = {
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
  return { persisted };
}

function pendingAtomicLaunchPlan(
  args: AtomicLaunchRowsPlanArgs,
  context: AtomicLaunchCteContext,
) {
  const timestamps = runnerJobQueueTimestamps();
  const insertedQueue = new QueryBuilder()
    .$with("inserted_launch_runner_job", {
      runId: runnerJobQueue.runId,
      createdAt: runnerJobQueue.createdAt,
    })
    .as(
      pendingLaunchInsertSql(
        runnerJobQueue,
        [
          {
            runId: returnedCteId(context.insertedRun),
            runnerGroup: args.payload.runnerGroup,
            profile: args.payload.profile,
            cliAgentSessionId: args.payload.cliAgentSessionId,
            reuseKey: args.payload.reuseKey,
            executionContext: args.payload.executionContext,
            ...timestamps,
          },
        ],
        ["runId", "createdAt"],
      ),
    );
  const capture = billingRunAttributionWrite({
    id: context.rowsArgs.identity.runId,
    orgId: context.rowsArgs.orgId,
    userId: context.rowsArgs.userId,
    startedAt: context.createdAt.toISOString(),
    triggerSource: args.commit.persistence.rows.metadata.triggerSource,
    threadId: args.commit.persistence.rows.metadata.chatThreadId,
  });
  const attribution = new QueryBuilder()
    .$with("inserted_launch_billing_attribution", {
      runId: billingRunAttribution.runId,
    })
    .as(
      pendingLaunchBillingAttributionSql(
        capture,
        returnedCteId(context.insertedRun),
      ),
    );
  const ctes = [...context.ctes, insertedQueue, attribution];
  if (context.updatedThread) {
    ctes.push(context.updatedThread);
  }
  return new QueryBuilder()
    .with(...ctes)
    .select({
      billingAttributionId:
        sql`(SELECT ${attribution.runId} FROM ${attribution})`
          .mapWith(nullableDriverValueDecoder(billingRunAttribution.runId))
          .as("billingAttributionId"),
      runId: returnedCteColumn(context.insertedRun, "id")
        .mapWith(agentRuns.id)
        .as("runId"),
      createdAt: returnedCteColumn(context.insertedRun, "created_at")
        .mapWith(agentRuns.createdAt)
        .as("createdAt"),
      runnerJobCreatedAt: returnedCteColumn(insertedQueue, "created_at")
        .mapWith(runnerJobQueue.createdAt)
        .as("runnerJobCreatedAt"),
      boundThreadId: nullableReturnedCteId(context.updatedThread)
        .mapWith(nullableDriverValueDecoder(pgTextDecoder))
        .as("boundThreadId"),
    })
    .from(context.insertedRun)
    .innerJoin(
      insertedQueue,
      eq(
        returnedCteColumn(insertedQueue, "run_id"),
        returnedCteColumn(context.insertedRun, "id"),
      ),
    )
    .getSQL();
}

function returnedCteColumn(cte: WithSubquery, name: string): SQL {
  return sql`${sql.identifier(cte._.alias)}.${sql.identifier(name)}`;
}

function pendingLaunchRowsPlan(
  commit: PreparedCommitPreparedLaunchArgs,
  admission: ValidatedPreparedLaunchAdmission,
  capabilities: OrgPlanCapabilities | null,
) {
  const creditAdmitted =
    commit.enforceBuiltInCredits &&
    isFreePlanForCreditAdmission(capabilities?.planKey);
  const rows = { commit, payload: commit.persistence.payload, ...admission };
  const context = buildAtomicLaunchCteContext(rows, creditAdmitted);
  return {
    rows,
    context,
  };
}

export const commitPreparedPendingLaunch$ = command(
  async (
    { set },
    args: PreparedCommitPreparedLaunchArgs,
    claim: PendingLaunchClaim | undefined,
    signal: AbortSignal,
  ): Promise<AtomicLaunchCommitAttempt> => {
    signal.throwIfAborted();
    const { admissionTiming, timing } = args;
    assertPendingLaunchClaim(args, claim);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0263; new non-billing transactions are prohibited.
    return await set(writeDb$).transaction(
      async (tx): Promise<AtomicLaunchCommitAttempt> => {
        admissionTiming.transactionStarted();
        let admission = pendingOfficialAdmissionStart(args);
        if (!args.context.officialWorkflowRun) {
          admissionTiming.admissionStarted();
        }
        while ("kind" in admission && admission.kind === "statement") {
          const step = admission;
          if (step.phase === "installation") {
            admissionTiming.admissionStarted();
          }
          const rows = parseRawRows(admissionRow, await tx.execute(step.sql));
          signal.throwIfAborted();
          admission = advancePendingOfficialAdmission(args, step, rows);
        }
        if (!("kind" in admission) || admission.kind !== "admitted") {
          admissionTiming.callbackFinished();
          return admission;
        }
        // Release only this token, after the queue-head input claim succeeded.
        if (claim) {
          requirePendingLaunchClaimFence(
            (await tx.execute(pendingLaunchClaimFenceSql(claim))).rowCount,
          );
        }
        const persisted = await admissionTiming.measureLeaf(
          "persistence",
          async () => {
            // The approved S1 snapshot also drives the persisted admission bit;
            // account/session/queue authority is still checked by this writer.
            const capabilities = args.planCapabilities;
            signal.throwIfAborted();
            for (const update of preparedSessionUpdateStatements(args)) {
              await tx.execute(update);
            }
            const prepared = pendingLaunchRowsPlan(
              args,
              admission,
              capabilities,
            );
            const rowsPersisted = await timing.measure(
              "api_dispatch_persist_atomic_launch",
              "nested",
              async () => {
                const { rows, context } = prepared;
                const plan = pendingAtomicLaunchPlan(rows, context);
                const [row] = parseRawRows(
                  pendingLaunchRowSchema,
                  await tx.execute(plan),
                );
                return pendingAtomicLaunchResult(rows, context, row).persisted;
              },
            );
            if (claim) {
              for (const statement of pendingLaunchClaimProducerStatements(
                claim.producer,
                rowsPersisted.run.id,
              )) {
                await tx.execute(statement);
              }
            }
            const input = tailFacts(args, claim, admission, rowsPersisted);
            let tail = pendingLaunchTailStart(input);
            while (tail.kind === "statement") {
              const step = tail;
              const rows = parseRawRows(tailRow, await tx.execute(step.sql));
              signal.throwIfAborted();
              tail = advancePendingLaunchTail(input, step, rows);
            }
            return { ...rowsPersisted, threadSessionBinding: tail.binding };
          },
        );
        // Keep this unique insertion last: do not acquire another row after it.
        await tx.execute(pendingActiveRunInsertSql(args, persisted.run));
        signal.throwIfAborted();
        admissionTiming.callbackFinished();
        return pendingLaunchCommitResult(args, admission, persisted);
      },
    );
    // The caller records the durable receipt before observing cancellation.
  },
);
