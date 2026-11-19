import { publishChatThreadMessageCreated$ } from "./chat-event-publication.service";
import { loadEmailSourceMessageContext$ } from "./email-source-message.service";
import { STAFF_SINGLE_AGENT_ORG_ID } from "@okouai/core/single-agent-migration";
import { buildEmailPrompt } from "./email-prompt";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import { renderRunPrompts } from "./run-prompt-and-skills";
import { emailDeliveryTargetSchema } from "./email-chat-callback-payload";
import { performance } from "node:perf_hooks";
import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  DEFAULT_PROFILE,
} from "@okouai/api-contracts/contracts/runners";
import {
  autoRunBillingProvider,
  autoRunPricingLongContextMinTotalInputTokens,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { createThreadContext } from "./thread-context.signals";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { revokeDeletedWorkflowAutomationInputs$ } from "./workflow-automation-queue-revocation.service";
import {
  createOkouTokenInputSignals,
  prepareOkouToken$,
} from "./thread-okou-token.signals";
import { createConnectorAdmissionSignals } from "./thread-connector-environment.signals";
import { modelProviderPermissionManifest } from "./permission-manifest.service";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import { createOfficialWorkflowSignal } from "./thread-official-workflow.signals";
import { proactiveWorkflowKind } from "./proactive-workflow-definitions";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";
import type {
  ThreadModelError,
  ThreadModelSelection,
} from "./thread-model.signals";
import type {
  FeishuThreadContext,
  SlackThreadContext,
  TelegramThreadContext,
} from "./thread-run-context.service";
import {
  createPromptAndSkillVolumesSignals,
  type PromptAndSkillVolumes,
  PromptAndSkillVolumesError,
} from "./thread-run-prompt/prompt-and-skill-volumes";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
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
import type { TemplateUsageIdentity } from "../../lib/template-usage-identity";
import { recordTemplateUsage } from "../../lib/template-usage-log";

import { monotonicNow, now, nowDate, nowDateSql } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatIndicatorsChangedSafely,
  publishDesktopShellAuthorizationChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";

import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import {
  joinAllInOrder,
  onRejection,
  safeSync,
  settle,
  tapError,
} from "../utils";
import type { DirectRunDispatchResult } from "./direct-run-dispatch.service";
import type { AdmittedRunLaunch } from "./direct-run-preparation.service";
import {
  prepareRunPackageMounts,
  selectExecutionPackages,
} from "./execution-workflow-selection";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import {
  prepareRunnerReusePreference$,
  type RunnerReusePreparation,
} from "./runner-reuse-preference";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type {
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
  ResolvedModelProviderEnvironment,
  InternalRunCallback,
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
import {
  queuedThreadInputCondition,
  type QueuedUserMessage,
  type QueuedUserMessageContextType,
} from "./chat-queued-event.service";
import { finalizeClaimedRunUserMessage$ } from "./chat-run-event.service";
import { randomUUID } from "node:crypto";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import { agents } from "@okouai/db/schema/agent";
import {
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
import { morningBriefScheduleClaimBound$ } from "./morning-brief-schedule-claim.service";
import {
  OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowObservation,
} from "./official-workflow-run.service";
import { pendingLaunchBillingAttributionSql } from "./pending-launch-billing-plan";
import {
  type PendingLaunchClaim,
  pendingLaunchClaimFenceSql,
  pendingLaunchClaimProducerStatements,
} from "./pending-launch-claim-plan";
import { pendingLaunchInsertSql } from "./pending-launch-sql";
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
} from "./api-dispatch-timing.service";
import { maxAutonomyBudget$ } from "../autonomy-budget-limit";
import { childAutonomyBudget } from "./autonomy-budget.service";
import { parseCanonicalChatEventRequiredOfficialWorkflowIds } from "./canonical-chat-event-read.service";
import {
  prepareChatEvent,
  prepareChatEventReplacement,
  type LoadedChatEventReplacementTarget,
} from "./chat-event.service";
import { withRunModelAnnotation } from "./chat-user-message.service";
import { chatInputEnqueueCommits$ } from "./chat-input-enqueue-observation";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";
import type { ChatThreadContinuation } from "./chat-session-continuity.service";

import { DiscordQueuedLaunchUnavailableError } from "./discord-queued-launch-context.service";
import { WechatLaunchUnavailableError } from "./wechat-context.service";
import { isMemberSubscriptionRoute } from "./effective-model-route.service";

import { workflowRewardRunEventInsert } from "./workflow-reward-source-publication";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";

import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  getFrameworkForType,
  isBuiltInModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  type FeatureSwitchContext,
  isFeatureEnabled,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import type { SupportedFramework } from "@okouai/core/frameworks";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { isStaffOrg } from "@okouai/core/staff-org";
import type {
  AgentRunFullLaunchSnapshot,
  AgentRunLaunchSnapshot,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";

import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";

import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";

import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";

import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import type { PersistedStorageMount } from "@okouai/db/types";
import { command, type Command, computed, type Computed, state } from "ccstate";
import {
  and,
  asc,
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

import {
  normalizeRunMetadata,
  type RunMetadataValues,
} from "./agent-run-metadata-write.service";
import type { ChatThreadRequestFacts } from "./chat-thread-request-facts";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE } from "./official-workflow-policy.service";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import { isPersonalSubscriptionProviderType } from "./model-provider-account.service";
import type { ModelFirstPin } from "./model-selection.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

import { teamsDeliveryFromContext } from "./teams-queued-launch-context.service";

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
import { createStorageSignals } from "./thread-storage.signals";
import type { AcceptedMemoryMount } from "./execution-storage.service";
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
  readonly prompt: string;
  readonly model: ThreadModelSelection;
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
    prompt: args.prompt,
    threadId: input.threadId,
    queuedMessage: input.queuedMessage,
    selectedModel: model.pin.selectedModel,
    effectiveModelProvider: model.pin.modelProviderType,
    codexServiceTier: model.codexServiceTier,
    reasoningEffort: model.reasoningEffort,
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
    modelProvider: model.pin.modelProviderType,
    selectedModel: model.pin.selectedModel,
    codexServiceTier: model.codexServiceTier,
  };
}

function promptRunCommand(
  input: CreateQueuedChatRunInput,
  admissionTime: number,
): ThreadRunCommand {
  return {
    owner: { userId: input.userId, orgId: input.orgId },
    // Dispatch timing starts at admission; queue waiting is recorded separately.
    apiStartTime: admissionTime,
    chatThreadId: input.threadId,
    selectedModel: input.selectedModel,
    codexServiceTier: input.codexServiceTier,
    reasoningEffort: input.reasoningEffort,
    triggerSource: input.triggerSource,
    agentRunPreCreateSource: "chat_callback_auto_send",
    agentRunMetadata: { autonomyBudget: input.autonomyBudget },
    modelProvider: input.effectiveModelProvider,
    ...(input.realAgentInPreview ? { realAgentInPreview: true } : {}),
    ...(input.captureNetworkBodies ? { captureNetworkBodies: true } : {}),
  };
}

type ChatQueueRunAssembly =
  | {
      readonly kind: "assembled";
      readonly run: ThreadRunCommand;
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

interface QueuedAutomationEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly automationId: string;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
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
    proactiveWorkflowKind(args.workflowName) === "learning"
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
  readonly run: ThreadRunCommand;
  readonly producerBinding: Extract<
    ClaimProducerBinding,
    { kind: "automation" }
  >;
  readonly launchRecord: Extract<ClaimLaunchRecord, { kind: "automation" }>;
}

function automationSelectionCommand(
  args: Pick<
    AssembleWorkflowAutomationRunArgs,
    "due" | "apiStartTime" | "triggerSource"
  >,
  model: ThreadModelSelection,
  owner: ThreadRunOwner,
): ThreadRunCommand {
  const { chatThreadId } = args.due;
  return {
    owner,
    apiStartTime: args.apiStartTime,
    triggerSource: args.triggerSource ?? "automation-schedule",
    chatThreadId,
    ...threadRunModelFields(model),
    reasoningEffort: model.reasoningEffort ?? null,
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

interface RunPlan {
  readonly args: ThreadRunArgs;
  readonly integrationContext?: string;
  readonly runner: ThreadRunnerFacts;
  readonly persisted: ThreadRunPersistenceContext;
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
    readonly context: ThreadRunPersistenceContext;
    readonly args: ThreadRunPersistenceArgs;
  };
  readonly identity: ThreadLaunchCommitInput["identity"];
  readonly callbackRows: ThreadLaunchCommitInput["callbackRows"];
  readonly launch: ThreadLaunchCommitInput["launch"];
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
  args: ThreadRunPersistenceArgs,
): ThreadRunContext["input"]["args"] {
  return {
    userId: args.userId,
    orgId: args.orgId,
    triggerSource: args.triggerSource,
    apiStartTime: args.apiStartTime,
    chatThreadId: args.chatThreadId,
    agentRunMetadata: args.agentRunMetadata,
    modelSelection: args.modelSelection,
    codexServiceTier: args.codexServiceTier,
    timingDimensions: args.timingDimensions,
    threadContinuation: {
      expected: args.threadContinuation.expected,
      admission: args.threadContinuation.admission,
    },
  };
}

/**
 * The first route error among prepared resources, in plan, credit admission
 * and launch order.
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

/** Bind prepared launch facts to this admission's pending persistence. */
function finalizeClaimRunContext(
  context: Omit<ThreadRunContext, "persistence">,
  timing: ApiDispatchTimingCollector,
): ThreadRunContext {
  return {
    ...context,
    persistence: prepareAtomicLaunchPersistence({
      createArgs: context.input.args,
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
      readonly templateUsageIdentities: readonly TemplateUsageIdentity[];
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
): InternalRunCallback[] {
  const callbacks: InternalRunCallback[] = [];
  // Debug adds one delivery and never settles the daily schedule occurrence.
  const nightlyManual =
    eventType === "manual" &&
    automation.officialBlueprintKey === "nightly-learning";
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
  readonly callbacks: readonly InternalRunCallback[];
  readonly autonomyBudget: number;
  readonly recordLastRunId: boolean;
  readonly recordLastRunAt: boolean;
}

type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

function withEmailSystemPrompt(
  plan: RunPlan,
  prompt: {
    readonly appendSystemPrompt: string;
    readonly integrationContext: string;
  } | null,
): RunPlan {
  if (prompt === null) {
    return plan;
  }
  return {
    ...plan,
    integrationContext: prompt.integrationContext,
    persisted: {
      ...plan.persisted,
      content: {
        ...plan.persisted.content,
        appendSystemPrompt: prompt.appendSystemPrompt,
      },
    },
  };
}

function claimCommitInput(input: RunPlan): ThreadRunContext["input"] {
  return {
    args: claimCommitArguments(input.args),
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
      emailDelivery: input.emailDelivery,
      agentphoneDelivery: input.agentphoneDelivery,
    },
  };
}

/**
 * Generation writes a title only over NULL title and renamed_at, and a rename
 * sets both, so a titled or renamed claim snapshot never needs another read.
 */
function threadTitled(
  thread:
    | { readonly title: string | null; readonly renamedAt: Date | null }
    | null
    | undefined,
) {
  return (
    thread !== null &&
    thread !== undefined &&
    (thread.title !== null || thread.renamedAt !== null)
  );
}

function claimLaunchRecord(
  record: ClaimLaunchRecord,
  integrationContext: string | undefined,
): ClaimLaunchRecord {
  if (record.kind === "automation") {
    return record;
  }
  const input = record.context.runInput;
  return {
    kind: "prompt",
    timing: record.timing,
    templateUsageIdentities: record.templateUsageIdentities,
    context: {
      userId: record.context.userId,
      integrationContext:
        input.triggerSource === "web" || input.triggerSource === "agent"
          ? undefined
          : integrationContext,
      titled: record.context.titled,
      runInput: {
        orgId: input.orgId,
        threadId: input.threadId,
        prompt: input.prompt,
        discordDelivery: input.discordDelivery,
        wechatDelivery: input.wechatDelivery,
        triggerSource: input.triggerSource,
      },
    },
  };
}

type PendingClaimRun = {
  readonly kind: "pending";
  readonly marketingRewardEventId: string | null;
  readonly runId: string;
  readonly apiStartTime: number;
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
  readonly threadResources$: Computed<Promise<void>>;
  /** Entry-owned early reads; consumers retain their individual dependencies. */
  readonly inputResources$: Computed<Promise<void>>;
  readonly threadHasActiveRun$: Computed<Promise<boolean>>;
  readonly hasFirstPickableChatEvent$: Computed<Promise<boolean>>;
  readonly orgHasCapacity$: Computed<Promise<boolean>>;
  readonly admittedLaunch$: Computed<Promise<AdmittedRunLaunch>>;
  readonly admitRun$: Command<
    Promise<PendingClaimRun | null>,
    [signal: AbortSignal]
  >;
  readonly publishPendingRun$: Command<
    Promise<void>,
    [pending: PendingClaimRun, signal: AbortSignal]
  >;
  readonly finishPendingRun$: Command<
    Promise<void>,
    [
      pending: PendingClaimRun,
      dispatched: DirectRunDispatchResult,
      signal: AbortSignal,
    ]
  >;
}

/** Construct the Thread-owned admission and publication graph. */
export function createThreadClaimRunObjects(
  claim: ThreadClaim,
  bootstrap: AgentRunContextSignals,
  requestFacts: ChatThreadRequestFacts | undefined,
): ThreadClaimRunObjects {
  const claimCatalog$ = bootstrap.modelCatalog$;
  const pickStartedAt$ = computed(() => {
    return now();
  });
  const internalCommittedRunId$ = state<string | null>(null);
  const internalAdmittedLaunch$ = state<AdmittedRunLaunch | null>(null);
  const admittedLaunch$ = computed((get) => {
    const admitted = get(internalAdmittedLaunch$);
    if (admitted === null) {
      throw new Error("Execution requires this graph's committed admission");
    }
    return Promise.resolve(admitted);
  });
  const publishChatQueueHeadConsumed$ = command(
    async (
      { set },
      head: {
        readonly chatThreadId: string;
        readonly orgId: string;
        readonly userId: string;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      await set(
        publishChatThreadMessageCreated$,
        {
          userId: head.userId,
          orgId: head.orgId,
          threadId: head.chatThreadId,
        },
        signal,
      );
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
            {
              capture_scope: "request_observed_commit",
              ...(requestFacts?.input.enqueueObservationId
                ? {
                    enqueue_observation_id:
                      requestFacts.input.enqueueObservationId,
                  }
                : {}),
            },
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
  const threadHasActiveRun$ = computed(async (get) => {
    return (await get(preparation$)).threadHasActiveRun;
  });
  const pickedEvent$ = computed(async (get) => {
    return (await get(preparation$)).pickedEvent;
  });
  const chatThreadId = claim.chatThreadId;
  const threadContext = createThreadContext(
    bootstrap,
    pickedEvent$,
    chatThreadId,
  );
  const threadResources$ = computed(async (get) => {
    // Request feature/member facts are already warm. Cold background picks
    // retain demand loading rather than expanding optional sources on rejection.
    if (requestFacts) {
      await get(threadContext.threadConnectorSources$);
    }
  });
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
  const automationEvent$ = threadContext.automationContext$;
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
  const promptInput$ = computed(
    async (get): Promise<QueuedPromptGraphInput> => {
      const head = await get(head$);
      return {
        head,
        timing: get(promptTiming$),
        runTiming: get(claimRunTiming$).run,
      };
    },
  );
  const queuedInput$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event) {
      return null;
    }
    if (!event.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }
    return { ...event, userMessage: event.userMessage };
  });
  const promptMessage$ = computed(
    async (get): Promise<QueuedUserMessage | null> => {
      const event = await get(queuedInput$);
      if (event?.eventType !== "input.prompt") {
        return null;
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
      if (event.preparation.isOfficialWorkflowThread) {
        throw new QueuedPromptLaunchUnavailableError(
          OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE,
        );
      }
      return {
        id: event.id,
        createdAt: event.createdAt,
        userMessage: event.userMessage,
        requiredOfficialWorkflowIds: requiredOfficialWorkflowIds ?? undefined,
        selectedModel: event.modelSelection?.selectedModel ?? null,
        contextType: event.contextType,
        contextId: event.contextId,
        autonomyBudget: queuedUserMessageAutonomyBudget(
          event.contextType,
          event.sourceAutonomyBudget,
          get(maxAutonomyBudget$),
        ),
      };
    },
  );
  const promptArgs$ = computed(
    async (get): Promise<CreateQueuedChatRunInputArgs> => {
      const { head, timing } = await get(promptInput$);
      const queuedMessage = await get(promptMessage$);
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
  const emailPromptMaterial$ = computed(
    async (get): Promise<QueuedLaunchMaterial> => {
      if (
        !isFeatureEnabled(
          FeatureSwitchKey.EmailIntegration,
          await get(bootstrap.featureSwitches$),
        )
      ) {
        throw new QueuedPromptLaunchUnavailableError();
      }
      const context = await get(threadContext.emailContext$);
      if (!context) {
        throw new QueuedPromptLaunchUnavailableError();
      }
      return {
        triggerSource: "email",
        delivery: { emailDelivery: emailDeliveryTargetSchema.parse(context) },
      };
    },
  );
  const promptMaterial$ = computed(
    async (get): Promise<QueuedLaunchMaterial> => {
      const { queuedMessage } = await get(promptArgs$);
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
              teamsDelivery: teamsDeliveryFromContext(context),
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
        case "email": {
          return await get(emailPromptMaterial$);
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
  const runTemplates$ = threadContext.templates$;
  const captureNetworkBodies$ = computed(async (get) => {
    const { head } = await get(promptInput$);
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
  const promptRunInput$ = computed(
    async (
      get,
    ): Promise<
      | {
          readonly runInput: CreateQueuedChatRunInput;
          readonly templateUsageIdentities: readonly TemplateUsageIdentity[];
        }
      | QueuedMessageAdmissionFailure
    > => {
      const [args, launch, model, session, capture, features, templates] =
        await Promise.all([
          get(promptArgs$),
          get(promptMaterial$),
          get(threadContext.modelSelection$),
          get(threadContext.threadContinuation$),
          get(captureNetworkBodies$),
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
      return {
        runInput: queuedPromptRunInput({
          input: args,
          launch,
          prompt: promptAndSkills.userPrompt,
          model,
          capture,
          features,
        }),
        templateUsageIdentities: templates.templateUsageIdentities,
      };
    },
  );
  const earlyPromptAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly | null> => {
      const head = await get(head$);
      const selected = await settle(get(promptMessage$));
      if (!selected.ok) {
        return queuedPromptPreparationRejection(selected.error, head);
      }
      return selected.value?.id === head.id ? null : { kind: "not-ready" };
    },
  );
  const recordPromptQueueAge$ = command(
    async (
      { get },
      head: ChatQueueHeadContext,
      signal: AbortSignal,
    ): Promise<void> => {
      const early = await get(earlyPromptAssembly$);
      signal.throwIfAborted();
      if (early) {
        return;
      }
      const queued = await get(promptMessage$);
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
    },
  );
  const promptAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const early = await get(earlyPromptAssembly$);
      if (early) {
        return early;
      }
      const input = await get(promptInput$);
      const { head, timing } = input;
      const prepared = await settle(
        (async () => {
          const startedAt = now();
          const result = await onRejection(
            (async () => {
              return await get(promptRunInput$);
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
      const preparedInput = prepared.value;
      if ("kind" in preparedInput) {
        return {
          kind: "rejected",
          rejection: queuedMessageRejection(preparedInput),
        };
      }
      const { runInput, templateUsageIdentities } = preparedInput;
      return {
        kind: "assembled",
        run: promptRunCommand(runInput, head.apiStartTime),
        producerBinding: null,
        rejection: { kind: "prompt", runInput },
        launchRecord: {
          kind: "prompt",
          timing,
          templateUsageIdentities,
          context: {
            userId: head.userId,
            titled: threadTitled((await get(pickedEvent$))?.thread),
            runInput,
          },
        },
      };
    },
  );
  const promptResourcesValid$ = computed(async (get) => {
    const [material, templates] = await Promise.all([
      settle(get(promptMaterial$)),
      get(runTemplates$),
    ]);
    if (!material.ok) {
      queuedPromptPreparationRejection(
        material.error,
        (await get(promptInput$)).head,
      );
      return false;
    }
    return !("error" in templates);
  });
  const promptIdentity$ = computed(async (get) => {
    if (await get(earlyPromptAssembly$)) {
      return null;
    }
    const { head, runTiming: timing } = await get(promptInput$);
    const args = await get(promptArgs$);
    return {
      timing,
      owner: { userId: args.userId, orgId: args.agent.orgId },
      apiStartTime: head.apiStartTime,
      agentId: args.agent.id,
    };
  });
  const promptSelection$ = computed(async (get) => {
    const identity = await get(promptIdentity$);
    if (!identity) {
      return null;
    }
    const [args, model] = await Promise.all([
      get(promptArgs$),
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
        chatThreadId: args.threadId,
        ...threadRunModelFields(model),
        reasoningEffort: model.reasoningEffort,
      },
    };
  });
  const availablePromptMaterial$ = computed(async (get) => {
    if (await get(earlyPromptAssembly$)) {
      return null;
    }
    const material = await settle(get(promptMaterial$));
    if (!material.ok) {
      queuedPromptPreparationRejection(
        material.error,
        (await get(promptInput$)).head,
      );
      return null;
    }
    return material.value;
  });
  const promptCallbacks$ = computed(async (get) => {
    if (await get(earlyPromptAssembly$)) {
      return undefined;
    }
    const [args, material] = await Promise.all([
      get(promptArgs$),
      get(availablePromptMaterial$),
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
  const automationTarget$ = threadContext.automationTarget$;
  const automationSourceBudget$ = computed(async (get) => {
    const event = await get(automationEvent$);
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
  const automationBudget$ = computed(
    async (get): Promise<AutonomyBudgetResult> => {
      const [event, target, source] = await Promise.all([
        get(automationEvent$),
        get(automationTarget$),
        get(automationSourceBudget$),
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
  const automationMaterial$ = computed(async (get) => {
    const [event, target] = await Promise.all([
      get(automationEvent$),
      get(automationTarget$),
    ]);
    if (!event || !target) {
      return null;
    }
    return buildWorkflowAutomationQueuedLaunchMaterial({
      // Staff migration retains queued event bytes while reassigning the live
      // Automation. Resolve its new execution name without rewriting history.
      // Remove after every pre-cutover queued input has drained.
      workflowName:
        target.workflow.orgId === STAFF_SINGLE_AGENT_ORG_ID
          ? target.workflow.name
          : event.workflowName,
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
          get(automationEvent$),
          get(automationTarget$),
          get(automationMaterial$),
          get(automationBudget$),
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
  const automationModel$ = computed(
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
      get(automationEvent$),
      get(automationTarget$),
    ]);
    if (!event || !target) {
      return null;
    }
    return {
      due: { ...target, chatThreadId: event.chatThreadId },
      apiStartTime: head.apiStartTime,
      queueEventId: event.id,
      triggerSource: manualTriggerSource(target.automation),
    };
  });
  const automationIdentity$ = computed(async (get) => {
    const args = await get(automationExecutionInput$);
    if (!args) {
      return null;
    }
    return {
      timing: get(threadContext.dispatchTiming$),
      owner: { orgId: bootstrap.orgId, userId: bootstrap.userId },
      agentId: bootstrap.agentId,
    };
  });
  const automationSelection$ = computed(async (get) => {
    const [identity, model, args] = await Promise.all([
      get(automationIdentity$),
      get(automationModel$),
      get(automationExecutionInput$),
    ]);
    return identity && !("kind" in model) && args
      ? {
          timing: identity.timing,
          command: automationSelectionCommand(args, model, identity.owner),
        }
      : null;
  });
  const assembleWorkflowAutomationRun$ = computed(
    async (get): Promise<AssembledWorkflowAutomationRun | RunFailure> => {
      const args = await get(automationLaunchReadinessInput$);
      const [selection, model] = await Promise.all([
        get(automationSelection$),
        get(automationModel$),
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
  const prepareAutomationRun$ = command(
    async ({ get }, signal: AbortSignal): Promise<void> => {
      const assembly = await get(assembleWorkflowAutomationRun$);
      signal.throwIfAborted();
      if (assembly.kind === "assembled") {
        get(threadContext.dispatchTiming$).recordElapsed(
          "api_dispatch_pre_create_agent_workflow_automation_create_run",
          "nested",
          now(),
        );
      }
    },
  );
  // A head whose automation input can no longer be read is rejected from its
  // captured reads.
  const earlyAutomationAssembly$ = computed(
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
  const recordAutomationEntryTiming$ = command(
    (
      _store,
      head: ChatQueueHeadContext,
      runTiming: ApiDispatchTimingCollector,
      signal: AbortSignal,
    ): void => {
      signal.throwIfAborted();
      // Records the entrypoint gap on the claim's run timing.
      workflowAutomationTiming(runTiming, head.apiStartTime);
    },
  );
  const prepareAutomationLaunch$ = command(
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
        get(automationEvent$),
        get(automationTarget$),
        get(automationSourceBudget$),
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
          "learning"
      ) {
        return rejectedAutomationLaunch(
          unreadable(OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE),
        );
      }
      const target = loadedTarget;
      const [material, autonomyBudget] = await Promise.all([
        get(automationMaterial$),
        get(automationBudget$),
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
      const timing = get(threadContext.dispatchTiming$);
      const startedAt = performance.now();
      await (async () => {
        await get(automationModel$);
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
  const automationAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const early = await get(earlyAutomationAssembly$);
      if (early) {
        return early;
      }
      const [assembled, target] = await Promise.all([
        get(assembleWorkflowAutomationRun$),
        get(automationTarget$),
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
  const automationCallbacks$ = computed(async (get) => {
    if (await get(earlyAutomationAssembly$)) {
      return undefined;
    }
    return (await get(automationMaterial$))?.callbacks;
  });
  const isAutomation$ = computed(async (get) => {
    return (await get(head$)).contextType === "automation";
  });
  const assembly$ = computed(async (get) => {
    return get(
      (await get(isAutomation$)) ? automationAssembly$ : promptAssembly$,
    );
  });
  const identityInput$ = computed(
    async (get): Promise<ThreadRunIdentityInput | null> => {
      return (await get(isAutomation$))
        ? get(automationIdentity$)
        : get(promptIdentity$);
    },
  );
  const selectionInput$ = computed(
    async (get): Promise<ThreadRunSelectionInput | null> => {
      return (await get(isAutomation$))
        ? get(automationSelection$)
        : get(promptSelection$);
    },
  );
  const assembledRun$ = computed(async (get) => {
    const assembly = await get(assembly$);
    return assembly.kind === "assembled" ? assembly.run : null;
  });
  const callbackInputs$ = computed(
    async (get): Promise<readonly InternalRunCallback[] | undefined> => {
      return (await get(isAutomation$))
        ? get(automationCallbacks$)
        : get(promptCallbacks$);
    },
  );
  const threadContinuation$ = computed(
    async (get): Promise<ChatThreadContinuation | undefined> => {
      if (!(await get(isAutomation$)) && (await get(earlyPromptAssembly$))) {
        return undefined;
      }
      return (await get(threadContext.threadContinuation$)) ?? undefined;
    },
  );
  const selectedRunInput$ = computed(
    async (get): Promise<ThreadRunSelectionInput> => {
      const input = await get(selectionInput$);
      if (!input) {
        throw new Error("Agent preparation has no selected input");
      }
      return input;
    },
  );
  const selectedIdentity$ = computed(
    async (get): Promise<ThreadRunIdentityInput> => {
      const input = await get(identityInput$);
      if (!input) {
        throw new Error("Run identity is unavailable");
      }
      return input;
    },
  );
  const selectedAgentId$ = computed(async (get) => {
    const { agentId, timing } = await get(selectedIdentity$);
    // A Thread run always names its queue head's Agent.
    const startedAt = performance.now();
    return await (async () => {
      return await Promise.resolve(agentId);
    })().finally(() => {
      timing.recordDuration(
        "api_dispatch_pre_create_agent_resolve_agent_id",
        "nested",
        performance.now() - startedAt,
        now(),
      );
    });
  });
  const selectedAgent$ = computed(
    async (get): Promise<AgentRunRecord | null> => {
      const { timing } = await get(selectedIdentity$);
      const agentId = await get(selectedAgentId$);
      if (!agentId) {
        return null;
      }
      const startedAt = performance.now();
      return await (async () => {
        // Authorization waits only for the context's Agent snapshot.
        return await get(bootstrap.agent$);
      })().finally(() => {
        timing.recordDuration(
          "api_dispatch_pre_create_agent_load_agent",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      });
    },
  );
  const runPreparation$ = computed(
    async (get): Promise<ThreadRunPreparation | CreateRunErrorResult> => {
      const [agentResult, model] = await Promise.all([
        get(selectedAgent$),
        get(threadContext.subscriptionSelection$),
      ]);
      const agent = agentResult;
      if ("status" in model) {
        return model;
      }
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      return {
        modelSelection: model.pin,
      };
    },
  );
  const preparedRunInput$ = computed(async (get) => {
    const [input, resolution, fullCommand] = await Promise.all([
      get(runPreparation$),
      get(threadContinuation$),
      get(assembledRun$),
    ]);
    if (!fullCommand) {
      return null;
    }
    if ("status" in input) {
      return input;
    }
    if (!resolution) {
      throw new Error(
        "Prepared Thread input is missing its captured continuation",
      );
    }
    return {
      ...input,
      command: fullCommand,
      threadContinuation: resolution,
    };
  });
  const runArgs$ = computed(async (get) => {
    const input = await get(preparedRunInput$);
    if (!input || "status" in input) {
      return input;
    }
    const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
    if (isRouteError(promptAndSkills)) {
      return promptAndSkills;
    }
    return buildThreadRunArgs(input, promptAndSkills);
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
          // Source admission preserves the channel-specific rejection code.
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
  const connectorAdmission$ = createConnectorAdmissionSignals(
    bootstrap,
    threadContext,
  );
  const officialWorkflow$ = createOfficialWorkflowSignal(
    pickedEvent$,
    threadContext,
  );
  const storage$ = createStorageSignals(bootstrap, pickedEvent$, threadContext);
  const contextArgs$ = computed(async (get) => {
    const selected = await get(runArgs$);
    if (!selected || "status" in selected) {
      throw new Error("Run context requires an authorized ready input");
    }
    return selected;
  });
  const execution$ = computed(
    async (get): Promise<ThreadExecution | CreateRunErrorResult> => {
      const [{ command }, agent] = await Promise.all([
        get(selectedRunInput$),
        get(selectedAgent$),
      ]);
      if (!agent) {
        throw new Error("Agent disappeared after preparation authorization");
      }
      if (agent.orgId !== command.owner.orgId) {
        return notFound("Agent not found");
      }
      return {
        agentId: agent.id,
        orgId: agent.orgId,
      };
    },
  );
  const contentContext$ = computed(async (get) => {
    const [args, resolved, vars, requestedFramework, featureSwitchContext] =
      await Promise.all([
        get(contextArgs$),
        get(execution$),
        get(bootstrap.runVariables$),
        get(runFramework$),
        get(bootstrap.featureSwitches$),
      ]);
    if (isRouteError(resolved)) {
      return resolved;
    }
    if (resolved.orgId !== args.orgId) {
      return notFound("Resource not found");
    }
    if (isRouteError(requestedFramework)) {
      return requestedFramework;
    }
    return {
      resolved,
      content: {
        prompt: args.prompt,
        appendSystemPrompt: args.appendSystemPrompt,
        triggerSource: args.triggerSource,
        vars,
      },
      featureSwitchContext,
    };
  });
  const runtimeContext$ = computed(async (get) => {
    const [contentContext, modelProvider, connector] = await Promise.all([
      get(contentContext$),
      get(modelRoute$),
      get(connectorAdmission$),
    ]);
    if (isRouteError(contentContext)) {
      return contentContext;
    }
    if (isRouteError(modelProvider)) {
      return modelProvider;
    }
    if (isRouteError(connector)) {
      return connector;
    }
    const providerPermissions = safeSync(() => {
      return modelProviderPermissionManifest(
        modelProvider,
        contentContext.content.vars,
      );
    });
    if ("error" in providerPermissions) {
      if (providerPermissions.error instanceof FirewallBaseUrlResolutionError) {
        return badRequestMessage(providerPermissions.error.message);
      }
      throw providerPermissions.error;
    }
    const catalog = await get(claimCatalog$);
    const usage = prepareModelUsageContext({
      catalog,
      modelProvider,
      permissionManifest: {
        firewalls: [
          ...(providerPermissions.ok?.firewalls ?? []),
          ...(connector.permissions?.firewalls ?? []),
        ],
        billableFirewalls: connector.permissions?.billableFirewalls ?? [],
      },
      routePricing: runRoutePricingFromSnapshot(
        {
          modelProvider,
          serviceTier: (await get(contextArgs$)).codexServiceTier,
        },
        await get(bootstrap.modelPricing$),
      ),
    });
    if ("kind" in usage) {
      return providerUnavailable(usage.message);
    }
    return {
      framework: modelProviderFramework(modelProvider),
      modelProvider,
      connectorEnvironment: connector.environment,
      connectorNetworkPolicyInputs: connector.networkPolicyInputs,
      modelProviderPermissions: providerPermissions.ok,
    };
  });
  const executionPlan$ = computed(async (get) => {
    const args = await get(contextArgs$);
    const gate = enforceCaptureNetworkBodiesGate(
      args.orgId,
      args.captureNetworkBodies,
    );
    if (gate) {
      return gate;
    }
    const [
      contentContext,
      runtimeContext,
      selectedImageModel,
      officialWorkflowRun,
    ] = await Promise.all([
      get(contentContext$),
      get(runtimeContext$),
      get(bootstrap.selectedImageModel$),
      get(officialWorkflow$),
    ]);
    if (isRouteError(contentContext)) {
      return contentContext;
    }
    if (isRouteError(runtimeContext)) {
      return runtimeContext;
    }
    if (isRouteError(officialWorkflowRun)) {
      return officialWorkflowRun;
    }
    const { content } = contentContext;
    const { modelProvider, framework } = runtimeContext;
    const { resolved } = contentContext;
    const promptAndSkills = await get(preparedPromptAndSkillVolumes$);
    if (isRouteError(promptAndSkills)) {
      return promptAndSkills;
    }
    const launchFramework =
      modelProvider.piModelConfig === undefined ? framework : ("pi" as const);
    const packageMounts = prepareRunPackageMounts({
      framework: launchFramework,
      skillVolumes: promptAndSkills.skillVolumes,
      officialWorkflow: officialWorkflowRun,
    });
    return {
      content,
      resolved,
      modelProvider,
      connectorEnvironment: runtimeContext.connectorEnvironment,
      connectorNetworkPolicyInputs: runtimeContext.connectorNetworkPolicyInputs,
      modelProviderPermissions: runtimeContext.modelProviderPermissions,
      integrationContext:
        promptAndSkills.systemPromptVariables.integrationContext,
      userTimezone: promptAndSkills.userTimezone,
      launchFramework,
      officialWorkflowProvenance: officialWorkflowRun?.provenance,
      ...packageMounts,
      featureSwitchContext: contentContext.featureSwitchContext,
      selectedImageModel,
    };
  });
  const preparedRunPlan$ = computed(async (get) => {
    const selected = await get(runArgs$);
    if (!selected || "status" in selected) {
      return selected;
    }
    return get(executionPlan$);
  });
  const authorizeSelectedAgentRun$ = computed(async (get) => {
    const [identity, agent] = await Promise.all([
      get(selectedIdentity$),
      get(selectedAgent$),
    ]);
    if (!agent || agent.orgId !== identity.owner.orgId) {
      return notFound("Agent not found");
    }
    if (
      agent.visibility === "private" &&
      agent.owner !== identity.owner.userId
    ) {
      return agentRunsCreateForbidden(
        "Only the private agent owner can run this agent",
      );
    }
    return undefined;
  });
  const checkRunAdmission$ = command(
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
        get(officialWorkflow$),
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

  const commitQueueHeadRejection$ = command(
    async (
      { get, set },
      args: {
        readonly errorMarker: string;
        readonly displayError: string;
        readonly lease?: ThreadClaim;
      },
      signal: AbortSignal,
    ): Promise<string | null> => {
      const source = await get(queuedInput$);
      signal.throwIfAborted();
      if (!source) {
        throw new Error("Claim has no picked event");
      }
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
          // Keep queued message payloads out of SQL failure diagnostics.
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
      return result.assistantEventId;
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
      const assistantEventId = await set(
        commitQueueHeadRejection$,
        { errorMarker: error.code.toLowerCase(), displayError, lease },
        signal,
      );
      signal.throwIfAborted();
      if (assistantEventId === null) {
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
            assistantEventId,
            signal,
          )
        : error.code === "INTERNAL_ERROR" && agentId !== null
          ? set(
              deliverUnexpectedQueuedPromptRejection$,
              {
                head: { ...head, agentId },
                assistantEventId,
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
        get(runArgs$),
        get(preparedRunPlan$),
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
      const args = await get(contextArgs$);
      const modelProvider = context.modelProvider;
      const launchSnapshot = {
        schemaVersion: 5 as const,
        framework: context.launchFramework,
        runnerProfile: DEFAULT_PROFILE,
      };
      const { content } = context;
      const event = await get(queuedInput$);
      if (!event) {
        throw new Error("Run preparation requires its selected input");
      }
      let integration: string | undefined;
      switch (event.contextType) {
        case "web":
        case "agent_run": {
          integration = "web";
          break;
        }
        case "automation": {
          integration = undefined;
          break;
        }
        case "feishu": {
          integration = (await get(feishuContext$))?.platform;
          break;
        }
        case "agentphone": {
          integration =
            (await get(agentPhoneContext$))?.channel === "whatsapp"
              ? "whatsapp"
              : "phone";
          break;
        }
        default: {
          integration = event.contextType ?? undefined;
        }
      }
      const { officialWorkflowProvenance, selectedImageModel } = context;
      return {
        args,
        integrationContext: context.integrationContext,
        persisted: {
          inputEvent: event,
          content,
          selectedImageModel,
          launchSnapshot,
          officialWorkflowProvenance,
          resolved: {
            agentId: context.resolved.agentId,
          },
          modelProvider: {
            credentialOwner: modelProvider.credentialOwner,
            accountIdentity: modelProvider.accountIdentity,
            id: modelProvider.id,
            type: modelProvider.type,
            selectedModel: modelProvider.selectedModel,
            upstreamModel: modelProvider.upstreamModel,
            builtInModelRuntimeRoute: modelProvider.builtInModelRuntimeRoute,
          },
        },
        runner: {
          workflowAutomationId: args.agentRunMetadata.workflowAutomationId,
          agentId: context.resolved.agentId,
          protectedMountPaths: context.protectedMountPaths,
          nativeContinuation:
            args.threadContinuation.executionSnapshot.nativeContinuation,
          realAgentInPreview: args.realAgentInPreview,
          profile: launchSnapshot.runnerProfile,
          featureSwitchContext: context.featureSwitchContext,
          facts: {
            skillRoot: context.skillRoot,
            skillMounts: context.skillMounts,
            officialWorkflowBundles: context.officialWorkflowBundles,
            integration,
            captureNetworkBodies: args.captureNetworkBodies === true,
            modelProvider,
            modelProviderPermissions: context.modelProviderPermissions,
            connectorEnvironment: context.connectorEnvironment,
            connectorNetworkPolicyInputs: context.connectorNetworkPolicyInputs,
            userTimezone: context.userTimezone,
          },
          apiStartTime: await get(runnerApiStartTime$),
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
      (await get(automationBudget$)).kind === "invalid"
    ) {
      return false;
    }
    const [selection, validSource] = await Promise.all([
      get(selectionInput$),
      (await get(isAutomation$)) ? true : get(promptResourcesValid$),
    ]);
    return !!selection && validSource;
  });
  // Storage is read only for an admitted source. Rejections come from the Run
  // plan; storage runs alongside it and its failure matters only when the plan
  // is ready.
  const preparedStorage$ = computed(
    async (
      get,
    ): Promise<
      readonly AcceptedMemoryMount[] | CreateRunErrorResult | null
    > => {
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
  /** Captured launch facts before Run-scoped token creation. */
  const runnerFacts$ = computed(async (get) => {
    const [input, allowed] = await Promise.all([
      get(runPlan$),
      get(resourceAllowed$),
    ]);
    if (!allowed) {
      return null;
    }
    if (!input || isRouteError(input)) {
      return input;
    }
    return input.runner;
  });
  /** The run token makes runner input a command; its result is passed on. */
  const prepareRunnerInput$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const args = await get(runnerFacts$);
      signal.throwIfAborted();
      if (!args || isRouteError(args)) {
        return args;
      }
      const customWorkflowSelection = {
        agentId: args.agentId,
        ...(args.workflowAutomationId === undefined
          ? {}
          : { automationId: args.workflowAutomationId }),
        protectedMountPaths: [...args.protectedMountPaths],
      };
      const officialMountPaths = args.facts.officialWorkflowBundles.map(
        ({ mountPath }) => {
          return mountPath;
        },
      );
      const timing = get(threadContext.dispatchTiming$);
      const [
        tokenInput,
        packageSources,
        ordinaryAutomation,
        disabledPaidTools,
      ] = await Promise.all([
        get(okouTokenInput$),
        timing.measure(
          "api_dispatch_prepare_execution_package_wait",
          "nested",
          () => {
            return get(threadContext.executionPackageSources$);
          },
        ),
        args.workflowAutomationId &&
        args.facts.officialWorkflowBundles.length === 0
          ? get(automationTarget$)
          : null,
        get(bootstrap.disabledPaidTools$),
      ]);
      signal.throwIfAborted();
      const executionPackages = selectExecutionPackages(packageSources, {
        skillRoot: args.facts.skillRoot,
        protectedMountPaths: [
          ...args.protectedMountPaths,
          ...officialMountPaths,
        ],
        singleAgent: isFeatureEnabled(
          FeatureSwitchKey.SingleAgent,
          args.featureSwitchContext,
        ),
        ordinaryAutomation,
      });
      if (!executionPackages) {
        return conflict("Run packages or source authorization are unavailable");
      }
      const okouToken = set(prepareOkouToken$, tokenInput, signal);
      return prepareRunnerLaunch({
        args,
        customWorkflowSelection,
        executionPackages,
        okouToken,
        disabledPaidTools,
      });
    },
  );
  const callbackRows$ = computed(async (get) => {
    const identity = get(runIds$);
    const callbacks = await get(callbackInputs$);
    return (callbacks ?? []).map((callback): AgentRunCallbackInsert => {
      // Normalize payloads to JSON: omit optional fields and serialize Dates.
      const serializedPayload = JSON.stringify(callback.payload);
      const payload =
        serializedPayload === undefined
          ? null
          : json().parse(JSON.parse(serializedPayload) as unknown);
      return {
        runId: identity.runId,
        url: null,
        internalKind: callback.internalKind,
        encryptedSecret: null,
        payload,
      };
    });
  });
  const prepareRunnerStorage$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const [input, preparedStorage] = await Promise.all([
        set(prepareRunnerInput$, signal),
        get(preparedStorage$),
      ]);
      signal.throwIfAborted();
      if (!input || isRouteError(input)) {
        return input;
      }
      if (!preparedStorage || isRouteError(preparedStorage)) {
        return preparedStorage;
      }
      return {
        ...input,
        memoryMounts: preparedStorage,
        runStorageMounts: preparedStorage.map(({ mount }) => {
          return mount;
        }),
      };
    },
  );
  const checkClaimAdmission$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (!(await get(selectionInput$))) {
        signal.throwIfAborted();
        return undefined;
      }
      const [input, model] = await Promise.all([
        get(selectedRunInput$),
        get(modelRoute$),
      ]);
      signal.throwIfAborted();
      if (isRouteError(model)) {
        if (
          model.body.error.code === "PROVIDER_UNAVAILABLE" &&
          isBuiltInModelProviderType(input.command.modelProvider)
        ) {
          const credits = await set(
            checkRunAdmission$,
            {
              catalog: await get(claimCatalog$),
              orgId: claim.orgId,
              userId: input.command.owner.userId,
              modelProviderType: "built-in",
              selectedModel: input.command.selectedModel,
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
      const rejection = await set(
        checkRunAdmission$,
        {
          catalog: await get(claimCatalog$),
          orgId: claim.orgId,
          userId: input.command.owner.userId,
          modelProviderType: model.type,
          selectedModel: model.selectedModel,
          enforceBuiltInCredits: isBuiltInModelProviderType(model.type),
        },
        signal,
      );
      if (rejection || input.command.codexServiceTier !== "ultrafast") {
        return rejection;
      }
      const context = await get(contentContext$);
      signal.throwIfAborted();
      if (isRouteError(context)) {
        return context;
      }
      return isFeatureEnabled(
        FeatureSwitchKey.CodexSubscriptionUltrafast,
        context.featureSwitchContext,
      )
        ? null
        : badRequestMessage("Ultrafast is unavailable in this workspace");
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
        await set(recordAutomationEntryTiming$, head, timing.run, signal);
        const [event, target] = await Promise.all([
          get(automationEvent$),
          get(automationTarget$),
        ]);
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
        await set(recordPromptQueueAge$, head, signal);
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
            ? await get(earlyAutomationAssembly$)
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
  const prepareEmailSystemPrompt$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<{
      readonly appendSystemPrompt: string;
      readonly integrationContext: string;
    } | null> => {
      const email = await get(threadContext.emailContext$);
      signal.throwIfAborted();
      if (!email) {
        return null;
      }
      const mailboxes = await get(threadContext.emailMailboxConnections$);
      signal.throwIfAborted();
      if (mailboxes.length === 0) {
        return null;
      }
      const [snapshot, policies, featureSwitchContext, promptAndSkills] =
        await Promise.all([
          get(bootstrap.catalog$),
          get(bootstrap.permissionPolicies$),
          get(bootstrap.featureSwitches$),
          get(promptAndSkillVolumes$),
        ]);
      signal.throwIfAborted();
      if (!snapshot) {
        throw new Error(
          "Email mailbox context requires its authorized catalog",
        );
      }
      const messageContext = await set(
        loadEmailSourceMessageContext$,
        {
          email,
          mailboxes,
          snapshot,
          policies,
          featureSwitchContext,
          orgId: bootstrap.orgId,
          userId: bootstrap.userId,
        },
        signal,
      );
      const integrationContext = buildEmailPrompt(
        email,
        resolveIntegrationNotePrompt({
          triggerSource: "email",
          featureSwitchContext,
          emailHasConnectedMailbox: true,
        }),
        mailboxes,
        messageContext,
      );
      return {
        integrationContext,
        appendSystemPrompt: renderRunPrompts({
          systemPromptVariables: {
            ...promptAndSkills.systemPromptVariables,
            integrationContext,
          },
          userPromptVariables: { message: promptAndSkills.userPrompt },
          skillVolumes: promptAndSkills.skillVolumes,
        }).systemPrompt,
      };
    },
  );
  /** Join Email prompt enrichment and the independent Runner inputs. */
  const prepareRunnerResources$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const original = await get(runPlan$);
      signal.throwIfAborted();
      // Email enrichment can persist refreshed credentials. Keep it owned by
      // this preparation even if the Runner inputs fail first.
      const [emailPrompt, launch] = await joinAllInOrder(
        [
          original && !isRouteError(original)
            ? set(prepareEmailSystemPrompt$, signal)
            : null,
          set(prepareRunnerStorage$, signal),
        ],
        signal,
      );
      const plan =
        original && !isRouteError(original)
          ? withEmailSystemPrompt(original, emailPrompt)
          : original;
      return [plan, launch] as const;
    },
  );
  /** Validate the automation source before starting shared launch reads. */
  const prepareLaunchResources$ = command(
    async ({ get, set }, head: ChatQueueHeadContext, signal: AbortSignal) => {
      if (head.contextType === "automation") {
        const launch = await set(prepareAutomationLaunch$, head, signal);
        signal.throwIfAborted();
        if (launch.kind === "rejected") {
          return { kind: "rejected" as const, assembly: launch.assembly };
        }
        await set(prepareAutomationRun$, signal);
        signal.throwIfAborted();
      }
      const [runner, callbackRows, assembly, identity] = await Promise.all([
        set(prepareRunnerResources$, signal),
        get(callbackRows$),
        get(assembly$),
        get(runIdentity$),
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
      const [admission, launch] = await Promise.all([
        set(checkClaimAdmission$, signal),
        set(prepareLaunchResources$, head, signal),
        get(preparedStorage$),
        // Connector reads start independently of prompt/model material. A
        // prefetch miss joins the same loader once for this selected identity.
        get(bootstrap.connectors$),
        get(threadContext.connectorThreadSelections$),
      ]);
      signal.throwIfAborted();
      if (launch.kind === "rejected") {
        return { kind: "rejected" as const, assembly: launch.assembly };
      }
      const [input, runnerLaunch] = launch.runner;
      return {
        kind: "prepared" as const,
        resources: [
          input,
          runnerLaunch,
          launch.callbackRows,
          launch.assembly,
          launch.identity,
          admission,
        ] as const,
      };
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
      const resources = await set(prepareClaimResources$, head, signal);
      signal.throwIfAborted();
      if (resources.kind === "rejected") {
        const early = resources.assembly;
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
      const [input, runnerLaunch, callbackRows, assembly, identity, admission] =
        resources.resources;
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
      const failure = firstPreparationFailure([input, admission, runnerLaunch]);
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
        !runnerLaunch ||
        !callbackRows ||
        !identity ||
        isRouteError(input) ||
        isRouteError(runnerLaunch)
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
                launch: runnerLaunch,
                head,
                producerBinding: assembly.producerBinding,
                rejection: claimRejectionContext(assembly.rejection),
                launchRecord: claimLaunchRecord(
                  assembly.launchRecord,
                  input.integrationContext,
                ),
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

  // Record the committed result only after pending publication returns.
  // This command does no launch preparation.
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
      recordAtomicLaunchTiming({
        createArgs: input.args,
        committed: committed.result,
        transactionReturnedAt: committed.transactionReturnedAt,
        timing: timing.run,
        phaseTiming: timing.phase,
      });
      return {
        kind: "pending",
        marketingRewardEventId: committed.result.marketingRewardEventId,
        runId: committed.result.run.id,
        apiStartTime: input.args.apiStartTime,
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
      const commit: ThreadLaunchCommitInput = {
        createArgs: input.args,
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
        runnerGroup: launch.runnerGroup,
        profile: launch.profile,
        dimensions: input.args.timingDimensions,
        triggerSource: input.context.content.triggerSource,
      });
      const preparedCommit: PreparedThreadLaunchCommit = {
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
              commitThreadLaunch$,
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
          set(internalAdmittedLaunch$, result.admittedLaunch);
          const launched = context.launchRecord;
          if (launched.kind === "prompt") {
            // Creation is durable even if cancellation or activation fails next.
            recordTemplateUsage(
              {
                runId: result.run.id,
                sourceEventId: context.head.id,
                orgId: context.head.orgId,
                userId: context.head.userId,
                chatThreadId: context.head.chatThreadId,
                dispatchPath: "queued-claim",
                triggerSource: launched.context.runInput.triggerSource,
                usedAt: new Date(result.publicationReturnedAt),
              },
              launched.templateUsageIdentities,
            );
          }
        }
        const transactionReturnedAt =
          "kind" in result && result.kind === "pending"
            ? result.publicationReturnedAt
            : now();
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

  const publishPendingRun$ = command(
    async (_context, pending: PendingClaimRun, signal: AbortSignal) => {
      signal.throwIfAborted();
      // Immediate and queued picks have committed their active-run slot here.
      // Pending shell approvals must re-read chat_busy before the runner starts.
      await publishDesktopShellAuthorizationChangedSafely(
        pending.context.head.userId,
      );
      signal.throwIfAborted();
      // The committed pending Run is the active indicator's only start edge.
      await publishChatIndicatorsChangedSafely({
        userId: pending.context.head.userId,
        orgId: pending.context.head.orgId,
      });
      signal.throwIfAborted();
      recordThreadRunActivationMarkers(
        {
          runId: pending.runId,
        },
        pending.apiStartTime,
      );
    },
  );

  const finishPendingRun$ = command(
    async (
      { set },
      pending: PendingClaimRun,
      dispatched: DirectRunDispatchResult,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (dispatched.terminal !== null) {
        const terminal = dispatched.terminal;
        if (terminal.status !== "failed" && terminal.status !== "cancelled") {
          throw new Error("Unaccepted Run has an invalid terminal status");
        }
        await set(
          dispatchCompleteSideEffects$,
          terminal.status === "failed"
            ? {
                kind: "terminal",
                firstTerminalTransition: true,
                runId: terminal.runId,
                orgId: terminal.orgId,
                status: "failed",
              }
            : {
                kind: "cancellation-recovery",
                runId: terminal.runId,
                orgId: terminal.orgId,
                userId: terminal.userId,
                chatThreadId: pending.context.head.chatThreadId,
                chatEventsAppended: false,
              },
          signal,
        );
      }
      if (dispatched.failure !== undefined) {
        throw dispatched.failure;
      }
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
        await set(
          finalizeClaimedRunUserMessage$,
          {
            orgId: launched.orgId,
            threadId: launched.threadId,
            userId: launched.userId,
          },
          signal,
        );
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
  const admitRun$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<PendingClaimRun | null> => {
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
        // A durable Run commit is creation success, even if subsequent
        // telemetry or cancellation fails. Never reject its consumed input.
        if (get(internalCommittedRunId$) !== null) {
          throw settled.error;
        }
        // Temporary staff cutover reader: a preparation can capture the old
        // Chat binding just before SQL reassigns it. The atomic binding fence
        // rolled back publication; keep its input queued for a fresh normal
        // pick instead of permanently rejecting it. No admission guard is
        // bypassed. Remove after pre-cutover request preparations have drained
        // and their rollback consumers are excluded (#46783).
        if (
          claim.orgId === STAFF_SINGLE_AGENT_ORG_ID &&
          settled.error instanceof ChatThreadBindingChanged
        ) {
          return null;
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
      return settled.value;
    },
  );
  return {
    threadHasActiveRun$,
    threadResources$,
    inputResources$: threadContext.inputResources$,
    hasFirstPickableChatEvent$,
    orgHasCapacity$,
    admittedLaunch$,
    admitRun$,
    publishPendingRun$,
    finishPendingRun$,
  };
}

type AgentRunRecord = AgentRunRequestAgent;

// --- Thread-private implementation: launch persistence ---

function runnerReuseKey(chatThreadId: string): string {
  return `thread:${chatThreadId}`;
}

interface RunRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly status: "pending";
}

interface LaunchRunIdentity {
  readonly runId: string;
}

interface PersistedAtomicLaunchRows {
  readonly kind: "pending";
  readonly marketingRewardEventId: string | null;
  readonly run: RunRecord;
}

interface PreparedRunnerLaunch {
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly facts: AdmittedExecutionFacts;
  readonly runStorageMounts: readonly PersistedStorageMount[];
  readonly memoryMounts: readonly AcceptedMemoryMount[];
}

type AgentRunCallbackInsert = typeof agentRunCallbacks.$inferInsert;

interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

type AtomicLaunchCommitResult =
  | {
      readonly kind: "pending";
      readonly marketingRewardEventId: string | null;
      readonly run: RunRecord;
      readonly admittedLaunch: AdmittedRunLaunch;
      readonly publicationReturnedAt: number;
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
interface ThreadRunPersistenceArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly triggerSource: TriggerSource;
  readonly apiStartTime: number;
  readonly chatThreadId: string;
  readonly agentRunMetadata: AgentRunMetadata;
  readonly modelSelection: ModelFirstPin;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly timingDimensions: ApiDispatchTimingDimensions;
  readonly threadContinuation: PendingThreadContinuation;
}

/** Facts used to publish the picked input and its Run. */
interface ThreadRunPersistenceContext {
  readonly inputEvent: LoadedChatEventReplacementTarget &
    Pick<PickedThreadInputEvent, "modelSelection"> & {
      readonly userMessage: ChatEventUserMessage;
    };
  readonly content: ThreadRunContent;
  readonly selectedImageModel: ImageModel;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly officialWorkflowProvenance:
    OfficialWorkflowObservation["provenance"] | undefined;
  readonly resolved: {
    readonly agentId: string;
  };
  readonly modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    | "credentialOwner"
    | "accountIdentity"
    | "id"
    | "type"
    | "selectedModel"
    | "builtInModelRuntimeRoute"
    | "upstreamModel"
  >;
}

interface ThreadLaunchCommitInput {
  readonly createArgs: ThreadRunPersistenceArgs;
  readonly context: ThreadRunPersistenceContext;
  readonly identity: LaunchRunIdentity;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
}

interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly resolved: ThreadRunPersistenceContext["resolved"];
  readonly content: ThreadRunContent;
  readonly runStorageMounts: readonly PersistedStorageMount[];
  readonly modelProvider: ThreadRunPersistenceContext["modelProvider"];
  readonly modelSelection: ModelFirstPin;
  readonly selectedImageModel: ImageModel;
  readonly callbackRows: readonly AgentRunCallbackInsert[];
  readonly chatThreadId: string;
  readonly agentRunMetadata: AgentRunMetadata;
  readonly apiStartTime: number;
  readonly runnerGroup: string;
  readonly launchSnapshot: AgentRunLaunchSnapshot;
  readonly officialWorkflowProvenance: ThreadRunPersistenceContext["officialWorkflowProvenance"];
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
    status: "pending",
    agentId: args.resolved.agentId,
    modelProviderAccountIdentity: args.modelProvider.accountIdentity,
    prompt: args.content.prompt,
    storageMounts: [...args.runStorageMounts],
    runnerGroup: args.runnerGroup,
    launchSnapshot: args.launchSnapshot,
    officialWorkflowProvenance: args.officialWorkflowProvenance ?? null,
    completedAt: null,
    ...metadata,
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
  >,
): ModelLaunchMetadataValues {
  const runtimeRoute = modelProvider.builtInModelRuntimeRoute;
  if (!runtimeRoute) {
    return {
      // Subscription launches record the compiled upstream without a managed key.
      modelRuntimeProvider:
        modelProvider.upstreamModel &&
        isPersonalSubscriptionProviderType(modelProvider.type)
          ? modelProvider.type
          : null,
      modelRuntimeModel: isPersonalSubscriptionProviderType(modelProvider.type)
        ? modelProvider.upstreamModel
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
  const metadata = args.agentRunMetadata;
  const modelPin = args.modelSelection;
  const exactSubscriptionId = isPersonalSubscriptionProviderType(
    args.modelProvider.type,
  )
    ? args.modelProvider.id
    : undefined;
  return normalizeRunMetadata({
    triggerSource: args.content.triggerSource,
    ...agentRunLaunchMetadataInput(metadata),
    modelProvider: modelPin.modelProviderType,
    modelProviderId: exactSubscriptionId ?? modelPin.modelProviderId,
    modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
    selectedModel: modelPin.selectedModel,
    ...modelLaunchMetadataValues(args.modelProvider),
    ...(args.modelProvider.builtInModelRuntimeRoute &&
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
    chatThreadId: args.chatThreadId,
    apiStartedAt: new Date(args.apiStartTime),
    firstAssistantEventAcknowledgedAt: null,
    summary: null,
  });
}

function preparedLaunchRowsArgs(
  commit: ThreadLaunchCommitInput,
): LaunchRunRowsArgs {
  return {
    userId: commit.createArgs.userId,
    orgId: commit.createArgs.orgId,
    identity: commit.identity,
    resolved: commit.context.resolved,
    content: commit.context.content,
    runStorageMounts: commit.launch.runStorageMounts,
    modelProvider: commit.context.modelProvider,
    modelSelection: commit.createArgs.modelSelection,
    selectedImageModel: commit.context.selectedImageModel,
    callbackRows: commit.callbackRows,
    chatThreadId: commit.createArgs.chatThreadId,
    agentRunMetadata: commit.createArgs.agentRunMetadata,
    apiStartTime: commit.createArgs.apiStartTime,
    runnerGroup: commit.launch.runnerGroup,
    launchSnapshot: commit.context.launchSnapshot,
    officialWorkflowProvenance: commit.context.officialWorkflowProvenance,
  };
}

interface PreparedAtomicLaunchRows {
  readonly rowsArgs: LaunchRunRowsArgs;
  readonly metadata: RunMetadataValues;
}

interface PreparedAtomicLaunchPersistence {
  readonly rows: PreparedAtomicLaunchRows;
  readonly diagnosticRegistrationPayload: zInfer<
    typeof agentRunConnectorDiagnosticRegistrationPayloadSchema
  >;
}

interface PreparedThreadLaunchCommit extends ThreadLaunchCommitInput {
  readonly planCapabilities: OrgPlanCapabilities | null;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly persistence: PreparedAtomicLaunchPersistence;
  readonly admissionTiming: AdmissionAttemptTiming;
}

function prepareAtomicLaunchPersistence(
  commit: ThreadLaunchCommitInput,
): PreparedAtomicLaunchPersistence {
  const rowsArgs = preparedLaunchRowsArgs(commit);
  return {
    rows: { rowsArgs, metadata: launchRunMetadataValues(rowsArgs) },
    diagnosticRegistrationPayload:
      agentRunConnectorDiagnosticRegistrationPayloadSchema.parse({
        version: 1,
        targets: commit.launch.facts.connectorEnvironment.runtimeTargets,
      }),
  };
}

type ReturnedIdCte = WithSubquery & { readonly id: SQLWrapper };

function returnedCteId(cte: ReturnedIdCte): SQL {
  // Child mutations read the returned key so their dependency is explicit;
  // data-modifying CTE declaration order alone does not order execution.
  return sql`(SELECT ${returnedCteColumn(cte, "id")} FROM ${cte})`;
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

function launchThreadBindingCte({
  createArgs,
  identity,
}: ThreadLaunchCommitInput) {
  const { expected, admission } = createArgs.threadContinuation;
  if (admission.runId !== identity.runId) {
    throw new Error("Captured predecessor facts do not match launch identity");
  }
  return new QueryBuilder().$with("validated_launch_thread").as(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, createArgs.chatThreadId),
          eq(chatThreads.userId, createArgs.userId),
          chatThreadOrganizationCondition(createArgs.orgId),
          sql`${chatThreads.agentId} IS NOT DISTINCT FROM ${expected.threadAgentId}::uuid`,
          sql`${chatThreads.framework} IS NOT DISTINCT FROM ${expected.framework}::text`,
          sql`${chatThreads.frameworkSessionId} IS NOT DISTINCT FROM ${expected.frameworkSessionId}::text`,
          sql`${chatThreads.frameworkSessionRunId} IS NOT DISTINCT FROM ${expected.frameworkSessionRunId}::uuid`,
          sql`${chatThreads.frameworkSessionRunId} IS NOT DISTINCT FROM ${admission.finalizingSourceRunId}::uuid`,
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

  const updatedThread = launchThreadBindingCte(args.commit);
  ctes.push(updatedThread);
  const automationId = metadata.workflowAutomationId;
  // A deleted source has the same nullable history link as ON DELETE SET NULL.
  // The key-share lock protects only the foreign key while publishing the Run.
  const workflowAutomationId = automationId
    ? sql`(SELECT ${workflowAutomations.id} FROM ${workflowAutomations}
        WHERE ${eq(workflowAutomations.id, automationId)} FOR KEY SHARE)`
    : null;
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
          workflowAutomationId,
        },
        ["id", "createdAt"],
        sql`EXISTS (SELECT 1 FROM inserted)`,
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

interface AtomicLaunchRowsPlanArgs {
  readonly commit: PreparedThreadLaunchCommit;
  readonly claim: PendingLaunchClaim;
  readonly claimedInput: PreparedChatEventRow & {
    readonly revokesEventId: string;
  };
}

class ChatThreadBindingChanged extends Error {
  constructor() {
    super("Chat thread session binding changed during launch");
    this.name = "ChatThreadBindingChanged";
  }
}

function recordAtomicLaunchTiming(args: {
  readonly createArgs: ThreadRunPersistenceArgs;
  readonly committed: CommittedAtomicLaunchResult;
  readonly transactionReturnedAt: number;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}): void {
  args.phaseTiming.checkpoint(
    "api_dispatch_phase_commit",
    args.transactionReturnedAt,
  );
  args.phaseTiming.appendTo(args.timing);
  args.timing.flush({
    runId: args.committed.run.id,
    runnerGroup: args.committed.admittedLaunch.runnerGroup,
    profile: args.committed.admittedLaunch.profile,
    dimensions: args.createArgs.timingDimensions,
    triggerSource: args.createArgs.triggerSource,
  });
}
// --- Thread-private implementation: model provider environment ---

function modelProviderFramework(
  modelProvider: ResolvedModelProviderEnvironment,
): SupportedFramework {
  return getFrameworkForType(modelProvider.type);
}

// Thread input preparation.

/** The owner a claimed queue head runs as: its user in its organization. */
interface ThreadRunOwner {
  readonly userId: string;
  readonly orgId: string;
}

/** Captured facts used to prepare one claimed Thread input. */
interface ThreadRunCommand {
  readonly owner: ThreadRunOwner;
  readonly modelProvider: ModelFirstPin["modelProviderType"];
  readonly realAgentInPreview?: boolean;
  readonly captureNetworkBodies?: boolean;
  readonly apiStartTime: number;
  readonly triggerSource?: TriggerSource;
  readonly chatThreadId: string;
  readonly selectedModel: string;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
}

// --- Thread-private implementation: launch input ---

interface ThreadExecution {
  readonly agentId: string;
  readonly orgId: string;
}

/** The Thread facts needed to prepare one Runner launch. */
interface ThreadRunnerFacts {
  readonly workflowAutomationId: string | undefined;
  readonly agentId: string;
  readonly protectedMountPaths: readonly string[];
  readonly facts: Pick<
    AdmittedExecutionFacts,
    | "skillRoot"
    | "skillMounts"
    | "officialWorkflowBundles"
    | "integration"
    | "captureNetworkBodies"
    | "modelProvider"
    | "modelProviderPermissions"
    | "connectorEnvironment"
    | "connectorNetworkPolicyInputs"
    | "userTimezone"
  >;
  readonly nativeContinuation: ChatThreadContinuation["executionSnapshot"]["nativeContinuation"];
  readonly realAgentInPreview?: boolean;
  readonly profile: string;
  readonly apiStartTime: number | undefined;
  readonly chatThreadId: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}

/** Capture selectors and request receipts; admitted preparation assembles runtime input. */
function prepareRunnerLaunch(input: {
  readonly args: ThreadRunnerFacts;
  readonly customWorkflowSelection: AdmittedExecutionFacts["customWorkflowSelection"];
  readonly executionPackages: AdmittedExecutionFacts["executionPackages"];
  readonly okouToken: string;
  readonly disabledPaidTools: readonly PaidToolId[];
}): Omit<PreparedRunnerLaunch, "runStorageMounts" | "memoryMounts"> {
  const { args } = input;
  const facts = {
    ...args.facts,
    executionPackages: input.executionPackages,
    nativeContinuation: args.nativeContinuation,
    customWorkflowSelection: input.customWorkflowSelection,
    okouToken: input.okouToken,
    disabledPaidTools: input.disabledPaidTools,
    realAgentInPreview: args.realAgentInPreview || undefined,
    apiStartTime: args.apiStartTime,
    featureFlags: {
      [FeatureSwitchKey.ArtifactGenerationTiming]: isFeatureEnabled(
        FeatureSwitchKey.ArtifactGenerationTiming,
        args.featureSwitchContext,
      ),
      [FeatureSwitchKey.ArtifactThreePointTiming]: isFeatureEnabled(
        FeatureSwitchKey.ArtifactThreePointTiming,
        args.featureSwitchContext,
      ),
      [FeatureSwitchKey.SingleAgent]: isFeatureEnabled(
        FeatureSwitchKey.SingleAgent,
        args.featureSwitchContext,
      ),
      [FeatureSwitchKey.ConnectorChatAccountAccess]: isFeatureEnabled(
        FeatureSwitchKey.ConnectorChatAccountAccess,
        args.featureSwitchContext,
      ),
    },
  };
  return {
    runnerGroup: preparedRunnerGroup(),
    profile: args.profile,
    reuseKey: runnerReuseKey(args.chatThreadId),
    facts,
  };
}

function preparedRunnerGroup(): string {
  return officialRunnerGroup(optionalEnv("RUNNER_DEFAULT_GROUP"));
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

// Emitted as the agent_run_origin observability dimension. The values name what
// started the run, so the fallback is "direct" (not started by an automation)
// rather than a restatement that this is an agent run.
type AgentRunOrigin = "direct" | "workflow_automation";

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
  readonly source?: AgentRunPreCreateSource;
}): ApiDispatchTimingDimensions {
  return {
    agent_run_origin: args.origin,
    api_start_source: "queue_event",
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

interface ThreadRunPreparation {
  readonly modelSelection: ModelFirstPin;
}

interface ThreadRunArgsInput {
  readonly command: ThreadRunCommand;
  readonly modelSelection: ModelFirstPin;
  readonly threadContinuation: ChatThreadContinuation;
}

interface ThreadRunContent {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly triggerSource: TriggerSource;
  readonly vars: Record<string, string>;
}

/** The facts Thread uses to prepare and commit one claimed input. */
interface ThreadRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly agentRunMetadata: AgentRunMetadata;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly realAgentInPreview?: boolean;
  readonly captureNetworkBodies?: boolean;
  readonly triggerSource: TriggerSource;
  readonly apiStartTime: number;
  readonly chatThreadId: string;
  readonly threadContinuation: ChatThreadContinuation;
  readonly modelSelection: ModelFirstPin;
  readonly timingDimensions: ApiDispatchTimingDimensions;
}

function buildThreadRunArgs(
  args: ThreadRunArgsInput,
  prompt: Pick<PromptAndSkillVolumes, "userPrompt" | "appendedSystemPrompt">,
): ThreadRunArgs {
  const command = args.command;
  return {
    orgId: command.owner.orgId,
    userId: command.owner.userId,
    codexServiceTier: command.codexServiceTier,
    prompt: prompt.userPrompt,
    realAgentInPreview: command.realAgentInPreview,
    captureNetworkBodies: command.captureNetworkBodies,
    triggerSource: command.triggerSource ?? "web",
    appendSystemPrompt: prompt.appendedSystemPrompt,
    apiStartTime: command.apiStartTime,
    chatThreadId: command.chatThreadId,
    threadContinuation: args.threadContinuation,
    agentRunMetadata: {
      ...command.agentRunMetadata,
      codexServiceTier: command.codexServiceTier,
      reasoningEffort: command.reasoningEffort,
    },
    modelSelection: args.modelSelection,
    timingDimensions: agentRunTimingDimensions({
      origin: agentRunOrigin({
        command,
      }),
      source: command.agentRunPreCreateSource,
    }),
  };
}

interface ThreadRunIdentityInput {
  readonly timing: ApiDispatchTimingCollector;
  readonly owner: ThreadRunOwner;
  readonly agentId: string;
}
interface ThreadRunSelectionInput {
  readonly command: ThreadRunCommand;
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
  readonly createArgs: ThreadRunPersistenceArgs;
  readonly identity: LaunchRunIdentity;
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}): void {
  args.phaseTiming.appendTo(args.timing);
  args.timing.flush({
    runId: args.identity.runId,
    runnerGroup: args.launch.runnerGroup,
    profile: args.launch.profile,
    dimensions: {
      ...args.createArgs.timingDimensions,
      queue_first_launch_outcome: "claim_lost",
    },
    triggerSource: args.createArgs.triggerSource,
  });
}

// --- Private implementation: launch persistence ---

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
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

interface AgentRunMetadata {
  // Run provenance for workflow schedule automations.
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

type ApiErrorResponse<Status extends number, Code extends string> = {
  readonly status: Status;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: Code;
    };
  };
};

type CreateRunErrorResult =
  | ThreadModelError
  | ApiErrorResponse<400, "BAD_REQUEST">
  | ApiErrorResponse<403, "FORBIDDEN">
  | ApiErrorResponse<404, "NOT_FOUND">
  | ApiErrorResponse<409, "CONFLICT">
  | ApiErrorResponse<402, "INSUFFICIENT_CREDITS">
  | ApiErrorResponse<402, "PRO_REQUIRED">
  | ApiErrorResponse<
      503,
      "PROVIDER_UNAVAILABLE" | "MODEL_PROVIDER_UNAVAILABLE"
    >;

// Pending persistence uses connection-free SQL plans owned by one command.
async function pendingLaunchCommitResult(
  args: PreparedThreadLaunchCommit,
  publication: Promise<{
    readonly persisted: ReturnType<typeof pendingAtomicLaunchResult>;
    readonly publicationReturnedAt: number;
  }>,
  preparation: Promise<RunnerReusePreparation>,
): Promise<AtomicLaunchCommitAttempt> {
  const [published, preparedReuse] = await Promise.allSettled([
    publication,
    preparation,
  ]);
  if (published.status === "rejected") {
    throw published.reason;
  }
  args.admissionTiming.callbackFinished();
  const { persisted, publicationReturnedAt } = published.value;
  if (!("run" in persisted)) {
    return persisted;
  }
  const reusePreparation: RunnerReusePreparation =
    preparedReuse.status === "fulfilled"
      ? preparedReuse.value
      : {
          selection: { ok: false, error: preparedReuse.reason },
          operations: [],
        };
  return {
    ...persisted,
    admittedLaunch: admittedRunLaunch(
      args,
      persisted.run.createdAt,
      reusePreparation,
    ),
    publicationReturnedAt,
  };
}

function admittedRunLaunch(
  args: PreparedThreadLaunchCommit,
  createdAt: Date,
  reusePreparation: RunnerReusePreparation,
): AdmittedRunLaunch {
  const { rowsArgs: rows, metadata } = args.persistence.rows;
  return {
    run: {
      id: args.identity.runId,
      userId: rows.userId,
      orgId: rows.orgId,
      agentId: rows.resolved.agentId,
      chatThreadId: rows.chatThreadId,
      framework: rows.launchSnapshot.framework,
      prompt: rows.content.prompt,
      appendSystemPrompt: rows.content.appendSystemPrompt,
      vars: rows.content.vars,
      modelProvider: rows.modelSelection.modelProviderType,
      modelProviderId: metadata.modelProviderId,
      modelProviderAccountIdentity: rows.modelProvider.accountIdentity,
      selectedModel: rows.modelSelection.selectedModel,
      modelRuntimeProvider: metadata.modelRuntimeProvider,
      modelRuntimeModel: metadata.modelRuntimeModel,
      builtInModelKeyId: metadata.builtInModelKeyId,
      modelUsageProvider: metadata.modelUsageProvider,
      modelLongContextMinTotalInputTokens:
        metadata.modelLongContextMinTotalInputTokens,
      reasoningEffort: metadata.reasoningEffort,
      codexServiceTier: metadata.codexServiceTier,
    },
    memoryMounts: args.launch.memoryMounts,
    facts: {
      ...args.launch.facts,
      connectorEnvironment: {
        ...args.launch.facts.connectorEnvironment,
        runtimeTargets: args.persistence.diagnosticRegistrationPayload.targets,
      },
    },
    runnerGroup: args.launch.runnerGroup,
    profile: args.launch.profile,
    reuseKey: args.launch.reuseKey,
    createdAt,
    reusePreparation,
  };
}

const pendingLaunchRowSchema = discriminatedUnion("kind", [
  object({
    kind: literal("pending"),
    runId: string(),
    createdAt: pgTimestampWithoutTimezoneToDateSchema,
    boundThreadId: string().nullable(),
    billingAttributionId: string().nullable(),
    marketingRewardEventId: uuid().nullable(),
  }),
  object({ kind: literal("claim-lost") }),
]);

function pendingAtomicLaunchResult(
  context: AtomicLaunchCteContext,
  row: zInfer<typeof pendingLaunchRowSchema> | undefined,
): PersistedAtomicLaunchRows | QueueFirstRunClaimLost {
  if (!row) {
    throw new Error("Atomic pending launch persistence returned no row");
  }
  if (row.kind === "claim-lost") {
    return { kind: "queue-first-claim-lost" };
  }
  if (!row.boundThreadId) {
    throw new ChatThreadBindingChanged();
  }
  if (row.billingAttributionId !== row.runId) {
    throw new Error("New Run billing attribution conflicts with history");
  }
  return {
    kind: "pending",
    marketingRewardEventId: row.marketingRewardEventId,
    run: {
      id: context.rowsArgs.identity.runId,
      createdAt: row.createdAt,
      status: "pending",
    },
  };
}

function pendingAtomicLaunchPlan(
  args: AtomicLaunchRowsPlanArgs,
  context: AtomicLaunchCteContext,
) {
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
      context.rowsArgs.agentRunMetadata.workflowAutomationId
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
  const rewardSource = new QueryBuilder()
    .$with("launch_workflow_source", {})
    .as(
      workflowRewardRunEventInsert(
        {
          orgId: context.rowsArgs.orgId,
          userId: context.rowsArgs.userId,
          runId: context.rowsArgs.identity.runId,
          sourceEventId: args.claimedInput.revokesEventId,
          occurredAt: context.createdAt,
          environment: env("ENV"),
        },
        sql`EXISTS (SELECT 1 FROM ${context.insertedRun})`,
      ),
    );
  const ctes = [...context.ctes, attribution, rewardSource];
  const names = ctes.map((cte) => {
    return cte._.alias;
  });
  names.push("launch_claim_relations");
  const beforeProducer = pendingLaunchBarrier(names);
  const producer = pendingLaunchClaimProducerStatements(
    args.claim.producer,
    context.rowsArgs.identity.runId,
    sql`EXISTS (SELECT 1 FROM ${context.insertedRun}) AND ${beforeProducer} >= 0`,
  );
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
      WHEN EXISTS (SELECT 1 FROM ${context.insertedRun}) THEN 'pending'
      ELSE 'claim-lost' END AS kind,
      (SELECT ${attribution.runId} FROM ${attribution}) AS "billingAttributionId",
      (SELECT id FROM launch_workflow_source) AS "marketingRewardEventId",
      (SELECT ${returnedCteColumn(context.insertedRun, "id")} FROM ${context.insertedRun}) AS "runId",
      (SELECT ${returnedCteColumn(context.insertedRun, "created_at")} FROM ${context.insertedRun})::text AS "createdAt",
      ${returnedCteId(context.updatedThread)} AS "boundThreadId"
    WHERE (SELECT ${count()} FROM launch_active) >= 0`;
}

function returnedCteColumn(cte: WithSubquery, name: string): SQL {
  return sql`${sql.identifier(cte._.alias)}.${sql.identifier(name)}`;
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

function pendingLaunchPublicationCtes({
  claim,
  claimedInput,
}: AtomicLaunchRowsPlanArgs): SQL {
  // Queue eligibility is decided with the write. The event body comes from
  // the picked input used to prepare this Run.
  const currentHead = new QueryBuilder()
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(queuedThreadInputCondition(claim.chatThreadId))
    .orderBy(asc(chatEvents.seqId))
    .limit(1);
  const claimCtes = sql`${canonicalChatEventInputCtes(
    [claimedInput],
    eq(sql`(${currentHead})`, claimedInput.revokesEventId),
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
      )`;
  const released = sql`, released_pending_token AS (${pendingLaunchClaimFenceSql(
    claim,
    sql`EXISTS (SELECT 1 FROM inserted)
              AND (SELECT ${count()} FROM launch_claim_relations) >= 0`,
  )})`;
  return sql`${claimCtes}${released}`;
}

function pendingLaunchGuardedRunId(
  args: AtomicLaunchRowsPlanArgs,
  thread: WithSubquery,
): SQL {
  const guards: SQL[] = [
    sql`WHEN (SELECT ${count()} FROM released_pending_token) <> 1 THEN '__TX0263_TOKEN__'`,
    sql`WHEN NOT EXISTS (SELECT 1 FROM ${thread}) THEN '__TX0263_THREAD__'`,
  ];
  const guard = sql`CASE ${sql.join(guards, sql` `)} ELSE '0' END`;
  return sql`CASE WHEN (${guard})::integer = 0
    THEN ${args.commit.identity.runId}::uuid ELSE NULL END`;
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
      chatThreadId: args.commit.createArgs.chatThreadId,
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

function prepareClaimedInput({
  context,
  createArgs,
  identity,
}: ThreadLaunchCommitInput) {
  const event = context.inputEvent;
  const serviceTier =
    createArgs.codexServiceTier === "fast"
      ? "priority"
      : createArgs.codexServiceTier;
  const { row } = prepareChatEventReplacement(event, {
    id: identity.runId,
    chatThreadId: createArgs.chatThreadId,
    eventType: "input.prompt",
    runId: identity.runId,
    userMessage: withRunModelAnnotation(
      event.userMessage,
      createArgs.modelSelection.selectedModel,
      serviceTier,
    ),
  });
  return { ...row, revokesEventId: event.id };
}

const commitThreadLaunch$ = command(
  async (
    { set },
    args: PreparedThreadLaunchCommit,
    claim: PendingLaunchClaim,
    signal: AbortSignal,
  ): Promise<AtomicLaunchCommitAttempt> => {
    signal.throwIfAborted();
    const { officialWorkflowBundles } = args.launch.facts;
    if (
      officialWorkflowBundles.some(({ mountPath }) => {
        return args.launch.runStorageMounts.some((mount) => {
          return mount.mountPath === mountPath;
        });
      })
    ) {
      return conflict(OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE);
    }
    const db = set(writeDb$);
    const { admissionTiming, timing } = args;
    admissionTiming.transactionStarted();
    admissionTiming.admissionStarted();
    const planArgs: AtomicLaunchRowsPlanArgs = {
      commit: args,
      claim,
      claimedInput: prepareClaimedInput(args),
    };
    const context = buildAtomicLaunchCteContext(planArgs);
    const leafStartedAt = admissionTiming.leafStartedAt();
    const publication = (async () => {
      signal.throwIfAborted();
      const capture: PgQueryExecutionCapture = { executions: [] };
      const databaseStartedAt = performance.now();
      const persisted = await withPgQueryExecutionCapture(capture, async () => {
        const buildStartedAt = monotonicNow();
        const plan = pendingAtomicLaunchPlan(planArgs, context);
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
        const result = pendingAtomicLaunchResult(context, outcome.value[0]);
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
      return { persisted, publicationReturnedAt: now() };
    })().finally(() => {
      admissionTiming.recordLeafElapsed("persistence", leafStartedAt);
    });
    const { chatThreadId, userId, orgId, threadContinuation } = args.createArgs;
    const { runnerGroup, profile, reuseKey } = args.launch;
    const preparation = set(prepareRunnerReusePreference$, {
      runId: args.identity.runId,
      runnerGroup,
      profile,
      reuseKey,
      thread: {
        threadId: chatThreadId,
        userId,
        orgId,
        predecessorRunId: threadContinuation.expected.frameworkSessionRunId,
      },
    });
    // Return the durable identity before the caller observes cancellation.
    return await pendingLaunchCommitResult(args, publication, preparation);
  },
);
