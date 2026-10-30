import { performance } from "node:perf_hooks";
import { captureInvokedWorkflow$ } from "./execution-agent-workflows.service";
import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  DEFAULT_PROFILE,
  type PiLaunchConfig,
  type PiModelConfig,
  type SecretConnectorMetadata,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  autoRunBillingProvider,
  autoRunPricingLongContextMinTotalInputTokens,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import {
  type ConnectorScopeSource,
  type EffectiveConnectorScope,
  isEmptyRunConnectorScope,
  type RunConnectorCatalogSelection,
  runConnectorCatalogSelection,
} from "./thread-connected-accounts.signals";
import {
  pendingOkouTokenSecrets,
  withoutLegacyAgentRunEnvironmentEntries,
} from "./run-body-environment";
import { createThreadContext } from "./thread-context.signals";
import { revokeDeletedWorkflowAutomationInputs$ } from "./workflow-automation-queue-revocation.service";
import {
  createOkouTokenInputSignals,
  prepareOkouTokenEnvironment$,
} from "./thread-okou-token.signals";
import { createEnvironmentSignals } from "./thread-environment.signals";
import {
  emptyEnvironment,
  type Environment,
  environmentPermissionManifest,
  mergeEnvironments,
} from "./run-environment";
import { createOfficialWorkflowSignals } from "./thread-official-workflow.signals";
import { proactiveWorkflowKind } from "./proactive-workflow-definitions";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";
import type {
  ThreadModelError,
  ThreadModelSelection,
} from "./thread-model.signals";
import type {
  FeishuThreadContext,
  SlackThreadContext,
  TeamsThreadContext,
  TelegramThreadContext,
} from "./thread-run-context.service";
import {
  createPromptAndSkillVolumesSignals,
  type PromptAndSkillVolumes,
  PromptAndSkillVolumesError,
} from "./thread-run-prompt/prompt-and-skill-volumes";
import { createChatRunPreparationSnapshot } from "./chat-run-preparation-snapshot.signals";

import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import {
  withPgPoolAcquisitionCapture,
  withPgQueryExecutionCapture,
  type PgPoolAcquisitionCapture,
  type PgQueryExecutionCapture,
} from "../../lib/db-instrumentation";
import { env, optionalEnv } from "../../lib/env";
import {
  AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";

import { monotonicNow, now, nowDate, nowDateSql } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishDesktopShellAuthorizationChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";

import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import { onRejection, safeSync, settle, tapError } from "../utils";
import type { AgentConnectorScopeSnapshot } from "./agent-connector-scope.service";
import { activatePendingRun$ as activateCommittedRun$ } from "./agent-run-activation.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type {
  AgentRunModelPin,
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
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
import {
  canonicalChatEventInputCtes,
  canonicalChatEventInsertSql,
  type PreparedChatEventRow,
} from "./chat-event-append.service";
import { recordThreadRunActivationMarkers } from "./chat-first-assistant-event-metric.service";
import type {
  QueuedUserMessage,
  QueuedUserMessageContextType,
  QueueFirstRunAssociation,
  QueueFirstRunClaimResult,
} from "./chat-queued-event.service";
import { finalizeClaimedRunUserMessage } from "./chat-run-event.service";
import { randomUUID } from "node:crypto";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import { agents } from "@okouai/db/schema/agent";
import {
  type ExecutionCallback,
  prepareCallbacks$ as prepareExecutionCallbacks$,
} from "./execution-callbacks.service";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import { updateExecutionStoragePresignedUrlCache$ } from "./execution-storage.service";
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
  queuedMessageRejection,
  type QueuedPromptLaunchContext,
  type QueuedRunAdmissionFailureInput,
  recordQueuedPromptRunLaunch$,
  rejectedQueuedRunAdmissionFailure,
} from "./internal-chat-run-callback.service";
import type { ModelCatalog } from "./model-catalog.service";
import { morningBriefScheduleClaimBound$ } from "./morning-brief-schedule-claim.service";
import {
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowRunObservation,
} from "./official-workflow-run.service";
import { pendingLaunchBillingAttributionSql } from "./pending-launch-billing-plan";
import {
  type PendingLaunchClaim,
  pendingLaunchClaimFenceSql,
  pendingLaunchClaimProducerStatements,
} from "./pending-launch-claim-plan";
import { pendingOfficialAdmissionGuardSql } from "./pending-launch-official-plan";
import {
  pendingAdmissionRecordSchema as admissionRow,
  advancePendingLaunchAdmission,
  pendingLaunchAdmissionStart,
} from "./pending-launch-admission-plan";
import { pendingLaunchInsertSql } from "./pending-launch-sql";
import {
  type PiModelPreparationInput,
  resolvePreparedPiModelConfig,
} from "./pi-sandbox-config";
import {
  checkCatalogRunRoute,
  checkOrgPlanRunAdmission,
  type RunAdmissionInput,
} from "./run-admission.service";

import { agentphoneDeliveryTargetSchema } from "./agentphone-chat-callback-payload";

import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { maxAutonomyBudget$ } from "../autonomy-budget-limit";
import { childAutonomyBudget } from "./autonomy-budget.service";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
  parseCanonicalChatEventRequiredOfficialWorkflowIds,
} from "./canonical-chat-event-read.service";
import {
  prepareChatEvent,
  prepareChatEventReplacement,
} from "./chat-event.service";
import { chatInputEnqueueCommits$ } from "./chat-input-enqueue-observation";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";
import type {
  ChatThreadExecutionSnapshot,
  ChatThreadContinuation,
} from "./chat-session-continuity.service";
import { compactRecord } from "./connector-runtime-preparation.service";

import { DiscordQueuedLaunchUnavailableError } from "./discord-queued-launch-context.service";
import { WechatLaunchUnavailableError } from "./wechat-context.service";
import { isMemberSubscriptionRoute } from "./effective-model-route.service";

import { recordGetStartedWorkflowSql } from "./get-started-workflow.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";

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
import { runCreateBodySchema } from "@okouai/api-contracts/contracts/run-routes";
import {
  type CreateRunResponse,
  type RunStatus,
  unifiedRunRequestSchema,
} from "@okouai/api-contracts/contracts/runs";
import type { FirewallPolicies } from "@okouai/connectors/firewall-types";
import {
  type FeatureSwitchContext,
  getAllFeatureStates,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import type { SupportedFramework } from "@okouai/core/frameworks";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { isStaffOrg } from "@okouai/core/staff-org";
import type {
  AgentRunFullLaunchSnapshot,
  AgentRunLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";

import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";

import { chatEvents } from "@okouai/db/schema/chat-event";

import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";

import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";

import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import type { PersistedStorageMount } from "@okouai/db/types";
import { command, type Command, computed, type Computed, state } from "ccstate";
import {
  and,
  count,
  eq,
  exists,
  TransactionRollbackError,
  DrizzleQueryError,
  isNotNull,
  sql,
  type SQL,
  type SQLWrapper,
  type WithSubquery,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  boolean,
  discriminatedUnion,
  json,
  literal,
  object,
  strictObject,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  normalizeRunMetadata,
  type RunMetadataValues,
} from "./agent-run-metadata-write.service";
import type { ChatThreadRequestFacts } from "./chat-thread-request-facts";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE } from "./official-workflow-policy.service";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import { isPersonalSubscriptionProviderType } from "./model-provider-account.service";
import { modelProviderWriteTypeForLaunch } from "./model-selection.service";
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

import { teamsDeliveryTargetSchema } from "./teams-chat-callback-payload";

import { telegramDeliveryTargetSchema } from "./telegram-chat-callback-payload";

import { isWebChatContextId } from "./web-chat-queue-context.service";

import {
  EVENT_POLICY,
  type WorkflowAutomationEventType,
  restoredWorkflowAutomationEventPayload,
  type WorkflowAutomationEventPayload,
  workflowAutomationEventTypeSchema,
} from "./workflow-automation-context.service";
import {
  AutomationRow,
  DueWorkflowAutomation,
} from "./workflow-automation-enqueue.service";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import { recordWorkflowAdmissionDuration } from "./workflow-queue-admission-timing.service";
import {
  type AdditionalVolumeSources,
  type AgentRunCreateAdditionalVolume,
  type MaterializedAgentRunStorage,
  OfficialWorkflowArtifactResolutionError,
  type PreparedAgentRunStorage,
  prepareRunOutputMetadata,
  type ResolvedAgentExecution,
  type ResolvedRunExecution,
  StorageManifestBuildStats,
} from "./run-storage-manifest.service";
import { createStorageSignals, type Storage } from "./thread-storage.signals";
import { settleRejectedAutomationInput$ } from "./workflow-schedule-failure.service";

export interface ThreadClaim {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly claimId: string;
}

const queueHeadRejectionResultSchema = strictObject({
  rejected: boolean(),
  assistantEventId: uuid().nullable(),
});
const queueRejectionLeaseFailureSchema = object({
  code: literal("23502"),
  table: literal("chat_events"),
  column: literal("chat_thread_id"),
});

function queueRejectionLeaseCte(lease: ThreadClaim | undefined): SQL {
  if (!lease) {
    return sql`rejection_lease AS (SELECT true AS released)`;
  }
  return sql`rejection_lease AS (
    UPDATE ${queuedChatThreads} SET claim_id = NULL, claim_expires_at = NULL
    WHERE ${and(
      eq(queuedChatThreads.orgId, lease.orgId),
      eq(queuedChatThreads.chatThreadId, lease.chatThreadId),
      eq(queuedChatThreads.claimId, lease.claimId),
    )} AND (SELECT ${count()} FROM reserved) >= 0
    RETURNING true AS released
  )`;
}

function queueRejectionSortCtes(eventId: string): SQL {
  return sql`thread_reserved AS (
    INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
    SELECT touched.user_id,
      (SELECT ${agents.orgId} FROM ${agents} WHERE ${eq(agents.id, sql`touched.agent_id`)}), 1
    FROM touched
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + 1
    RETURNING user_id, org_id, last_seq_id
  ), sort_inserted AS (
    INSERT INTO ${chatThreadEvents}
      (id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
       cloud_browser_enabled, created_at)
    SELECT ${eventId}::uuid, thread_reserved.user_id, thread_reserved.org_id,
      thread_reserved.last_seq_id, touched.id, 'sort_touched', touched.agent_id,
      false, date_trunc('milliseconds', touched.last_message_at)
    FROM touched CROSS JOIN thread_reserved
    ON CONFLICT (id) DO NOTHING RETURNING id
  )`;
}

function queueHeadRejectionSql(args: {
  readonly events: readonly [PreparedChatEventRow, PreparedChatEventRow];
  readonly threadId: string;
  readonly lease: ThreadClaim | undefined;
}): SQL {
  // Keep the event sequence as the first lock. A lost existing lease fails
  // the rejected event's required thread identity, rolling back reservation
  // and lease changes together. The lease UPDATE moves before event writes.
  const rejection = canonicalChatEventInsertSql("any", {
    eligibility: eq(sql`input.ordinal`, 0),
    sequenceOffset: sql`input.ordinal + 1`,
    threadIdentity: sql`CASE WHEN EXISTS (SELECT 1 FROM rejection_lease)
      THEN input."chatThreadId" ELSE NULL END`,
  });
  const assistant = canonicalChatEventInsertSql("none", {
    eligibility: and(
      eq(sql`input.ordinal`, 1),
      exists(sql`(SELECT 1 FROM rejected)`),
    ),
    sequenceOffset: sql`input.ordinal + 1`,
  });
  return sql`WITH ${canonicalChatEventInputCtes(args.events)},
    ${queueRejectionLeaseCte(args.lease)},
    rejected AS (${rejection}), assistant AS (${assistant}),
    touched AS (
      UPDATE ${chatThreads}
      SET last_message_at = GREATEST(${chatThreads.lastMessageAt}, assistant.created_at)
      FROM assistant
      WHERE ${and(eq(chatThreads.id, args.threadId), isNotNull(chatThreads.agentId))}
      RETURNING ${chatThreads.id} AS id, ${chatThreads.userId} AS user_id,
        ${chatThreads.agentId} AS agent_id, ${chatThreads.lastMessageAt} AS last_message_at
    ), ${queueRejectionSortCtes(randomUUID())}
    SELECT ${exists(sql`(SELECT 1 FROM rejected)`)} AS rejected,
      (SELECT id FROM assistant) AS "assistantEventId"`;
}

interface QueuedPromptGraphInput {
  readonly head: ChatQueueHeadContext;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly runTiming: ApiDispatchTimingCollector;
}

class QueuedPromptInputInvalidError extends Error {}

function assertQueuedPromptContext(args: {
  readonly contextType: QueuedUserMessageContextType;
  readonly contextId: string | null;
  readonly requiredOfficialWorkflowIds: readonly string[] | null;
}): void {
  if (args.requiredOfficialWorkflowIds !== null) {
    throw new QueuedPromptLaunchUnavailableError(
      OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE,
    );
  }
  const hasWebContextId = isWebChatContextId(args.contextId);
  if (args.contextType === "web" && !hasWebContextId) {
    throw new QueuedPromptInputInvalidError("Invalid Web chat context");
  }
  if (args.contextType === "agent_run" && hasWebContextId) {
    throw new QueuedPromptInputInvalidError("Invalid Agent Run chat context");
  }
}

function queuedUserMessageAutonomyBudget(
  contextType: QueuedUserMessageContextType,
  sourceAutonomyBudget: number | null,
  maxAutonomyBudget: number,
): QueuedUserMessage["autonomyBudget"] {
  if (contextType !== "agent_run") {
    return { kind: "ok", autonomyBudget: maxAutonomyBudget };
  }
  if (sourceAutonomyBudget === null) {
    return {
      kind: "unavailable",
      message: "Agent source run no longer exists",
    };
  }
  return childAutonomyBudget(sourceAutonomyBudget);
}

function queuedSlackDelivery(context: NonNullable<SlackThreadContext>) {
  return {
    workspaceId: context.workspaceId ?? undefined,
    channelId: context.channelId,
    threadTs: context.threadTs,
    ...(context.routeThreadTs ? { routeThreadTs: context.routeThreadTs } : {}),
  };
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
  constructor(message = "This conversation is no longer available.") {
    super(message);
    this.name = "QueuedPromptLaunchUnavailableError";
  }
}

function queuedPromptRunInput(args: {
  readonly input: CreateQueuedChatRunInputArgs;
  readonly launch: QueuedLaunchMaterial;
  readonly promptAndSkills: PromptAndSkillVolumes;
  readonly model: ThreadModelSelection;
  readonly session: ChatThreadContinuation;
  readonly host: CreateQueuedChatRunInput["computerUseHostGrant"];
  readonly capture: boolean;
  readonly features: FeatureSwitchContext;
}): CreateQueuedChatRunInput {
  const { input, launch, model } = args;
  if (input.queuedMessage.autonomyBudget.kind !== "ok") {
    throw new Error("Rejected autonomy input cannot become a run");
  }
  return {
    orgId: input.agent.orgId,
    userId: input.userId,
    agentId: input.agent.id,
    threadContinuation: args.session,
    featureSwitchContext: args.features,
    prompt: args.promptAndSkills.userPrompt,
    threadId: input.threadId,
    queuedMessage: input.queuedMessage,
    requiredOfficialWorkflowIds:
      input.queuedMessage.requiredOfficialWorkflowIds,
    modelPin: {
      modelProviderId: model.agentRunModelPin.modelProviderId,
      modelProviderType: model.agentRunModelPin.modelProvider,
      modelProviderCredentialScope:
        model.agentRunModelPin.modelProviderCredentialScope,
      selectedModel: model.selectedModelOverride,
    },
    effectiveModelProvider: model.modelProviderType,
    builtInModelRuntimeRoute: model.builtInModelRuntimeRoute,
    cliAgentType: model.cliAgentType,
    piExecution: model.piExecution,
    codexServiceTier: model.codexServiceTier,
    reasoningEffort: model.reasoningEffort,
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

/** Run command model fields, as selected for the picked event. */
function threadRunModelFields(model: ThreadModelSelection) {
  return {
    agentRunModelPin: model.agentRunModelPin,
    modelProviderId: model.modelProviderId,
    modelProviderCredentialScope: model.modelProviderCredentialScope,
    selectedModelOverride: model.selectedModelOverride,
    builtInModelRuntimeRoute: model.builtInModelRuntimeRoute,
    codexServiceTier: model.codexServiceTier,
    piExecution: model.piExecution,
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
    !(error instanceof WechatLaunchUnavailableError) &&
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
      eventType,
    ),
    ...EVENT_POLICY[eventType],
    ...(eventType === "manual" &&
    ["learning", "planning"].includes(
      proactiveWorkflowKind(args.workflowName) ?? "",
    )
      ? { recordLastRunId: false, recordLastRunAt: false }
      : {}),
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

interface AssembledWorkflowAutomationRun {
  readonly kind: "assembled";
  readonly run: ClaimQueueRunCommandArgs;
  readonly producerBinding: Extract<
    ClaimProducerBinding,
    { kind: "automation" }
  >;
  readonly launchRecord: Extract<ClaimLaunchRecord, { kind: "automation" }>;
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
  model: ThreadModelSelection,
  identity: {
    readonly timing: ApiDispatchTimingCollector;
    readonly owner: { readonly orgId: string; readonly userId: string };
    readonly agentId: string;
  },
): ThreadRunSelection &
  Pick<
    ThreadRunCommand,
    "chatThreadId" | "queueFirstAssociation" | "agentRunModelPin"
  > {
  const { automation, chatThreadId } = args.due;
  const { timing } = identity;
  return {
    owner: identity.owner,
    body: {
      agentId: identity.agentId,
      ...workflowModelProviderBody(model.modelProviderType),
    },
    apiStartTime: args.apiStartTime,
    triggerSource: args.triggerSource ?? "automation-schedule",
    chatThreadId,
    connectorSourceId: args.connectorSourceId,
    ...threadRunModelFields(model),
    reasoningEffort: model.reasoningEffort ?? null,
    ...(automation.officialBlueprintKey === null
      ? {}
      : { requiredOfficialWorkflowIds: [automation.workflowId] }),
    queueFirstAssociation: {
      threadId: chatThreadId,
      eventId: args.queueEventId,
    },
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
type ThreadRunnerFacts = Omit<
  BuildRunnerJobPayloadInput,
  "run" | "timing" | "workflowAutomationId"
>;

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
    threadContinuation: args.threadContinuation
      ? {
          expected: args.threadContinuation.expected,
          admission: args.threadContinuation.admission,
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

type ClaimProducerBinding = {
  readonly kind: "automation";
  readonly queueEventId: string;
} | null;

type ClaimQueueRunCommandArgs = ThreadRunCommand;

type ClaimRejectionContext =
  | { readonly kind: "prompt"; readonly runInput: CreateQueuedChatRunInput }
  | { readonly kind: "automation"; readonly userId: string };

/** Queued prompt data with this preparation's timing. */
interface CreateQueuedChatRunInputArgs extends QueuedChatPromptData {
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
  eventType: WorkflowAutomationEventType,
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  // Debug adds one delivery and never settles the daily schedule occurrence.
  const nightlyManual =
    eventType === "manual" &&
    (automation.officialBlueprintKey === "nightly-learning" ||
      automation.officialBlueprintKey === "nightly-planning");
  if (
    automation.kind === "schedule" &&
    eventType !== "morning-brief-debug" &&
    !nightlyManual
  ) {
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
      wechatDelivery: input.wechatDelivery,
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
  readonly orgHasCapacity$: Computed<Promise<boolean>>;
  readonly startRun$: Command<Promise<string | null>, [signal: AbortSignal]>;
}

/** The admission input with the instant its reads are taken. */
export function createThreadClaimRunObjects(
  claim: ThreadClaim,
  bootstrap: AgentRunContextSignals,
  requestFacts?: ChatThreadRequestFacts,
): ThreadClaimRunObjects {
  // Re-resolve the queued pin against one current catalog snapshot per claim.
  const claimCatalog$ = bootstrap.modelCatalog$;
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
        const requestReceivedAt =
          requestFacts?.input.id === head.id
            ? requestFacts.input.requestReceivedAt
            : undefined;
        if (requestReceivedAt !== undefined) {
          timing.recordDuration(
            "api_dispatch_request_received_to_enqueue_commit",
            "top_level",
            committedAt - requestReceivedAt,
            committedAt,
            { capture_scope: "request_observed_commit" },
          );
        }
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

  const preparation$ = createChatRunPreparationSnapshot(
    claim,
    bootstrap,
    requestFacts,
  );
  const orgHasCapacity$ = computed(async (get) => {
    return (await get(preparation$)).hasCapacity;
  });
  const pickedEvent$ = computed(async (get) => {
    return (await get(preparation$)).pickedEvent;
  });
  const threadContext = createThreadContext(bootstrap, pickedEvent$);
  const okouTokenInput$ = createOkouTokenInputSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
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
  // Runner and guest `api_to_*` rows start at `POST /api/chat/events` receipt,
  // and only for the input that request committed and then picked itself.
  // Any other pick (queued behind a run, cron, slot release, other producers)
  // carries no API start time, so those rows are not emitted for it.
  const runnerApiStartTime$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    return event && requestFacts?.input.id === event.id
      ? requestFacts.input.requestReceivedAt
      : undefined;
  });
  // Generated once per claim graph; read after authorization admits the head.
  const runIds$ = threadContext.runIds$;
  const head$ = computed(async (get): Promise<ChatQueueHeadContext> => {
    const event = await get(pickedEvent$);
    if (!event) {
      throw new Error("Claim has no picked event");
    }
    return {
      id: event.id,
      chatThreadId: event.chatThreadId,
      orgId: bootstrap.orgId,
      apiStartTime: get(pickStartedAt$),
      contextType: event.contextType,
      contextId: event.contextId,
      userId: bootstrap.userId,
      agentId: bootstrap.agentId,
    };
  });
  const promptInputInput$ = computed(
    async (get): Promise<QueuedPromptGraphInput> => {
      const head = await get(head$);
      return {
        head,
        timing: get(promptTiming$),
        runTiming: get(claimRunTiming$).run,
      };
    },
  );
  const promptQueuedEventQueuedEvent$ = computed(async (get) => {
    // The picked head already excludes consumed and revoked inputs.
    const picked = await get(pickedEvent$);
    const event = picked?.eventType === "input.prompt" ? picked : null;
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
    assertQueuedPromptContext({
      contextType: event.contextType,
      contextId: event.contextId,
      requiredOfficialWorkflowIds,
    });
    return {
      ...event,
      userMessage: event.userMessage,
      contextType: event.contextType,
      requiredOfficialWorkflowIds,
    };
  });
  const promptSourceAutonomyBudgetSourceAutonomyBudget$ = computed(
    async (get) => {
      const event = await get(promptQueuedEventQueuedEvent$);
      if (!event) {
        return null;
      }
      return event.sourceAutonomyBudget;
    },
  );
  const isOfficialQueuedPrompt$ = computed(async (get) => {
    const event = await get(promptQueuedEventQueuedEvent$);
    if (!event) {
      return false;
    }
    return event.preparation.isOfficialWorkflowThread;
  });
  const promptQueuedMessageQueuedMessage$ = computed(
    async (get): Promise<QueuedUserMessage | null> => {
      const [event, sourceBudget] = await Promise.all([
        get(promptQueuedEventQueuedEvent$),
        get(promptSourceAutonomyBudgetSourceAutonomyBudget$),
      ]);
      if (!event) {
        return null;
      }
      if (await get(isOfficialQueuedPrompt$)) {
        throw new QueuedPromptLaunchUnavailableError(
          OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE,
        );
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
          get(maxAutonomyBudget$),
        ),
      };
    },
  );
  const promptArgsArgs$ = computed(
    async (get): Promise<CreateQueuedChatRunInputArgs> => {
      const { head, timing } = await get(promptInputInput$);
      // Preserve runtime DB acquisition without carrying its handle onward.
      get(db$);
      const queuedMessage = await get(promptQueuedMessageQueuedMessage$);
      if (!queuedMessage || queuedMessage.id !== head.id) {
        throw new Error("Prompt preparation lost its selected head");
      }
      return {
        threadId: head.chatThreadId,
        userId: bootstrap.userId,
        agent: { id: bootstrap.agentId, orgId: bootstrap.orgId },
        queuedMessage,
        timing,
      };
    },
  );
  const wechatPromptMaterial$ = computed(
    async (get): Promise<QueuedLaunchMaterial> => {
      const context = await get(threadContext.wechatContext$);
      if (!context) {
        throw new WechatLaunchUnavailableError();
      }
      return {
        triggerSource: "wechat",
        delivery: { wechatDelivery: context.wechatDelivery },
      };
    },
  );
  const discordPromptMaterial$ = computed(
    async (get): Promise<QueuedLaunchMaterial> => {
      const context = await get(discordContext$);
      if (!context) {
        throw new DiscordQueuedLaunchUnavailableError();
      }
      return {
        triggerSource: "discord",
        delivery: { discordDelivery: context.target },
      };
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
              slackDelivery: queuedSlackDelivery(context),
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
        case "wechat": {
          return await get(wechatPromptMaterial$);
        }
        case "discord": {
          return await get(discordPromptMaterial$);
        }
        case "automation": {
          throw new Error("Automation cannot enter the prompt assembler");
        }
      }
      throw new QueuedPromptLaunchUnavailableError();
    },
  );
  const promptContinuation$ = threadContext.threadContinuation$;
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
          get(threadContext.modelSelection$),
          get(promptContinuation$),
          get(promptHostHost$),
          get(promptCaptureCapture$),
          get(bootstrap.featureSwitches$),
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
      if ("status" in model) {
        return queuedMessageAdmissionFailure(args, launch, model.body.error);
      }
      if ("error" in templates) {
        return queuedMessageAdmissionFailure(args, launch, templates.error);
      }
      const officialWorkflow = await get(officialWorkflow$);
      if (isRouteError(officialWorkflow)) {
        return queuedMessageAdmissionFailure(
          args,
          launch,
          officialWorkflow.body.error,
        );
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
  const internalEarlyAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly | null> => {
      const head = await get(head$);
      const selected = await settle(get(promptQueuedMessageQueuedMessage$));
      if (!selected.ok) {
        return queuedPromptPreparationRejection(selected.error, head);
      }
      return selected.value?.id === head.id ? null : { kind: "not-ready" };
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
        (async () => {
          const startedAt = now();
          const result = await onRejection(
            (async () => {
              return await get(promptRunInputRunInput$);
            })(),
            () => {
              timing.recordElapsed({
                actionType:
                  "api_dispatch_pre_create_agent_chat_callback_auto_send_build_input",
                spanKind: "top_level",
                startedAt,
              });
            },
          );
          timing.recordElapsed({
            actionType:
              "api_dispatch_pre_create_agent_chat_callback_auto_send_build_input",
            spanKind: "top_level",
            startedAt,
          });
          return result;
        })(),
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
      return {
        kind: "assembled",
        run: {
          ...buildQueuedRunCommand(runInput, head.apiStartTime),
          timing: input.runTiming,
        },
        producerBinding: null,
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
    // Preserve this node's existing DB dependency and initialization boundary.
    get(db$);
    const args = await get(promptArgsArgs$);
    return {
      timing,
      owner: { userId: args.userId, orgId: args.agent.orgId },
      apiStartTime: head.apiStartTime,
      agentId: args.agent.id,
      chatThreadId: args.threadId,
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
      get(threadContext.modelSelection$),
    ]);
    if ("status" in model || args.queuedMessage.autonomyBudget.kind !== "ok") {
      return null;
    }
    return {
      timing: identity.timing,
      command: {
        owner: identity.owner,
        apiStartTime: identity.apiStartTime,
        body: {
          agentId: identity.agentId,
          ...workflowModelProviderBody(model.modelProviderType),
        },
        chatThreadId: args.threadId,
        queueFirstAssociation: identity.queueFirstAssociation,
        ...threadRunModelFields(model),
        reasoningEffort: model.reasoningEffort,
        requiredOfficialWorkflowIds:
          args.queuedMessage.requiredOfficialWorkflowIds,
        timing: identity.timing,
      },
    };
  });
  const promptExecutionResourcesContinuation$ = computed(async (get) => {
    if (await get(internalEarlyAssembly$)) {
      return undefined;
    }
    return (await get(promptContinuation$)) ?? undefined;
  });
  const command$ = computed(async (get) => {
    const assembly = await get(promptAssembleQueuedPromptRunAssembly$);
    return assembly.kind === "assembled" ? assembly.run : null;
  });
  const promptExecutionResourcesFeatureSwitchContext$ = computed(
    async (get) => {
      return (await get(internalEarlyAssembly$))
        ? undefined
        : await get(bootstrap.featureSwitches$);
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
  const target$ = threadContext.automationTarget$;
  const queuedAutomationBudgetSourceAutonomyBudget$ = computed(async (get) => {
    const event = await get(event$);
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
        get(event$),
        get(target$),
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
  const launchMaterial$ = computed(async (get) => {
    const [event, target] = await Promise.all([get(event$), get(target$)]);
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
  const recordQueuedWorkflowReward$ = command(
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
  const timing$ = computed((get) => {
    return get(claimRunTiming$).run;
  });
  const workflowAutomationLaunchModel$ = computed(
    async (get): Promise<ThreadModelSelection | RunFailure> => {
      if (!(await get(automationExecutionInput$))) {
        return {
          kind: "conflict",
          message: "Workflow automation no longer exists",
        };
      }
      const model = await get(threadContext.modelSelection$);
      return "status" in model
        ? {
            kind: "run_error",
            response: { status: model.status, body: model.body },
          }
        : model;
    },
  );
  const automationExecutionInput$ = computed(async (get) => {
    const [head, event, target] = await Promise.all([
      get(head$),
      get(event$),
      get(target$),
    ]);
    if (!event || !target) {
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
  const workflowAutomationLaunchIdentityInput$ = computed(async (get) => {
    const args = await get(automationExecutionInput$);
    if (!args) {
      return null;
    }
    return {
      timing: get(timing$),
      owner: { orgId: bootstrap.orgId, userId: bootstrap.userId },
      apiStartTime: args.apiStartTime,
      agentId: bootstrap.agentId,
      chatThreadId: args.due.chatThreadId,
      queueFirstAssociation: {
        threadId: args.due.chatThreadId,
        eventId: args.queueEventId,
      },
    };
  });
  const workflowAutomationLaunchSelectionInput$ = computed(async (get) => {
    const [identity, model, args] = await Promise.all([
      get(workflowAutomationLaunchIdentityInput$),
      get(workflowAutomationLaunchModel$),
      get(automationExecutionInput$),
    ]);
    return identity && !("kind" in model) && args
      ? {
          timing: identity.timing,
          command: automationSelectionCommand(args, model, identity),
        }
      : null;
  });
  const assembleWorkflowAutomationRun$ = computed(
    async (get): Promise<AssembledWorkflowAutomationRun | RunFailure> => {
      const args = await get(automationLaunchReadinessInput$);
      const [selection, model, computerUseHostGrant] = await Promise.all([
        get(workflowAutomationLaunchSelectionInput$),
        get(workflowAutomationLaunchModel$),
        get(threadContext.computerUseHostGrant$),
      ]);
      if ("kind" in model) {
        return model;
      }
      const officialWorkflow = await get(officialWorkflow$);
      if (isRouteError(officialWorkflow)) {
        return { kind: "run_error", response: officialWorkflow };
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
          computerUseHostId: computerUseHostGrant?.hostId,
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
  // A head whose automation input can no longer be read is rejected from its
  // captured reads.
  const queuedAutomationAssemblerInternalEarlyAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly | null> => {
      if (await get(automationExecutionInput$)) {
        return null;
      }
      const head = await get(head$);
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
        get(event$),
        get(target$),
        get(queuedAutomationBudgetSourceAutonomyBudget$),
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
      if (
        loadedTarget.workflow.officialDefinitionName !== null &&
        event.eventType === "manual" &&
        proactiveWorkflowKind(loadedTarget.workflow.officialDefinitionName) !==
          "learning" &&
        proactiveWorkflowKind(loadedTarget.workflow.officialDefinitionName) !==
          "planning"
      ) {
        return rejectedAutomationLaunch(
          unreadable(OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE),
        );
      }
      const target = loadedTarget;
      const [material, autonomyBudget] = await Promise.all([
        get(launchMaterial$),
        get(autonomyBudget$),
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
      const timing = get(timing$);
      const startedAt = performance.now();
      await (async () => {
        await get(workflowAutomationLaunchModel$);
      })().finally(() => {
        timing.recordDuration(
          "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      });
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
        get(assembleWorkflowAutomationRun$),
        get(target$),
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
    return (await get(launchMaterial$))?.callbacks;
  });
  const queuedAutomationAssemblerCommand$ = computed(async (get) => {
    const assembly = await get(queuedAutomationAssemblerAssembly$);
    return assembly.kind === "assembled" ? assembly.run : null;
  });
  const isAutomation$ = computed(async (get) => {
    return (await get(head$)).contextType === "automation";
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
  const threadContinuation$ = computed(
    async (get): Promise<ChatThreadContinuation | undefined> => {
      return (await get(isAutomation$))
        ? ((await get(threadContext.threadContinuation$)) ?? undefined)
        : get(promptExecutionResourcesContinuation$);
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
    const startedAt = timing ? performance.now() : undefined;
    return await (async () => {
      return await Promise.resolve(args.body.agentId);
    })().finally(() => {
      if (startedAt !== undefined) {
        timing?.recordDuration(
          "api_dispatch_pre_create_agent_resolve_agent_id",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      }
    });
  });
  const preCreateAgentAgent$ = computed(
    async (get): Promise<AgentRunRecord | null> => {
      const { timing } = await get(selectedIdentityInputIdentityInput$);
      const agentId = await get(preCreateAgentIdAgentId$);
      if (!agentId) {
        return null;
      }
      const startedAt = timing ? performance.now() : undefined;
      return await (async () => {
        // Authorization waits only for the context's Agent snapshot.
        return await get(bootstrap.agent$);
      })().finally(() => {
        if (startedAt !== undefined) {
          timing?.recordDuration(
            "api_dispatch_pre_create_agent_load_agent",
            "nested",
            performance.now() - startedAt,
            now(),
          );
        }
      });
    },
  );
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
  const preCreateConnectorCatalogConnectorCatalog$ = computed(
    async (get): Promise<RunConnectorCatalogSelection> => {
      const [scope, catalog] = await Promise.all([
        get(bootstrap.connectorScope$),
        get(bootstrap.catalog$),
      ]);
      return runConnectorCatalogSelection(scope, catalog);
    },
  );
  const preCreatePermissionPoliciesPermissionPolicies$ = computed(
    async (get) => {
      const timing = get(threadContext.dispatchTiming$);
      const startedAt = performance.now();
      return await (async () => {
        return await get(bootstrap.permissionPolicies$);
      })().finally(() => {
        timing.recordDuration(
          "api_dispatch_pre_create_agent_resolve_firewall_metadata",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      });
    },
  );
  const preCreatePostAuthorizationPostAuthorization$ = computed(
    async (get): Promise<AgentRunAfterPreCreate | CreateRunErrorResult> => {
      const { timing } = await get(preCreateInput$);
      const [
        connectorScope,
        featureSwitchContext,
        agentResult,
        accountResult,
        catalogResult,
        policiesResult,
      ] = await Promise.all([
        get(bootstrap.connectorScope$),
        get(bootstrap.featureSwitches$),
        get(preCreateAgentAgent$),
        get(preCreateSubscriptionAccountSubscriptionAccount$),
        get(preCreateConnectorCatalogConnectorCatalog$),
        get(preCreatePermissionPoliciesPermissionPolicies$),
      ]);
      const agent = agentResult;
      const account = accountResult;
      if ("status" in account) {
        return account;
      }
      const catalog = catalogResult;
      const policies = policiesResult;
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      return {
        ...connectorScope,
        ...account,
        agent,
        timing,
        connectorCatalogSelection: catalog,
        runPermissionPolicies: policies,
        authorizedRequestObservation: {
          userId: account.command.owner.userId,
          orgId: account.command.owner.orgId,
          agent,
          featureSwitchContext,
        },
      };
    },
  );
  const preCreatePreparedInput$ = computed(async (get) => {
    const [input, resolution, fullCommand, catalog] = await Promise.all([
      get(preCreatePostAuthorizationPostAuthorization$),
      get(threadContinuation$),
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
    return {
      ...input,
      catalog,
      command: {
        ...fullCommand,
        modelProviderId: input.command.modelProviderId,
        agentRunModelPin: input.command.agentRunModelPin,
        body,
      },
      threadContinuation: resolution,
    };
  });
  const preCreateRunArgsRunArgs$ = computed(async (get) => {
    const input = await get(preCreatePreparedInput$);
    if (!input || "status" in input) {
      return input;
    }
    const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
    if (isRouteError(promptAndSkills)) {
      return promptAndSkills;
    }
    return { input, args: buildProductRunArgs(input, promptAndSkills) };
  });
  const runMemberSnapshot$ = computed(async (get) => {
    const selected = bootstrap;
    return {
      orgId: selected.orgId,
      userId: selected.userId,
      member: (await get(selected.memberMetadata$)).preferences ?? undefined,
    };
  });
  const resources = {
    member$: runMemberSnapshot$,
  };
  const preCreateModelFeatureSwitchContext$ = computed(async (get) => {
    const observed = await get(featureSwitchContext$);
    return observed === undefined
      ? await get(bootstrap.featureSwitches$)
      : observed;
  });
  const runFramework$ = threadContext.requestedFramework$;
  const modelRoute$ = threadContext.modelRoute$;
  const promptAndSkillVolumes$ = createPromptAndSkillVolumesSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  const preparedPromptAndSkillVolumes$ = computed(
    async (get): Promise<PromptAndSkillVolumes | CreateRunErrorResult> => {
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
  const connectorSelection$ = threadContext.connectorSelection$;
  const connectorSnapshot$ = threadContext.connectorSnapshot$;
  const preCreateExecutionConnectors = {
    connectorSelection$,
    connectorSnapshot$,
  };
  const preCreateBodyEnvironmentEnvironment$ = bootstrap.bodyEnvironment$;
  const environment$ = createEnvironmentSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  // Start environment preparation, including credential decryption, before
  // runner preparation awaits it.
  const preloadEnvironment$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      if (!(await get(selectionInput$))) {
        signal.throwIfAborted();
        return;
      }
      waitUntil(settle(get(environment$)));
      signal.throwIfAborted();
    },
  );
  const prepared = { environment$ };
  const workflow = createOfficialWorkflowSignals(pickedEvent$, threadContext);
  const { officialWorkflow$ } = workflow;
  const userTimezone$ = computed(async (get) => {
    return (
      (await get(bootstrap.memberMetadata$)).preferences?.timezone ?? undefined
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
    threadContinuation$: threadContinuation$,
    runArgs$: preCreateRunArgsRunArgs$,
    shared: shared,
  };
  const skillVolumeSources = [promptAndSkillVolumes$];
  const storage$ = createStorageSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
    skillVolumeSources,
  );
  const updatePresignedUrlCache$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const { presignedUrlCache } = await get(storage$);
      signal.throwIfAborted();
      await set(
        updateExecutionStoragePresignedUrlCache$,
        presignedUrlCache.mounts,
        presignedUrlCache.prepared,
        signal,
      );
    },
  );
  const {
    runArgs$: selectedRunContextRunArgs$,
    shared: selectedRunContextShared,
  } = graph;
  const contextInput$ = computed(async (get) => {
    const selected = await get(selectedRunContextRunArgs$);
    if (!selected || "status" in selected) {
      throw new Error("Run context requires an authorized ready input");
    }
    get(db$); // Preserve initialization and the graph dependency.
    return {
      args: selected.args,
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
      get(threadContinuation$),
    ]);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return await resolveProductAgentExecution(
      {
        agentId: agent.id,
      },
      command.owner.userId,
      command.owner.orgId,
      {
        preloadedAgentExecutionObservation: {
          requestUserId: command.owner.userId,
          requestOrgId: command.owner.orgId,
          agentId: agent.id,
          ownerUserId: agent.owner,
          agentOrgId: agent.orgId,
        },
        sessionSnapshot: session?.executionSnapshot,
        timing,
      },
    );
  });
  const body$ = computed(async (get) => {
    const [input, resolved, bodyEnvironment] = await Promise.all([
      get(contextInput$),
      get(execution$),
      get(bootstrap.bodyEnvironment$),
    ]);
    if (isRouteError(resolved)) {
      return resolved;
    }
    if (resolved.orgId !== input.args.orgId) {
      return notFound("Resource not found");
    }
    return { ...initialRunBody(input.args), ...bodyEnvironment };
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
  const { environment$: runRuntimeEnvironment$ } = selectedRunContextShared;
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
      get(runRuntimeEnvironment$),
    ]);
    const selection = selectionResult;
    const bodyContext = bodyResult;
    const modelProvider = modelResult;
    const snapshot = snapshotResult;
    const environment = connectorResult;
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
    if (isRouteError(environment)) {
      return environment;
    }
    const catalog = await get(claimCatalog$);
    const usage = prepareModelUsageContext({
      catalog,
      modelProvider,
      permissionManifest: environmentPermissionManifest(environment),
      routePricing: runRoutePricingFromSnapshot(
        {
          modelProvider,
          serviceTier: (await get(contextInput$)).args.codexServiceTier,
        },
        await get(bootstrap.modelPricing$),
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
      environment,
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
  const imageModel$ = computed((get) => {
    return get(bootstrap.selectedImageModel$);
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
    ] = await Promise.all([
      get(bodyContext$),
      get(runtimeContext$),
      get(runContextUserTimezone$),
      get(imageModel$),
      get(runContextOfficialWorkflow$),
    ]);
    const bodyContext = bodyResult;
    const runtimeContext = runtimeResult;
    const userTimezone = timezoneResult;
    const selectedImageModel = imageResult;
    const officialWorkflowRun = workflowResult;
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
    const { resolved } = bodyContext;
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
      body,
      resolved,
      framework,
      piSandbox,
      modelProvider,
      environment: runtimeContext.environment,
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
      const identity = bootstrap;
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
      const [official, target] = await Promise.all([
        get(runContextOfficialWorkflow$),
        get(threadContext.automationTarget$),
      ]);
      signal.throwIfAborted();
      const freeOfficialRun =
        !isRouteError(official) &&
        official !== undefined &&
        target !== null &&
        target.workflow.officialDefinitionName !== null &&
        target.automation.officialBlueprintKey !== null;
      if (!input.enforceBuiltInCredits || freeOfficialRun) {
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
    const capabilities = await get(bootstrap.plan$);
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
   * the claim still holds it; otherwise the statement rolls back every write.
   * The event sequence is reserved first, then the queue lease is released
   * before the rejection events and thread sort writes.
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
      const rejected = prepareChatEventReplacement(source, {
        chatThreadId: source.chatThreadId,
        eventType: "input.rejected",
        userMessage: source.userMessage,
        runId: null,
        error: args.errorMarker,
        createdAt: rejectedAt,
      });
      const assistant = prepareChatEvent({
        chatThreadId: source.chatThreadId,
        eventType: "output.error",
        content: args.displayError,
        runId: null,
        error: args.errorMarker,
        createdAt: new Date(rejectedAt.getTime() + 1),
      });
      const statement = queueHeadRejectionSql({
        events: [rejected.row, assistant.row],
        threadId: source.chatThreadId,
        lease: args.lease,
      });
      const db = set(writeDb$);
      const schema = queueHeadRejectionResultSchema;
      const outcome = await settle(
        (async () => {
          return parseRawRows(schema, await db.execute(statement));
        })(),
        signal,
      );
      signal.throwIfAborted();
      if (!outcome.ok) {
        if (
          outcome.error instanceof Error &&
          queueRejectionLeaseFailureSchema.safeParse(outcome.error.cause)
            .success
        ) {
          throw new TransactionRollbackError();
        }
        if (outcome.error instanceof DrizzleQueryError) {
          const code = safeSqlStateCode(outcome.error);
          // A compound failure must not add message payloads to diagnostics
          // that formerly contained only a sort or lease statement.
          throw new Error("Failed to commit queued input rejection", {
            cause: code === undefined ? undefined : { code },
          });
        }
        throw outcome.error;
      }
      const [result] = outcome.value;
      if (!result || outcome.value.length !== 1) {
        throw new Error("Queued input rejection returned no summary row");
      }
      if (!result.rejected) {
        return null;
      }
      if (result.assistantEventId === null) {
        throw new Error("Failed to append queued input rejection");
      }
      return {
        assistantEventId: result.assistantEventId,
        contextType: source.contextType,
        contextId: source.contextId,
      };
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
  const piLaunchResources$ = computed(
    async (get): Promise<PreparedPiLaunchResources | undefined> => {
      const args = await get(runnerArgs$);
      if (!args || isRouteError(args) || args.piSandbox === undefined) {
        return undefined;
      }
      const piSandbox = args.piSandbox;
      const officialTarget = await get(threadContext.automationTarget$);
      return measureApiDispatchTiming(
        args.timing,
        "api_dispatch_prepare_pi_launch_resources",
        "nested",
        () => {
          return Promise.resolve(
            assemblePiLaunchResources({
              modelConfig: piSandbox,
              sessionId: officialTarget?.workflow.officialDefinitionName
                ? args.run.id
                : (args.chatThreadId ?? args.run.id),
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
    return {
      runId: ids.runId,
    };
  });
  const runPlan$ = computed(
    async (get): Promise<RunPlan | CreateRunErrorResult | null> => {
      if (!(await get(selectionInput$))) {
        return null;
      }
      const [selected, context] = await Promise.all([
        get(preCreateRunArgsRunArgs$),
        get(preparedRunPlan$),
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
      const { args, timing } = await get(contextInput$);
      const launchSnapshot = {
        schemaVersion: 5 as const,
        framework:
          context.piSandbox === undefined ? context.framework : ("pi" as const),
        runnerProfile: DEFAULT_PROFILE,
      };
      const { body } = context;
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
          !(
            officialWorkflowRun && args.agentRunMetadata?.workflowAutomationId
          ) &&
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
          },
          modelProvider: modelProvider
            ? {
                credentialOwner: modelProvider.credentialOwner,
                id: modelProvider.id,
                type: modelProvider.type,
                selectedModel: modelProvider.selectedModel,
                upstreamModel: modelProvider.upstreamModel,
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
          apiStartTime: await get(runnerApiStartTime$),
          includeOkouTokenSecret: args.includeOkouTokenSecret,
          chatThreadId: args.chatThreadId,
        },
      };
    },
  );
  // Resource reads do not wait for credit admission: its failure is checked
  // with the prepared resources before anything is committed.
  const resourceAllowed$ = computed(async (get) => {
    // Eager storage must not evaluate a Run plan for an automation source
    // whose delegation admission already rejects it.
    if (
      (await get(isAutomation$)) &&
      (await get(autonomyBudget$)).kind === "invalid"
    ) {
      return false;
    }
    const [selection, validSource] = await Promise.all([
      get(selectionInput$),
      (await get(isAutomation$)) ? true : get(resourceValidation$),
    ]);
    return !!selection && validSource;
  });
  // Storage is read only for an admitted source. Rejections come from the Run
  // plan; storage runs alongside it and its failure matters only when the plan
  // is ready.
  const preparedStorage$ = computed(
    async (get): Promise<Storage | CreateRunErrorResult | null> => {
      if (!(await get(resourceAllowed$))) {
        return null;
      }
      const [plan, storage] = await Promise.all([
        get(runPlan$),
        settle(get(storage$)),
      ]);
      if (!plan || isRouteError(plan)) {
        return plan;
      }
      if (!storage.ok) {
        throw storage.error;
      }
      return storage.value;
    },
  );
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
      workflowAutomationId:
        input.args.agentRunMetadata?.workflowAutomationId ?? null,
      run: {
        id: identity.runId,
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
      const tokenInput = await get(okouTokenInput$);
      signal.throwIfAborted();
      const okouToken = set(prepareOkouTokenEnvironment$, tokenInput, signal);
      // Keep acquisition before storage preparation without retaining the DB.
      set(writeDb$);
      return prepareRunnerStorageInput({
        args,
        okouToken,
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
              : json().parse(JSON.parse(serializedPayload) as unknown);
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
      await set(preloadEnvironment$, signal);
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
    const [body, environment] = await Promise.all([
      get(preCreateBodyEnvironmentEnvironment$),
      get(environment$),
    ]);
    if (isRouteError(environment)) {
      return environment;
    }
    return {
      secrets: buildStoredExecutionSecrets(environment, body.secrets).secrets,
    };
  });
  const prepareEncryptedSecrets$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await set(preloadEnvironment$, signal);
      const input = await get(storedSecretsInput$);
      signal.throwIfAborted();
      if (!input || isRouteError(input)) {
        return input;
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
      if (head.contextType === "automation") {
        await set(initializeAutomationExecution$, head, timing.run, signal);
        const [event, target] = await Promise.all([get(event$), get(target$)]);
        signal.throwIfAborted();
        if (event && !target) {
          await set(
            revokeDeletedWorkflowAutomationInputs$,
            { orgId: claim.orgId, automationId: event.automationId },
            signal,
          );
          signal.throwIfAborted();
          return null;
        }
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
        get(bootstrap.disabledPaidTools$),
        get(bootstrap.bodyEnvironment$),
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
        get(bootstrap.connectors$),
        get(threadContext.connectorThreadSelections$),
      ]);
      signal.throwIfAborted();
      if (launch.kind === "rejected") {
        return { kind: "rejected" as const, assembly: launch.assembly };
      }
      const [input, storage, runnerInput] = launch.runner;
      const invokedWorkflowId =
        runnerInput && !isRouteError(runnerInput)
          ? await set(
              captureInvokedWorkflow$,
              {
                agentId: runnerInput.args.resolved.agentId,
                userId: runnerInput.args.userId,
                orgId: runnerInput.args.orgId,
                prompt: runnerInput.body.prompt,
              },
              signal,
            )
          : null;
      const contextDraft = claimRunStoredContextDraft(
        runnerInput,
        encrypted,
        invokedWorkflowId,
      );
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
    const selected = bootstrap;
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
      const commit: CommitPreparedLaunchArgs = {
        createArgs: input.args,
        enforceBuiltInCredits: input.enforceBuiltInCredits,
        context: input.context,
        identity,
        callbackRows,
        launch,
        timing: timing.run,
      };
      const poolCapture: PgPoolAcquisitionCapture = { acquisitions: [] };
      const admissionTiming = new AdmissionAttemptTiming({
        poolCapture,
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
      const commitTiming = timing.run;
      const commitStartedAt = performance.now();
      const committed: AtomicLaunchCommitCompletion = await (async () => {
        const result = await withPgPoolAcquisitionCapture(
          poolCapture,
          async () => {
            return await set(
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
          },
        );
        if ("kind" in result && result.kind === "pending") {
          set(internalCommittedRunId$, result.run.id);
        }
        const transactionReturnedAt = now();
        await admissionTiming.finish(admissionAttemptOutcome(result));
        return { result, transactionReturnedAt };
      })().finally(() => {
        commitTiming.recordDuration(
          "api_dispatch_insert_run_with_concurrency",
          "top_level",
          performance.now() - commitStartedAt,
          now(),
        );
      });
      signal.throwIfAborted();
      return set(recordRunCommit$, context, committed, timing, signal);
    },
  );

  const activatePendingRun$ = command(
    async ({ set }, pending: PendingClaimRun, signal: AbortSignal) => {
      signal.throwIfAborted();
      // Immediate and queued picks have committed their active-run slot here.
      // Pending shell approvals must re-read chat_busy before the runner starts.
      await publishDesktopShellAuthorizationChangedSafely(
        pending.context.head.userId,
      );
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
  return { hasFirstPickableChatEvent$, orgHasCapacity$, startRun$ };
}

type AgentRunRecord = AgentRunRequestAgent;

// --- Thread-private implementation: launch persistence ---

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

function runnerReuseKey(chatThreadId: string | undefined): string | null {
  return chatThreadId ? `thread:${chatThreadId}` : null;
}

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly status: "pending";
}

interface LaunchRunIdentity {
  readonly runId: string;
}

type LaunchRunStatus = "pending" | "failed";

interface PersistedAtomicLaunchRows {
  readonly kind: "pending";
  readonly run: RunRecord;
  readonly runnerJobCreatedAt: Date;
}

interface PreparedRunnerLaunch {
  readonly runnerJobPayload: RunnerJobPayload;
  readonly runContextSnapshot: RunContextAxiomSnapshot;
  readonly runStorageMounts: readonly PersistedStorageMount[];
}

type AgentRunCallbackInsert = typeof agentRunCallbacks.$inferInsert;

interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

interface ValidatedThreadSessionSnapshot {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly threadAgentId: string | null;
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
  readonly frameworkSessionRunId: string | null;
  readonly admission: ChatThreadContinuation["admission"];
}

type AtomicLaunchCommitResult =
  | {
      readonly kind: "pending";
      readonly run: RunRecord;
      readonly runnerJobPayload: RunnerJobPayload;
      readonly runnerJobCreatedAt: Date;
      readonly runContextSnapshot: RunContextAxiomSnapshot;
      readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
    }
  | QueueFirstRunClaimLost;

type CommittedAtomicLaunchResult = Exclude<
  AtomicLaunchCommitResult,
  QueueFirstRunClaimLost
>;

type PendingThreadContinuation = Pick<
  ChatThreadContinuation,
  "expected" | "admission"
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
  readonly threadContinuation?: PendingThreadContinuation;
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
  };
  readonly modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    | "credentialOwner"
    | "id"
    | "type"
    | "selectedModel"
    | "builtInModelRuntimeRoute"
    | "upstreamModel"
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
    status,
  };
}

interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly status: LaunchRunStatus;
  readonly validatedAccountIdentity?: string | null;
  readonly resolved: Pick<ResolvedRunExecution, "agentId">;
  readonly body: CreateRunBody;
  readonly runStorageMounts: readonly PersistedStorageMount[] | undefined;
  readonly modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    | "credentialOwner"
    | "id"
    | "type"
    | "selectedModel"
    | "builtInModelRuntimeRoute"
    | "upstreamModel"
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
    agentId: args.resolved.agentId,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    vars: args.body.vars ?? null,
    secretNames: args.body.secrets ? Object.keys(args.body.secrets) : null,
    storageMounts: args.runStorageMounts ? [...args.runStorageMounts] : null,
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

type ModelLaunchMetadataValues = Pick<
  RunMetadataValues,
  "modelRuntimeProvider" | "modelRuntimeModel" | "builtInModelKeyId"
>;

function modelLaunchMetadataValues(
  modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    "builtInModelRuntimeRoute" | "type" | "upstreamModel"
  > | null,
): ModelLaunchMetadataValues {
  const runtimeRoute = modelProvider?.builtInModelRuntimeRoute;
  if (!runtimeRoute) {
    return {
      // The compiled subscription environment and Runner use this same upstream.
      // Failed preparation has no execution to capture; member keys are not managed keys.
      modelRuntimeProvider:
        modelProvider?.upstreamModel &&
        isPersonalSubscriptionProviderType(modelProvider.type)
          ? modelProvider.type
          : null,
      modelRuntimeModel:
        modelProvider && isPersonalSubscriptionProviderType(modelProvider.type)
          ? (modelProvider.upstreamModel ?? null)
          : null,
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
    ...modelLaunchMetadataValues(args.modelProvider),
    ...(args.modelProvider?.builtInModelRuntimeRoute &&
    modelPin.selectedModel &&
    isAutoSelectedModel(modelPin.selectedModel)
      ? {
          modelUsageProvider: autoRunBillingProvider(
            modelPin.selectedModel,
            args.modelProvider.builtInModelRuntimeRoute.upstreamModel,
          ),
          modelLongContextMinTotalInputTokens:
            autoRunPricingLongContextMinTotalInputTokens(
              modelPin.selectedModel,
            ),
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
  };
}

interface PreparedAtomicLaunchRows {
  readonly rowsArgs: LaunchRunRowsArgs;
  readonly metadata: RunMetadataValues;
}

interface PreparedAtomicLaunchPersistence {
  readonly payload: RunnerJobPayload;
  readonly rows: PreparedAtomicLaunchRows;
  readonly diagnosticRegistrationPayload: zInfer<
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
  for (const [index, callback] of args.callbacks.entries()) {
    args.ctes.push(
      new QueryBuilder()
        .$with(`inserted_launch_callback_${String(index)}`, {})
        .as(
          pendingLaunchInsertSql(
            agentRunCallbacks,
            { ...callback, runId: returnedCteId(args.insertedRun) },
            ["runId"],
            sql`EXISTS (SELECT 1 FROM ${args.insertedRun})`,
          ),
        ),
    );
  }
}

function launchThreadBindingCte(args: {
  readonly chatThreadId: string | undefined;
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly validatedThreadSession: ValidatedThreadSessionSnapshot | undefined;
}) {
  const expected = args.validatedThreadSession;
  if (!args.chatThreadId || !expected) {
    return undefined;
  }
  if (expected.chatThreadId !== args.chatThreadId) {
    throw new Error("Validated thread does not match launch");
  }
  if (expected.admission.runId !== args.identity.runId) {
    throw new Error("Captured predecessor facts do not match launch identity");
  }
  return new QueryBuilder().$with("validated_launch_thread").as(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.chatThreadId),
          eq(chatThreads.userId, args.userId),
          chatThreadOrganizationCondition(args.orgId),
          sql`${chatThreads.agentId} IS NOT DISTINCT FROM ${expected.threadAgentId}::uuid`,
          sql`${chatThreads.framework} IS NOT DISTINCT FROM ${expected.framework}::text`,
          sql`${chatThreads.frameworkSessionId} IS NOT DISTINCT FROM ${expected.frameworkSessionId}::text`,
          sql`${chatThreads.frameworkSessionRunId} IS NOT DISTINCT FROM ${expected.frameworkSessionRunId}::uuid`,
          sql`${chatThreads.frameworkSessionRunId} IS NOT DISTINCT FROM ${expected.admission.finalizingSourceRunId}::uuid`,
        ),
      ),
  );
}

function buildAtomicLaunchCteContext(args: AtomicLaunchRowsPlanArgs) {
  const { rowsArgs, metadata } = args.commit.persistence.rows;
  // Capture creation metadata with the API clock immediately before atomic
  // publication. Returned dependencies fence writes, never these timestamps.
  const createdAt = nowDate();
  const ctes: WithSubquery[] = [];

  const updatedThread = launchThreadBindingCte({
    chatThreadId: args.commit.createArgs.chatThreadId,
    userId: args.commit.createArgs.userId,
    orgId: args.commit.createArgs.orgId,
    identity: rowsArgs.identity,
    validatedThreadSession: args.validatedThreadSession,
  });
  if (updatedThread) {
    ctes.push(updatedThread);
  }
  const insertedRun = new QueryBuilder()
    .$with("inserted_launch_run", {
      id: agentRuns.id,
      createdAt: agentRuns.createdAt,
    })
    .as(
      pendingLaunchInsertSql(
        agentRuns,
        {
          ...launchRunValues(rowsArgs, createdAt, metadata),
          id: pendingLaunchGuardedRunId(args, updatedThread),
          modelProviderAccountIdentity: args.validatedAccountIdentity,
        },
        ["id", "createdAt"],
        pendingLaunchRunEligibility(args.publication),
      ),
    );
  ctes.push(insertedRun);

  const insertedDiagnosticRegistration = new QueryBuilder()
    .$with("inserted_launch_connector_diagnostic_registration", {})
    .as(
      pendingLaunchInsertSql(
        agentRunConnectorDiagnosticRegistrations,
        {
          runId: returnedCteId(insertedRun),
          payload: args.commit.persistence.diagnosticRegistrationPayload,
          createdAt,
        },
        ["runId"],
        sql`EXISTS (SELECT 1 FROM ${insertedRun})`,
      ),
    );
  // The insert executes with the statement and depends on insertedRun's ID.
  // Its returned row need not participate in the final result join.
  ctes.push(insertedDiagnosticRegistration);

  appendLaunchCallbackCte({
    ctes,
    callbacks: rowsArgs.callbackRows,
    insertedRun,
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
  readonly publication: PendingLaunchPublication;
}
interface AdmittedPreparedLaunch extends ValidatedPreparedLaunchAdmission {
  readonly kind: "admitted";
  readonly queueFirstClaim: QueueFirstRunClaimed | undefined;
}

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

type AgentRunCreateBody = zInfer<typeof runCreateBodySchema>;

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
  "modelProvider" | "realAgentInPreview" | "captureNetworkBodies"
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
  readonly callbacks?: readonly AgentRunsCreateRunCallback[];
  readonly chatThreadId: string;
  readonly connectorSourceId?: string;
  /** A producer may atomically move an integration thread to this run's agent. */
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

/** The selection-time command: everything but the prompt-time facts. */
type ThreadRunSelection = Omit<ThreadRunCommand, "body" | "callbacks"> & {
  readonly body: ThreadRunBody;
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
  "context" | "persistedStorageMounts"
> & {
  readonly context: Omit<StoredExecutionContext, "storageMounts">;
};

function buildStoredPlatformEnvironment(args: {
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly canonicalOkouRuntime: boolean;
}): Record<string, string> {
  const platformEnvironment = {
    ...args.platformEnvironment,
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
  invokedWorkflowId: string | null,
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
      platformEnvironment,
      runId: args.run.id,
      workflowAutomationId: args.workflowAutomationId,
      invokedWorkflowId,
    },
    encrypted.encryptedSecrets,
  );
}

function protectedWorkflowMountPaths(
  volumes: readonly AgentRunCreateAdditionalVolume[] | undefined,
  sources: AdditionalVolumeSources,
) {
  return (volumes ?? []).flatMap((volume, index) => {
    const source = sources?.[index];
    return source === "official_workflow" ||
      source === "request_additional_volume" ||
      source === "unknown"
      ? [volume.mountPath]
      : [];
  });
}

function buildStoredExecutionContextDraft(
  args: {
    readonly runId: string;
    readonly workflowAutomationId: string | null;
    readonly invokedWorkflowId: string | null;
    readonly userId: string;
    readonly orgId: string;
    readonly chatThreadId: string | undefined;
    readonly resolved: ResolvedRunExecution;
    readonly body: CreateRunBody;
    readonly framework: SupportedFramework;
    readonly piSandbox: PiModelConfig | undefined;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly environment: Environment;
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly modelUsageLongContextMinTotalInputTokens: number;
    readonly apiStartTime: number | undefined;
    readonly additionalVolumes:
      readonly AgentRunCreateAdditionalVolume[] | undefined;
    readonly additionalVolumeSources: AdditionalVolumeSources;
    readonly platformEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly includeOkouTokenSecret: boolean | undefined;
  },
  encryptedSecrets: BuiltStoredExecutionContextDraft["context"]["encryptedSecrets"],
): BuiltStoredExecutionContextDraft {
  const permissions = environmentPermissionManifest(args.environment);
  const executionSecrets = buildStoredExecutionSecrets(
    args.environment,
    args.body.secrets,
  );
  const secretNames = executionSecrets.secrets
    ? Object.keys(executionSecrets.secrets)
    : [];
  const secretValues = executionSecrets.secrets
    ? Object.values(executionSecrets.secrets)
    : [];
  // Newly constructed API context: remove the reserved namespace from the
  // fully expanded untrusted environment before the trusted overlay.
  const expandedEnvironment = withoutOkouNamespaceEntries(
    args.environment.environment ?? null,
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
  if (
    args.chatThreadId !== undefined &&
    args.resolved.nativeContinuation === undefined
  ) {
    throw new Error(
      "Thread Run is missing captured native continuation intent",
    );
  }
  return {
    context: {
      environment,
      // Capture invocation identity and mount precedence, never Workflow content.
      ...(args.resolved.agentId !== null
        ? {
            customWorkflowSelection: {
              agentId: args.resolved.agentId,
              invokedWorkflowId: args.invokedWorkflowId,
              ...(args.workflowAutomationId === null
                ? {}
                : { automationId: args.workflowAutomationId }),
              protectedMountPaths: protectedWorkflowMountPaths(
                args.additionalVolumes,
                args.additionalVolumeSources,
              ),
            },
          }
        : {}),
      platformEnvironment,
      secretValueEnvironmentKeys,
      vars: args.environment.vars ?? null,
      nativeContinuation: args.resolved.nativeContinuation ?? {
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: null,
      },
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
      connectorRuntimeTargets: [...args.environment.runtimeTargets],
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
    context: {
      ...builtContextDraft.context,
      storageMounts: [...preparedStorage.storageMounts],
    },
  };
}

/** Final runtime secret namespace: the Run environment plus body secrets. */
function buildStoredExecutionSecrets(
  environment: Environment,
  bodySecrets: Record<string, string> | undefined,
): StoredExecutionSecrets {
  const merged = mergeEnvironments([
    environment,
    { ...emptyEnvironment(), secrets: bodySecrets },
  ]);
  return {
    // An explicitly empty namespace still supports dynamic firewall secrets.
    secrets:
      merged.secrets ??
      (bodySecrets !== undefined || merged.secretConnectorMap ? {} : undefined),
    secretConnectorMap: merged.secretConnectorMap ?? null,
    secretConnectorMetadataMap: merged.secretConnectorMetadataMap ?? null,
  };
}

interface BuildRunnerJobPayloadInput {
  readonly capturedStorageMounts?: readonly PersistedStorageMount[];
  readonly deferredPiResources?: PreparedPiLaunchResources;
  readonly run: Pick<RunRecord, "id">;
  readonly workflowAutomationId: string | null;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly framework: SupportedFramework;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  /** Connector and model-provider environment, before the Okou token. */
  readonly environment: Environment;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
  readonly apiStartTime: number | undefined;
  readonly additionalVolumes:
    readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly chatThreadId: string | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}

function preparedRunnerGroup(): string {
  return officialRunnerGroup(optionalEnv("RUNNER_DEFAULT_GROUP"));
}

/**
 * Final runner launch from explicit facts: the stored context draft with its
 * prepared storage, Pi launch resources, run-context snapshot, runner job
 * payload and exact persisted Run storage mounts.
 */
function assembleRunnerLaunch(args: {
  readonly runId: string;
  readonly userId: string;
  readonly chatThreadId: string | undefined;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly runnerGroup: string;
  readonly body: CreateRunBody;
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
  const persistedStorageMounts = builtContext.persistedStorageMounts;
  const runContextSnapshot = buildRunContextSnapshot({
    runId: args.runId,
    userId: args.userId,
    body: args.body,
    builtContext: { ...builtContext, context: storedContext },
  });
  const cliAgentSessionId =
    storedContext.piSessionId ??
    storedContext.nativeContinuation?.sessionId ??
    null;
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
  };
}

interface StorageMaterializationInput {
  readonly args: BuildRunnerJobPayloadInput;
  /** The Okou token source, merged last into body secrets and platform env. */
  readonly okouToken: Environment;
  readonly storageManifestStats: StorageManifestBuildStats;
}

function prepareRunnerStorageInput(input: StorageMaterializationInput) {
  const { args, storageManifestStats, okouToken } = input;
  return {
    args,
    storageManifestStats,
    body: {
      ...args.body,
      secrets: {
        ...withoutLegacyAgentRunEnvironmentEntries(args.body.secrets),
        ...okouToken.secrets,
      },
    },
    group: preparedRunnerGroup(),
    platformEnvironment: {
      ...args.environment.platformEnvironment,
      ...okouToken.platformEnvironment,
    },
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
  const { args, group, body } = storage.input;
  return assembleRunnerLaunch({
    runId: args.run.id,
    userId: args.userId,
    chatThreadId: args.chatThreadId,
    launchSnapshot: args.launchSnapshot,
    runnerGroup: group,
    body,
    preparedStorage: storage.preparedStorage.prepared,
    contextDraft,
    piResources: storage.piResources,
  });
}

function withPendingOkouTokenSecret(body: CreateRunBody): CreateRunBody {
  return { ...body, secrets: pendingOkouTokenSecrets(body.secrets) };
}

interface ResolveAgentExecutionOptions {
  readonly agentObservation?: RunAgentObservation;
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  readonly timing?: ApiDispatchTimingCollector;
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

interface RunAgentObservation {
  readonly agentId: string;
  readonly agentOrgId: string;
  readonly agentOwner: string;
}

function resolveAgentObservation(
  row: RunAgentObservation | undefined,
): ResolvedAgentExecution | CreateRunErrorResult {
  if (!row) {
    return notFound("Agent not found");
  }
  return {
    agentId: row.agentId,
    ownerUserId: row.agentOwner,
    orgId: row.agentOrgId,
  };
}

/** Product identity is authorized by the Agent; native provenance belongs to Thread. */
function resolveProductAgentExecution(
  body: Pick<CreateRunBody, "agentId">,
  userId: string,
  orgId: string,
  options: ResolveAgentExecutionOptions,
): ResolvedRunExecution | CreateRunErrorResult {
  if (!body.agentId) {
    return badRequestMessage("Missing agentId");
  }
  const agentId = body.agentId;
  const preloaded = options.preloadedAgentExecutionObservation;
  const resolved =
    preloaded &&
    preloaded.requestUserId === userId &&
    preloaded.requestOrgId === orgId &&
    preloaded.agentId === agentId &&
    preloaded.agentOrgId === orgId
      ? {
          agentId,
          ownerUserId: preloaded.ownerUserId,
          orgId: preloaded.agentOrgId,
        }
      : resolveAgentObservation(options.agentObservation);
  if (isRouteError(resolved)) {
    return resolved;
  }
  const snapshot = options.sessionSnapshot;
  return {
    ...resolved,
    ...(snapshot
      ? {
          nativeContinuation: snapshot.nativeContinuation,
        }
      : {}),
  };
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
  readonly body: Omit<AgentRunCreateBody, "prompt">;
  readonly agent: AgentRunRecord;
  readonly permissionPolicies: FirewallPolicies | null | undefined;
  readonly triggerSource: TriggerSource | undefined;
  readonly prompt: Pick<
    PromptAndSkillVolumes,
    "userPrompt" | "appendedSystemPrompt"
  >;
}) {
  const triggerSource = args.triggerSource ?? "web";
  return {
    prompt: args.prompt.userPrompt,
    agentId: args.agent.id,
    additionalVolumes: args.body.additionalVolumes,
    realAgentInPreview: args.body.realAgentInPreview,
    captureNetworkBodies: args.body.captureNetworkBodies,
    tools: args.body.tools,
    settings: args.body.settings,
    permissionPolicies: args.permissionPolicies ?? undefined,
    triggerSource,
    appendSystemPrompt: args.prompt.appendedSystemPrompt,
    disallowedTools: [...DISALLOWED_TOOLS],
  };
}

interface AgentRunAfterBootstrap extends AgentConnectorScopeSnapshot {
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly timing: ApiDispatchTimingCollector;
  readonly command: ThreadRunIdentity;
  readonly threadContinuation?: ChatThreadContinuation;
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
  readonly threadContinuation?: ChatThreadContinuation;
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
  readonly threadContinuation?: ChatThreadContinuation;
  readonly callbacks?: readonly RunCallback[];
  readonly includeOkouTokenSecret?: boolean;
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  readonly enforceBuiltInCredits?: boolean;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly connectorScope: ExplicitConnectorScope;
  readonly agentRunModelPin?: AgentRunModelPin;
  readonly timing?: ApiDispatchTimingCollector;
  readonly timingDimensions?: ApiDispatchTimingDimensions;
}

function buildProductRunArgs(
  args: ProductRunArgsInput,
  prompt: Pick<PromptAndSkillVolumes, "userPrompt" | "appendedSystemPrompt">,
): ProductRunArgs {
  const command = args.command;
  return {
    ...selectedRunModelProviderArgs(command),
    catalog: args.catalog,
    body: createRunBody({
      body: command.body,
      agent: args.agent,
      permissionPolicies: args.runPermissionPolicies,
      triggerSource: command.triggerSource,
      prompt,
    }),
    apiStartTime: command.apiStartTime,
    chatThreadId: command.chatThreadId,
    ...(command.connectorSourceId
      ? { connectorSourceId: command.connectorSourceId }
      : {}),
    ...(args.threadContinuation
      ? { threadContinuation: args.threadContinuation }
      : {}),
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
    enforceBuiltInCredits: true,
    requiredOfficialWorkflowIds: command.requiredOfficialWorkflowIds,
    connectorScope: {
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      allowedCustomConnectorIds: args.allowedCustomConnectorIds,
      customConnectorGrants: args.customConnectorGrants,
      source: "stored_agent",
    },
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

interface AgentRunIdentityInput {
  readonly timing: ApiDispatchTimingCollector;
  readonly owner: ThreadRunOwner;
  readonly agentId: string;
  readonly apiStartTime: number;
  readonly chatThreadId: string;
  readonly queueFirstAssociation: QueueFirstRunAssociation;
}
interface AgentRunGraphInput {
  readonly command: ThreadRunIdentity;
  readonly timing: ApiDispatchTimingCollector;
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

type CreateRunBody = Omit<
  zInfer<typeof unifiedRunRequestSchema>,
  "triggerSource"
> & {
  readonly triggerSource: TriggerSource;
};

interface RunnerJobPayload {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly reuseKey: string | null;
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
    executionContext: args.executionContext,
  };
}

// --- Private implementation: connector context ---

// --- Private implementation: Runner payload ---

interface BuiltStoredExecutionContext {
  readonly context: StoredExecutionContext;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
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
    storedContext.piSessionId ??
    storedContext.nativeContinuation?.sessionId ??
    null;
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
    storageMounts: storedContext.storageMounts.map((mount) => {
      return {
        name: mount.name,
        version: mount.versionId,
        mountPath: mount.mountPath,
        writeback: mount.writeback === true,
      };
    }),
    featureFlagEntries: featureFlagsRecordToEntries(storedContext.featureFlags),
  };
  return snapshot;
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
    piSessionId: resources.sessionId,
    piLaunchConfig: resources.launchConfig,
    piModelConfig: resources.modelConfig,
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

interface PreparedPiLaunchResources {
  readonly modelConfig: PiModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly sessionId: string;
}

function assemblePiLaunchResources(args: {
  readonly modelConfig: PiModelConfig;
  readonly sessionId: string;
}): PreparedPiLaunchResources {
  const { sessionId } = args;
  return {
    modelConfig: args.modelConfig,
    launchConfig: {
      schemaVersion: 2,
    },
    sessionId,
  };
}

// --- Private implementation: storage manifest ---

// Storage planning and explicit resource materialization.

// Execution context, launch preparation and pending atomic commit.

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

function assertPendingLaunchClaim(
  args: PreparedCommitPreparedLaunchArgs,
  claim: PendingLaunchClaim | undefined,
) {
  if (claim && !args.createArgs.agentRunModelPin) {
    throw new Error("Chat run commit requires its captured model pin");
  }
}

const pendingLaunchRowSchema = discriminatedUnion("kind", [
  object({
    kind: literal("pending"),
    runId: string(),
    createdAt: pgTimestampWithoutTimezoneToDateSchema,
    runnerJobCreatedAt: pgTimestampWithoutTimezoneToDateSchema,
    boundThreadId: string().nullable(),
    billingAttributionId: string().nullable(),
  }),
  object({ kind: literal("official") }),
  object({ kind: literal("plan") }),
  object({ kind: literal("claim-lost") }),
]);

function pendingAtomicLaunchResult(
  args: PreparedCommitPreparedLaunchArgs,
  context: AtomicLaunchCteContext,
  row: zInfer<typeof pendingLaunchRowSchema> | undefined,
):
  | PersistedAtomicLaunchRows
  | ReturnType<typeof conflict>
  | QueueFirstRunClaimLost {
  if (!row) {
    throw new Error("Atomic pending launch persistence returned no row");
  }
  if (row.kind === "official") {
    return conflict(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE);
  }
  if (row.kind === "plan") {
    throw new Error(
      `Missing org plan entitlement for ${args.createArgs.orgId}`,
    );
  }
  if (row.kind === "claim-lost") {
    return { kind: "queue-first-claim-lost" };
  }
  if (context.updatedThread && !row.boundThreadId) {
    throw new ChatThreadBindingChanged();
  }
  if (row.billingAttributionId !== row.runId) {
    throw new Error("New Run billing attribution conflicts with history");
  }
  return {
    kind: "pending",
    run: runRecordFromLaunchIdentity(
      context.rowsArgs.identity,
      "pending",
      row.createdAt,
    ),
    runnerJobCreatedAt: row.runnerJobCreatedAt,
  };
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
        {
          runId: returnedCteId(context.insertedRun),
          runnerGroup: args.payload.runnerGroup,
          profile: args.payload.profile,
          cliAgentSessionId: args.payload.cliAgentSessionId,
          reuseKey: args.payload.reuseKey,
          executionContext: args.payload.executionContext,
          ...timestamps,
        },
        ["runId", "createdAt"],
        sql`EXISTS (SELECT 1 FROM ${context.insertedRun})`,
      ),
    );
  const capture = billingRunAttributionWrite({
    id: context.rowsArgs.identity.runId,
    orgId: context.rowsArgs.orgId,
    userId: context.rowsArgs.userId,
    startedAt: context.createdAt.toISOString(),
    triggerSource: args.commit.persistence.rows.metadata.triggerSource,
    threadId: args.commit.persistence.rows.metadata.chatThreadId,
    status: "pending",
    billingCompletedAt: null,
    creditChargePolicy:
      context.rowsArgs.officialWorkflowProvenance &&
      context.rowsArgs.agentRunMetadata?.workflowAutomationId
        ? "official_workflow_free"
        : "standard",
  });
  const attribution = new QueryBuilder()
    .$with("inserted_launch_billing_attribution", {
      runId: billingRunAttribution.runId,
    })
    .as(
      pendingLaunchBillingAttributionSql(
        capture,
        returnedCteId(context.insertedRun),
        sql`EXISTS (SELECT 1 FROM ${context.insertedRun})`,
      ),
    );
  const ctes = [...context.ctes, insertedQueue, attribution];
  const names = ctes.map((cte) => {
    return cte._.alias;
  });
  if (args.publication.queueFirst) {
    names.push("launch_claim_relations");
  }
  const beforeProducer = pendingLaunchBarrier(names);
  const producer = args.publication.claim
    ? pendingLaunchClaimProducerStatements(
        args.publication.claim.producer,
        context.rowsArgs.identity.runId,
        sql`EXISTS (SELECT 1 FROM ${context.insertedRun}) AND ${beforeProducer} >= 0`,
      )
    : [];
  const producerCtes = producer.map((statement, index) => {
    const name = `launch_producer_${String(index)}`;
    names.push(name);
    return sql`${sql.identifier(name)} AS (${statement})`;
  });
  const active = pendingLaunchActivePublication(
    args,
    context,
    attribution,
    pendingLaunchBarrier(names),
  );
  const planned = ctes.map((cte) => {
    return sql`${sql.identifier(cte._.alias)} AS ${cte === context.updatedThread ? sql`MATERIALIZED` : sql.empty()} (${cte._.sql})`;
  });
  return sql`WITH ${pendingLaunchPublicationCtes(args)},
    ${sql.join([...planned, ...producerCtes], sql`, `)},
    launch_active AS (${active})
    SELECT CASE
      WHEN reason <> 'ready' THEN reason
      WHEN EXISTS (SELECT 1 FROM ${context.insertedRun}) THEN 'pending'
      ELSE 'claim-lost' END AS kind,
      (SELECT ${attribution.runId} FROM ${attribution}) AS "billingAttributionId",
      (SELECT ${returnedCteColumn(context.insertedRun, "id")} FROM ${context.insertedRun}) AS "runId",
      (SELECT ${returnedCteColumn(context.insertedRun, "created_at")} FROM ${context.insertedRun})::text AS "createdAt",
      (SELECT ${returnedCteColumn(insertedQueue, "created_at")} FROM ${insertedQueue})::text AS "runnerJobCreatedAt",
      ${nullableReturnedCteId(context.updatedThread)} AS "boundThreadId"
    FROM launch_official_guard WHERE (SELECT ${count()} FROM launch_active) >= 0`;
}

function returnedCteColumn(cte: WithSubquery, name: string): SQL {
  return sql`${sql.identifier(cte._.alias)}.${sql.identifier(name)}`;
}

function pendingLaunchRowsPlan(
  commit: PreparedCommitPreparedLaunchArgs,
  admission: ValidatedPreparedLaunchAdmission,
  publication: PendingLaunchPublication,
) {
  const rows = {
    commit,
    payload: commit.persistence.payload,
    ...admission,
    publication,
  };
  const context = buildAtomicLaunchCteContext(rows);
  return {
    rows,
    context,
  };
}

interface PendingLaunchPublication {
  readonly claim: PendingLaunchClaim | undefined;
  readonly queueFirst:
    | {
        readonly input: PreparedChatEventRow & {
          readonly revokesEventId: string;
        };
        readonly headSql: SQL;
      }
    | undefined;
}

function pendingLaunchBarrier(names: readonly string[]): SQL {
  return names.length === 0
    ? sql`0`
    : sql.join(
        names.map((name) => {
          return sql`(SELECT ${count()} FROM ${sql.identifier(name)})`;
        }),
        sql` + `,
      );
}

function pendingLaunchPublicationCtes(args: AtomicLaunchRowsPlanArgs): SQL {
  const { claim, queueFirst } = args.publication;
  const official = sql`launch_official_guard AS MATERIALIZED (${pendingOfficialAdmissionGuardSql(args.commit)})`;
  const ready = sql`(SELECT reason FROM launch_official_guard) = 'ready'`;
  const claimCtes = queueFirst
    ? sql`, ${canonicalChatEventInputCtes(
        [queueFirst.input],
        sql`${ready} AND EXISTS (
        SELECT 1 FROM (${queueFirst.headSql}) AS current_head WHERE current_head.id = ${queueFirst.input.revokesEventId}::uuid)`,
      )},
      inserted AS (${canonicalChatEventInsertSql("any")}),
      launch_claim_relations AS (
        UPDATE chat_relations AS relation SET target_run_id = input."runId"
        FROM input JOIN inserted ON inserted.id = input.id
        WHERE relation.message_event_id = input."revokesEventId"
          AND relation.target_chat_thread_id = input."chatThreadId"
          AND relation.type = 'message' AND relation.target_run_id IS NULL
          AND input."eventType" = 'input.prompt' AND input."runId" IS NOT NULL
        RETURNING relation.message_event_id
      )`
    : sql.empty();
  const released = claim
    ? sql`, released_pending_token AS (${pendingLaunchClaimFenceSql(
        claim,
        queueFirst
          ? sql`EXISTS (SELECT 1 FROM inserted)
              AND (SELECT ${count()} FROM launch_claim_relations) >= 0`
          : ready,
      )})`
    : sql.empty();
  return sql`${official}${claimCtes}${released}`;
}

function pendingLaunchGuardedRunId(
  args: AtomicLaunchRowsPlanArgs,
  thread: WithSubquery | undefined,
): SQL {
  const { claim } = args.publication;
  const guards: SQL[] = [];
  if (claim) {
    guards.push(
      sql`WHEN (SELECT ${count()} FROM released_pending_token) <> 1 THEN '__TX0263_TOKEN__'`,
    );
  }
  if (thread) {
    guards.push(
      sql`WHEN NOT EXISTS (SELECT 1 FROM ${thread}) THEN '__TX0263_THREAD__'`,
    );
  }
  const guard = guards.length
    ? sql`CASE ${sql.join(guards, sql` `)} ELSE '0' END`
    : sql`'0'`;
  return sql`CASE WHEN (${guard})::integer = 0
    THEN ${args.commit.identity.runId}::uuid ELSE NULL END`;
}

function pendingLaunchRunEligibility(
  publication: PendingLaunchPublication,
): SQL {
  return sql`(SELECT reason FROM launch_official_guard) = 'ready'
    ${publication.queueFirst ? sql`AND EXISTS (SELECT 1 FROM inserted)` : sql.empty()}`;
}

function pendingLaunchActivePublication(
  args: AtomicLaunchRowsPlanArgs,
  context: AtomicLaunchCteContext,
  attribution: WithSubquery & { readonly runId: SQLWrapper },
  barrier: SQL,
) {
  const id = sql`CASE WHEN ${barrier} + (CASE WHEN
      (SELECT ${attribution.runId} FROM ${attribution}) = ${context.rowsArgs.identity.runId}::uuid
      THEN '0' ELSE '__TX0263_ATTRIBUTION__' END)::integer >= 0
    THEN ${returnedCteId(context.insertedRun)} ELSE NULL END`;
  return pendingLaunchInsertSql(
    activeAgentRuns,
    {
      runId: id,
      orgId: args.commit.createArgs.orgId,
      userId: args.commit.createArgs.userId,
      chatThreadId: args.commit.createArgs.chatThreadId ?? null,
      // Pending timeout starts at publication, after all admission waits.
      // Reuse the liveness clock used by Runner claim, not creation metadata.
      lastHeartbeatAt: sql`CASE WHEN ${barrier} >= 0 THEN ${nowDateSql()} ELSE NULL END`,
    },
    ["runId"],
    sql`EXISTS (SELECT 1 FROM ${context.insertedRun})`,
  );
}

function throwPendingLaunchGuardFailure(error: unknown): void {
  if (
    !(error instanceof DrizzleQueryError) ||
    !(error.cause instanceof Error) ||
    safeSqlStateCode(error) !== "22P02"
  ) {
    return;
  }
  const message = error.cause.message;
  if (message === 'invalid input syntax for type integer: "__TX0263_TOKEN__"') {
    throw new Error("Chat thread claim was lost before the pending commit");
  }
  if (
    message === 'invalid input syntax for type integer: "__TX0263_THREAD__"'
  ) {
    throw new ChatThreadBindingChanged();
  }
  if (
    message ===
    'invalid input syntax for type integer: "__TX0263_ATTRIBUTION__"'
  ) {
    throw new Error("New Run billing attribution conflicts with history");
  }
}

export const commitPreparedPendingLaunch$ = command(
  async (
    { set },
    args: PreparedCommitPreparedLaunchArgs,
    claim: PendingLaunchClaim | undefined,
    signal: AbortSignal,
  ): Promise<AtomicLaunchCommitAttempt> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const { admissionTiming, timing } = args;
    assertPendingLaunchClaim(args, claim);
    admissionTiming.transactionStarted();
    admissionTiming.admissionStarted();
    let admission = pendingLaunchAdmissionStart(args);
    while ("kind" in admission && admission.kind === "statement") {
      const step = admission;
      const rows = parseRawRows(admissionRow, await db.execute(step.sql));
      signal.throwIfAborted();
      admission = advancePendingLaunchAdmission(args, step, rows);
    }
    if (!("kind" in admission)) {
      admissionTiming.callbackFinished();
      return admission;
    }
    if (admission.kind === "queue-first-claim-lost") {
      admissionTiming.callbackFinished();
      return admission;
    }
    const queueFirst =
      admission.kind === "claim"
        ? { input: admission.claimInput, headSql: admission.headSql }
        : undefined;
    const accepted: AdmittedPreparedLaunch = {
      kind: "admitted",
      validatedThreadSession: admission.validatedThreadSession,
      validatedAccountIdentity: admission.validatedAccountIdentity,
      queueFirstClaim: queueFirst
        ? { kind: "claimed", createdAt: queueFirst.input.createdAt }
        : undefined,
    };
    const prepared = pendingLaunchRowsPlan(args, accepted, {
      claim,
      queueFirst,
    });
    const leafStartedAt = admissionTiming.leafStartedAt();
    return await (async () => {
      signal.throwIfAborted();
      const capture: PgQueryExecutionCapture = { executions: [] };
      const databaseStartedAt = performance.now();
      const persisted = await withPgQueryExecutionCapture(capture, async () => {
        const buildStartedAt = monotonicNow();
        const plan = pendingAtomicLaunchPlan(prepared.rows, prepared.context);
        timing.recordDuration(
          "api_dispatch_persist_atomic_launch_build",
          "nested",
          monotonicNow() - buildStartedAt,
          now(),
        );
        signal.throwIfAborted();
        const outcome = await settle(
          (async () => {
            return parseRawRows(pendingLaunchRowSchema, await db.execute(plan));
          })(),
        );
        if (!outcome.ok) {
          signal.throwIfAborted();
          throwPendingLaunchGuardFailure(outcome.error);
          throw outcome.error;
        }
        // Publication has committed. Return its durable identity before the
        // caller observes cancellation; do not orphan an accepted pending Run.
        const materializeStartedAt = monotonicNow();
        const result = pendingAtomicLaunchResult(
          args,
          prepared.context,
          outcome.value[0],
        );
        timing.recordDuration(
          "api_dispatch_persist_atomic_launch_materialize",
          "nested",
          monotonicNow() - materializeStartedAt,
          now(),
        );
        return result;
      }).finally(() => {
        timing.recordDatabaseElapsed(
          "api_dispatch_persist_atomic_launch",
          "api_dispatch_persist_atomic_launch_sql_call",
          "api_dispatch_persist_atomic_launch_application_remainder",
          databaseStartedAt,
          capture.executions,
        );
      });
      admissionTiming.callbackFinished();
      return "run" in persisted
        ? pendingLaunchCommitResult(args, accepted, persisted)
        : persisted;
    })().finally(() => {
      admissionTiming.recordLeafElapsed("persistence", leafStartedAt);
    });
  },
);
