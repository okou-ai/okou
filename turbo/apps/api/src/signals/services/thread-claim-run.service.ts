import {
  proactiveInputSql,
  PROACTIVE_SELECTED_MODEL,
} from "./proactive-run-context.service";
import { launchFrameworkForProviderType } from "./launch-framework";
import { mintAntigravityRunCredential$ } from "./antigravity-run-credential.service";
import { publishChatThreadMessageCreated$ } from "./chat-event-publication.service";
import { revokeDeletedWorkflowAutomationInputs$ } from "./workflow-automation-queue-revocation.service";
import { writeDb$ } from "../external/db";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { finalizeClaimedRunUserMessage$ } from "./chat-run-event.service";
import { morningBriefScheduleClaimBound$ } from "./legacy-morning-brief-settlement.service";
import { maxAutonomyBudget$ } from "../autonomy-budget-limit";
import { chatInputEnqueueCommits$ } from "./chat-input-enqueue-observation";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import { initializeMemberMemory$ } from "./member-memory-initialization.service";
import { settleRejectedAutomationInput$ } from "./workflow-schedule-failure.service";
import type { AgentRunCallbackPayload } from "@okouai/db/jsonb-contracts/agent-run-callback";
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
import {
  createOkouTokenInputSignals,
  prepareOkouToken$,
} from "./thread-okou-token.signals";
import { createConnectorAdmissionSignals } from "./thread-connector-environment.signals";
import { modelProviderPermissionManifest } from "./permission-manifest.service";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-provider-types";
import type { PaidToolId } from "@okouai/api-contracts/contracts/paid-tools";
import { RETIRED_WORKFLOW_RUN_MESSAGE } from "./official-workflow-constants";
import {
  checkRunServiceTier,
  type ThreadModelError,
  type ThreadModelSelection,
} from "./thread-model.signals";
import { feishuDeliveryFromContext } from "./feishu-queued-launch-context.service";
import type { SlackThreadContext } from "./slack-queued-launch-context.service";
import type { TelegramThreadContext } from "./telegram-queued-launch-context.service";
import {
  createPromptAndPackageSignals,
  type PreparedRunPrompt,
  RunPromptError,
} from "./thread-run-prompt/prompt-and-packages";
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
  providerUnavailable,
} from "../../lib/error";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import type { TemplateUsageIdentity } from "../../lib/template-usage-identity";
import { recordTemplateUsage } from "../../lib/template-usage-log";

import { monotonicNow, now, nowDate, nowDateSql } from "../../lib/time";
import {
  publishChatIndicatorsChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";

import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import { joinAll, safeSync, settle, tapError } from "../utils";
import {
  prepareDirectRunInputs$,
  type DirectRunDispatchResult,
  type DirectRunInputsRead,
} from "./direct-run-dispatch.service";
import {
  createExecutionBundleCache,
  type AdmittedRunLaunch,
  type DirectRunInput,
  type ExecutionBundleUrlsRead,
} from "./direct-run-preparation.service";
import type { ExecutionRuntimeResources } from "./execution-runtime-context";
import { prepareExecutionNetworkPolicy$ } from "./run-execution-publication.service";
import { selectExecutionContentBundles } from "./execution-content-bundle";
import {
  prepareRunPackageMounts,
  selectExecutionPackages,
} from "./execution-workflow-selection";
import type {
  AgentRunContextSignals,
  BootstrapFeatureSwitchContext,
} from "./agent-run-context.signals";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import {
  runRoutePricingFromSnapshot,
  validateModelUsage,
} from "./built-in-route-pricing";
import {
  canonicalChatEventInputCtes,
  canonicalChatEventInsertSql,
  type PreparedChatEventRow,
} from "./chat-event-append.service";
import { recordThreadRunActivationMarkers } from "./chat-first-assistant-event-metric.service";
import { isAntigravityEnabled } from "./feature-switches.service";
import {
  queuedThreadInputCondition,
  type QueuedUserMessage,
  type QueuedUserMessageContextType,
} from "./chat-queued-event.service";
import { randomUUID } from "node:crypto";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import {
  type QueuedChatPromptData,
  queuedChatRunCallbackInputs,
  type QueuedLaunchMaterial,
  type QueuedPromptLaunchContext,
  queuedPromptRejectionContext,
  type RunLaunchCallbackRecord,
  deliverQueuedPromptRejection$,
  deliverUnexpectedQueuedPromptRejection$,
  recordQueuedPromptRunLaunch$,
} from "./internal-chat-run-callback.service";
import { FEISHU_RUN_FILE_INDEX_KIND } from "./feishu-run-file-index";
import { pendingLaunchBillingAttributionSql } from "./pending-launch-billing-plan";
import {
  type PendingLaunchClaim,
  pendingLaunchClaimFenceSql,
  pendingLaunchEmptyQueueDeleteSql,
  pendingLaunchMorningBriefBindingSql,
} from "./pending-launch-claim-plan";
import { pendingLaunchInsertSql } from "./pending-launch-sql";

import { agentphoneDeliveryTargetSchema } from "./agentphone-chat-callback-payload";

import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import { childAutonomyBudget } from "./autonomy-budget.service";
import { parseCanonicalChatEventRequiredOfficialWorkflowIds } from "./canonical-chat-event-read.service";
import {
  prepareChatEvent,
  prepareChatEventReplacement,
  type LoadedChatEventReplacementTarget,
} from "./chat-event.service";
import { withRunModelAnnotation } from "./chat-user-message.service";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";
import type { ChatThreadContinuation } from "./chat-session-continuity.service";

import { DiscordQueuedLaunchUnavailableError } from "./discord-queued-launch-context.service";
import { WechatLaunchUnavailableError } from "./wechat-context.service";

import { workflowRewardRunEventInsert } from "./workflow-reward-source-publication";

import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

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
  ne,
  notExists,
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
  uuid,
  type infer as zInfer,
} from "zod";

import {
  normalizeRunMetadata,
  type RunMetadataValues,
} from "./agent-run-metadata-write.service";
import type { EnqueuedChatInputFacts } from "./chat-run-preparation-facts";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { PLATFORM_TASK_THREAD_READ_ONLY_MESSAGE } from "./platform-task-thread.service";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import { isPersonalSubscriptionProviderType } from "./model-provider-account.service";
import type { ModelFirstPin } from "./model-selection.service";

import { teamsDeliveryFromContext } from "./teams-queued-launch-context.service";

import { telegramDeliveryTargetSchema } from "./telegram-chat-callback-payload";

import { isWebChatContextId } from "./web-chat-queue-context.service";

import {
  EVENT_POLICY,
  type WorkflowAutomationEventPayload,
  workflowAutomationEventTypeSchema,
} from "./workflow-automation-context.service";
import type { ThreadAutomationTarget } from "./thread-automation-context.service";
import { workflowAutomationTriggerSource } from "./workflow-automation-trigger-source";
import { recordWorkflowAdmissionDuration } from "./workflow-queue-admission-timing.service";
import {
  createMemberMemoryHead,
  decodeMemberMemoryHead,
} from "./member-memory-head.service";
import {
  buildMemberMemoryMount,
  executionMemoryMount,
  prepareExecutionMemoryArchive$,
  type AcceptedMemoryMount,
} from "./execution-storage.service";

export interface ThreadClaim {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly claimId: string;
  readonly queuedAt: Date;
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
    SELECT touched.user_id, touched.org_id, 1
    FROM touched
    ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + 1
    RETURNING user_id, org_id, last_seq_id
  ), sort_inserted AS (
    INSERT INTO ${chatThreadEvents}
      (id, user_id, org_id, seq_id, chat_thread_id, kind,
       cloud_browser_enabled, created_at)
    SELECT ${eventId}::uuid, thread_reserved.user_id, thread_reserved.org_id,
      thread_reserved.last_seq_id, touched.id, 'sort_touched',
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
      WHERE ${eq(chatThreads.id, args.threadId)}
      RETURNING ${chatThreads.id} AS id, ${chatThreads.userId} AS user_id,
        ${chatThreads.orgId} AS org_id,
        ${chatThreads.lastMessageAt} AS last_message_at
    ), ${queueRejectionSortCtes(randomUUID())}
    SELECT ${exists(sql`(SELECT 1 FROM rejected)`)} AS rejected,
      (SELECT id FROM assistant) AS "assistantEventId"`;
}

class QueuedPromptInputInvalidError extends Error {}

function assertQueuedPromptContext(args: {
  readonly contextType: QueuedUserMessageContextType;
  readonly contextId: string | null;
  readonly requiredOfficialWorkflowIds: readonly string[] | null;
}): void {
  if (args.requiredOfficialWorkflowIds !== null) {
    throw new QueuedPromptLaunchUnavailableError(RETIRED_WORKFLOW_RUN_MESSAGE);
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

function queuedTelegramDelivery(context: NonNullable<TelegramThreadContext>) {
  return telegramDeliveryTargetSchema.parse({
    installationId: OFFICIAL_TELEGRAM_BOT_ID,
    chatId: context.chatId,
    messageId: context.messageId,
    rootMessageId: context.rootMessageId,
    userLinkId: context.userLinkId,
    userLinkKind: context.userLinkKind,
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

type ChatQueueRunAssembly =
  | ({
      readonly kind: "assembled";
      readonly run: ThreadRunCommand;
      readonly runPrompt: PreparedRunPrompt;
      readonly rejection: ClaimRejectionContext;
      readonly launchRecord: ClaimLaunchRecord;
    } & (
      | {
          readonly source: "prompt";
          readonly promptContinuation: ChatThreadContinuation;
        }
      | { readonly source: "automation" }
    ))
  | { readonly kind: "rejected"; readonly rejection: ChatQueueHeadRejection }
  | { readonly kind: "not-ready" };

function isQueuedPromptPreparationError(error: unknown) {
  return (
    error instanceof DiscordQueuedLaunchUnavailableError ||
    error instanceof WechatLaunchUnavailableError ||
    error instanceof QueuedPromptLaunchUnavailableError ||
    error instanceof QueuedPromptInputInvalidError ||
    error instanceof RunPromptError
  );
}

function queuedPromptPreparationRejection(
  error: unknown,
  head: ChatQueueHeadContext,
): ChatQueueRunAssembly {
  if (!isQueuedPromptPreparationError(error)) {
    throw error;
  }
  return {
    kind: "rejected",
    rejection: {
      userId: head.userId,
      error: {
        code:
          error instanceof RunPromptError
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

type AutonomyBudgetResult =
  | { readonly kind: "ok"; readonly autonomyBudget: number }
  | {
      readonly kind: "invalid";
      readonly error: { readonly code: string; readonly message: string };
    };

type LaunchAutomation = ThreadAutomationTarget["automation"];

function buildWorkflowAutomationQueuedLaunchMaterial(args: {
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
  readonly automation: LaunchAutomation;
  readonly chatThreadId: string;
}): WorkflowAutomationQueuedLaunchMaterial | null {
  if (
    args.workflowName === null ||
    args.eventType === null ||
    args.eventPayload === null
  ) {
    return null;
  }
  const eventType = workflowAutomationEventTypeSchema.parse(args.eventType);
  return {
    callbacks: buildWorkflowAutomationCallbacks(
      args.automation,
      args.chatThreadId,
    ),
    ...EVENT_POLICY[eventType],
  };
}

function workflowAutomationRunMetadata(
  automation: LaunchAutomation,
  triggerBrief: string | undefined,
  autonomyBudget: number,
) {
  return {
    workflowAutomationId: automation.id,
    triggerBrief,
    autonomyBudget,
  };
}

type RejectedQueueRunAssembly = Extract<
  ChatQueueRunAssembly,
  { readonly kind: "rejected" }
>;

type QueuedAutomationLaunch =
  | {
      readonly kind: "launch";
      readonly automation: LaunchAutomation;
      readonly chatThreadId: string;
      readonly apiStartTime: number;
      readonly triggerBrief: string | undefined;
      readonly callbacks: readonly RunLaunchCallbackRecord[];
      readonly autonomyBudget: number;
      readonly recordLastRunId: boolean;
      readonly recordLastRunAt: boolean;
    }
  | RejectedQueueRunAssembly;

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
  return { ...assembly.rejection, error };
}

/**
 * Dispatch timing for one pick, created by the parent after its claim and
 * passed as a plain argument; it is not part of the prepared ThreadRunContext.
 */
interface ClaimRunTiming {
  readonly run: ApiDispatchTimingCollector;
  readonly phase: ApiDispatchPhaseCollector;
}

interface ThreadRunContext {
  readonly input: {
    readonly context: ThreadRunPersistenceContext;
    readonly args: ThreadRunPersistenceArgs;
  };
  readonly identity: ThreadLaunchCommitInput["identity"];
  readonly callbacks: ThreadLaunchCommitInput["callbacks"];
  readonly launch: ThreadLaunchCommitInput["launch"];
  readonly persistence: ReturnType<typeof prepareAtomicLaunchPersistence>;
  readonly head: ChatQueueHeadContext;
  readonly launchRecord: ClaimLaunchRecord;
}

interface RunResourcePreparation {
  readonly memoryArchive: Promise<Awaited<
    ReturnType<(typeof prepareExecutionMemoryArchive$)["write"]>
  > | null>;
  readonly networkPolicyInputs: ExecutionRuntimeResources["networkPolicyInputs"];
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
      callbacks: context.callbacks,
      launch: context.launch,
      timing,
    }),
  };
}

type ClaimRejectionContext = Omit<ChatQueueHeadRejection, "error">;

type ClaimLaunchRecord =
  | {
      readonly kind: "prompt";
      readonly context: QueuedPromptLaunchContext;
      readonly templateUsageIdentities: readonly TemplateUsageIdentity[];
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
}

function buildWorkflowAutomationCallbacks(
  automation: LaunchAutomation,
  chatThreadId: string,
): RunLaunchCallbackRecord[] {
  const callbacks: RunLaunchCallbackRecord[] = [];
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
  callbacks.push({
    internalKind: "chat",
    payload: { threadId: chatThreadId },
  });
  return callbacks;
}

function claimCommitInput(input: RunPlan): ThreadRunContext["input"] {
  return {
    args: claimCommitArguments(input.args),
    context: input.persisted,
  };
}

function claimLaunchRecord(
  record: ClaimLaunchRecord,
  integrationContext: string | undefined,
): ClaimLaunchRecord {
  if (record.kind === "automation") {
    return record;
  }
  const { triggerSource } = record.context;
  return {
    ...record,
    context: {
      ...record.context,
      integrationContext:
        triggerSource === "web" || triggerSource === "agent"
          ? undefined
          : integrationContext,
    },
  };
}

type PendingClaimRun = {
  readonly admittedLaunch: AdmittedRunLaunch;
  readonly marketingRewardEventId: string | null;
  readonly apiStartTime: number;
  readonly head: ChatQueueHeadContext;
  readonly launchRecord: ClaimLaunchRecord;
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
  readonly contextType: string | null;
  readonly contextId: string | null;
}

/** The Thread child's public surface: input readiness and run start. */
export interface ThreadClaimRunObjects {
  /** Entry-owned early reads; consumers retain their individual dependencies. */
  readonly inputResources$: Computed<Promise<void>>;
  readonly threadHasActiveRun$: Computed<Promise<boolean>>;
  readonly hasFirstPickableChatEvent$: Computed<Promise<boolean>>;
  readonly orgHasCapacity$: Computed<Promise<boolean>>;
  readonly executionBundleCache$: ReturnType<typeof createExecutionBundleCache>;
  readonly prepareRunAdmission$: Command<
    {
      readonly context: Promise<ThreadRunContext | null>;
      readonly resources: RunResourcePreparation;
    },
    [signal: AbortSignal]
  >;
  readonly admitRun$: Command<
    {
      readonly pending: Promise<PendingClaimRun | null>;
      readonly resources: ExecutionRuntimeResources;
      readonly early: DirectRunInputsRead | undefined;
    },
    [
      context: ThreadRunContext,
      resources: RunResourcePreparation,
      bundleUrls: ExecutionBundleUrlsRead,
      signal: AbortSignal,
    ]
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
  requestInput: EnqueuedChatInputFacts | undefined,
): ThreadClaimRunObjects {
  const claimCatalog$ = bootstrap.modelCatalog$;
  const pickStartedAt$ = computed(() => {
    return now();
  });
  const internalCommittedRunId$ = state<string | null>(null);
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
          requestInput?.id === head.id
            ? requestInput.requestReceivedAt
            : undefined;
        if (requestReceivedAt !== undefined) {
          timing.recordDuration(
            "api_dispatch_request_received_to_enqueue_commit",
            "top_level",
            committedAt - requestReceivedAt,
            committedAt,
            {
              capture_scope: "request_observed_commit",
              ...(requestInput?.enqueueObservationId
                ? {
                    enqueue_observation_id: requestInput.enqueueObservationId,
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
    requestInput,
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
  // Per-claim dispatch timing collectors, created once per graph like the run
  // ids; commands record into them in their own order.
  const claimRunTiming$ = computed((get): ClaimRunTiming => {
    return {
      run: get(threadContext.dispatchTiming$),
      phase: new ApiDispatchPhaseCollector(get(pickStartedAt$)),
    };
  });
  // Runner and guest `api_to_*` rows start at `POST /api/chat/events` receipt,
  // and only for the input that request committed and then picked itself.
  // Any other pick (queued behind a run, cron, slot release, other producers)
  // carries no API start time, so those rows are not emitted for it.
  const runnerApiStartTime$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    return event && requestInput?.id === event.id
      ? requestInput.requestReceivedAt
      : undefined;
  });
  // Generated once per claim graph; read after authorization admits the head.
  const runIds$ = threadContext.runIds$;
  const head$ = computed(async (get) => {
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
      captureNetworkBodies: event.preparation.captureNetworkBodies,
    };
  });
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
      const proactive =
        event.contextType === "proactive" &&
        (await get(threadContext.proactiveInput$));
      if (event.contextType === "proactive" && !proactive) {
        throw new QueuedPromptLaunchUnavailableError(
          "Proactive occurrence is no longer eligible",
        );
      }
      if (event.preparation.isPlatformTaskThread && !proactive) {
        throw new QueuedPromptLaunchUnavailableError(
          PLATFORM_TASK_THREAD_READ_ONLY_MESSAGE,
        );
      }
      if (event.contextType === "automation") {
        throw new Error("Automation cannot enter the prompt assembler");
      }
      return {
        id: event.id,
        contextType: event.contextType,
        autonomyBudget: queuedUserMessageAutonomyBudget(
          event.contextType,
          event.sourceAutonomyBudget,
          get(maxAutonomyBudget$),
        ),
      };
    },
  );
  const promptArgs$ = computed(async (get): Promise<QueuedChatPromptData> => {
    const head = await get(head$);
    const queuedMessage = await get(promptMessage$);
    if (!queuedMessage || queuedMessage.id !== head.id) {
      throw new Error("Prompt preparation lost its selected head");
    }
    return {
      threadId: head.chatThreadId,
      userId: bootstrap.userId,
      orgId: bootstrap.orgId,
      queuedMessage,
    };
  });
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
  const promptSourceMaterial$ = computed(
    async (get): Promise<QueuedLaunchMaterial> => {
      const { queuedMessage } = await get(promptArgs$);
      switch (queuedMessage.contextType) {
        case "proactive": {
          return { triggerSource: "proactive", delivery: {} };
        }
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
              feishuDelivery: feishuDeliveryFromContext(context),
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
      }
      throw new QueuedPromptLaunchUnavailableError();
    },
  );
  const promptMaterial$ = computed(async (get) => {
    const source = await get(promptSourceMaterial$);
    return {
      source,
      launch: source,
    };
  });
  const runTemplates$ = threadContext.templates$;
  const assembledPrompt$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const [args, material, model, session, head, features, templates] =
        await Promise.all([
          get(promptArgs$),
          get(promptMaterial$),
          get(threadContext.modelSelection$),
          get(threadContext.threadContinuation$),
          get(head$),
          get(bootstrap.featureSwitches$),
          get(runTemplates$),
        ]);
      const reject = (
        error: ChatQueueHeadRejection["error"],
      ): ChatQueueRunAssembly => {
        return {
          kind: "rejected",
          rejection: {
            ...queuedPromptRejectionContext(args, material.source.delivery),
            error,
          },
        };
      };
      const autonomy = args.queuedMessage.autonomyBudget;
      if (autonomy.kind !== "ok") {
        return reject({
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
        return reject(model.body.error);
      }
      if ("error" in templates) {
        return reject(templates.error);
      }
      const runPrompt = await get(preparedRunPrompt$);
      if (isRouteError(runPrompt)) {
        return reject(runPrompt.body.error);
      }
      if (!session) {
        throw new Error("A valid prompt model is missing session preparation");
      }
      const { triggerSource, delivery } = material.launch;
      const parts = (await get(queuedInput$))?.userMessage.parts.filter(
        (part) => {
          return part.type !== "model";
        },
      );
      const voiceClipFileIds =
        parts?.length &&
        parts.every((part) => {
          return part.type === "voice";
        })
          ? parts.flatMap((part) => {
              return part.clips.map((clip) => {
                return clip.fileId;
              });
            })
          : undefined;
      return {
        kind: "assembled",
        source: "prompt",
        run: {
          owner: { userId: args.userId, orgId: args.orgId },
          // Dispatch timing starts at admission; queue waiting is recorded separately.
          apiStartTime: head.apiStartTime,
          chatThreadId: args.threadId,
          codexServiceTier: model.codexServiceTier,
          reasoningEffort: model.reasoningEffort,
          triggerSource,
          agentRunMetadata: { autonomyBudget: autonomy.autonomyBudget },
          ...(isFeatureEnabled(FeatureSwitchKey.RealAgentInPreview, features)
            ? { realAgentInPreview: true }
            : {}),
          ...(head.captureNetworkBodies ? { captureNetworkBodies: true } : {}),
        },
        promptContinuation: session,
        runPrompt,
        rejection: queuedPromptRejectionContext(args, delivery),
        launchRecord: {
          kind: "prompt",
          templateUsageIdentities: templates.templateUsageIdentities,
          context: {
            userId: head.userId,
            orgId: args.orgId,
            threadId: args.threadId,
            prompt: runPrompt.userPrompt,
            voiceClipFileIds,
            triggerSource,
            discordDelivery: delivery.discordDelivery,
            wechatDelivery: delivery.wechatDelivery,
            titled: (await get(pickedEvent$))?.thread.titled ?? false,
          },
        },
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
  const promptAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const early = await get(earlyPromptAssembly$);
      if (early) {
        return early;
      }
      const head = await get(head$);
      const prepared = await settle(get(assembledPrompt$));
      return prepared.ok
        ? prepared.value
        : queuedPromptPreparationRejection(prepared.error, head);
    },
  );
  const availablePromptMaterial$ = computed(async (get) => {
    const material = await settle(get(promptMaterial$));
    if (!material.ok && isQueuedPromptPreparationError(material.error)) {
      return null;
    }
    return material;
  });
  const promptResourcesValid$ = computed(async (get) => {
    const [material, templates] = await Promise.all([
      get(availablePromptMaterial$),
      get(runTemplates$),
    ]);
    if (!material) {
      return false;
    }
    if (!material.ok) {
      throw material.error;
    }
    return !("error" in templates);
  });
  const promptIdentity$ = computed(async (get) => {
    if (await get(earlyPromptAssembly$)) {
      return null;
    }
    const args = await get(promptArgs$);
    return {
      owner: { userId: args.userId, orgId: args.orgId },
    };
  });
  const promptReady$ = computed(async (get) => {
    if (await get(earlyPromptAssembly$)) {
      return false;
    }
    const [args, model] = await Promise.all([
      get(promptArgs$),
      get(threadContext.modelSelection$),
    ]);
    return (
      !("status" in model) && args.queuedMessage.autonomyBudget.kind === "ok"
    );
  });
  const promptCallbacks$ = computed(async (get) => {
    if (await get(earlyPromptAssembly$)) {
      return [];
    }
    const [args, material] = await Promise.all([
      get(promptArgs$),
      get(availablePromptMaterial$),
    ]);
    if (!material) {
      return [];
    }
    if (!material.ok) {
      throw material.error;
    }
    return queuedChatRunCallbackInputs({
      threadId: args.threadId,
      queuedMessageId: args.queuedMessage.id,
      delivery: material.value.launch.delivery,
    });
  });
  const automationSource$ = computed(async (get) => {
    const snapshot = await get(threadContext.automationSnapshot$);
    if (snapshot?.target) {
      return { ...snapshot, kind: "ready" as const, target: snapshot.target };
    }
    const head = await get(head$);
    const assembly: RejectedQueueRunAssembly = {
      kind: "rejected",
      rejection: {
        userId: head.userId,
        error: conflict("Workflow automation no longer exists").body.error,
      },
    };
    return { kind: "rejected" as const, event: snapshot?.event, assembly };
  });
  const automationBudget$ = computed(
    async (get): Promise<AutonomyBudgetResult> => {
      const input = await get(automationSource$);
      if (input.kind === "rejected") {
        return { kind: "invalid", error: input.assembly.rejection.error };
      }
      const { event, target, sourceRunIdType, sourceAutonomyBudget } = input;
      if (event.eventType !== "chat-run-finished" && sourceRunIdType === null) {
        return { kind: "ok", autonomyBudget: target.automation.autonomyBudget };
      }
      const label =
        event.eventType === "manual"
          ? "Manual automation"
          : "Chat run finished";
      if (sourceRunIdType !== "string") {
        return {
          kind: "invalid",
          error: {
            code: "AUTONOMY_SOURCE_UNAVAILABLE",
            message: `${label} event is missing its source run`,
          },
        };
      }
      if (sourceAutonomyBudget === null) {
        return {
          kind: "invalid",
          error: {
            code: "AUTONOMY_SOURCE_UNAVAILABLE",
            message: `${label} source run no longer exists`,
          },
        };
      }
      const derived = childAutonomyBudget(sourceAutonomyBudget);
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
  const automationModel$ = computed(
    async (get): Promise<ThreadModelSelection | ThreadModelError> => {
      if ((await get(automationSource$)).kind === "rejected") {
        return conflict("Workflow automation no longer exists");
      }
      return get(threadContext.dispatchTiming$).measure(
        "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context",
        "nested",
        () => {
          return get(threadContext.modelSelection$);
        },
      );
    },
  );
  const automationIdentity$ = computed(async (get) => {
    return (await get(automationSource$)).kind === "ready"
      ? { owner: { orgId: bootstrap.orgId, userId: bootstrap.userId } }
      : null;
  });
  const automationLaunch$ = computed(
    async (get): Promise<QueuedAutomationLaunch> => {
      const head = await get(head$);
      const input = await get(automationSource$);
      if (input.kind === "rejected") {
        return input.assembly;
      }
      const autonomyBudget = await get(automationBudget$);
      const { event, target } = input;
      if (
        target.workflow.officialDefinitionName !== null ||
        target.automation.officialBlueprintKey !== null ||
        event.eventType === "morning-brief-debug"
      ) {
        return {
          kind: "rejected",
          rejection: {
            error: conflict(RETIRED_WORKFLOW_RUN_MESSAGE).body.error,
            userId: head.userId,
          },
        };
      }
      const material = buildWorkflowAutomationQueuedLaunchMaterial({
        workflowName: event.workflowName,
        eventType: event.eventType,
        eventPayload: await get(threadContext.automationPayload$),
        automation: target.automation,
        chatThreadId: event.chatThreadId,
      });
      if (!material) {
        return {
          kind: "rejected",
          rejection: {
            userId: target.automation.ownerUserId,
            error: {
              code: "CONFLICT",
              message: "Workflow queue event payload is unreadable",
            },
          },
        };
      }
      if (autonomyBudget.kind === "invalid") {
        return {
          kind: "rejected",
          rejection: {
            userId: target.automation.ownerUserId,
            error: autonomyBudget.error,
          },
        };
      }
      return {
        kind: "launch",
        automation: target.automation,
        chatThreadId: event.chatThreadId,
        apiStartTime: head.apiStartTime,
        triggerBrief: event.triggerBrief ?? undefined,
        callbacks: material.callbacks,
        autonomyBudget: autonomyBudget.autonomyBudget,
        recordLastRunId: material.recordLastRunId,
        recordLastRunAt: material.recordLastRunAt,
      };
    },
  );
  const automationAssembly$ = computed(
    async (get): Promise<ChatQueueRunAssembly> => {
      const launch = await get(automationLaunch$);
      if (launch.kind === "rejected") {
        return launch;
      }
      const { automation, chatThreadId } = launch;
      const reject = (error: {
        readonly code: string;
        readonly message: string;
      }): ChatQueueRunAssembly => {
        return {
          kind: "rejected",
          rejection: { userId: automation.ownerUserId, error },
        };
      };
      const model = await get(automationModel$);
      if ("status" in model) {
        return reject(model.body.error);
      }
      const runPrompt = await get(preparedRunPrompt$);
      if (isRouteError(runPrompt)) {
        return reject(runPrompt.body.error);
      }
      return {
        kind: "assembled",
        source: "automation",
        run: {
          owner: { orgId: bootstrap.orgId, userId: bootstrap.userId },
          apiStartTime: launch.apiStartTime,
          triggerSource: workflowAutomationTriggerSource(automation),
          chatThreadId,
          codexServiceTier: model.codexServiceTier,
          reasoningEffort: model.reasoningEffort ?? null,
          agentRunMetadata: workflowAutomationRunMetadata(
            automation,
            launch.triggerBrief,
            launch.autonomyBudget,
          ),
        },
        runPrompt,
        rejection: { userId: automation.ownerUserId },
        launchRecord: {
          kind: "automation",
          automationId: automation.id,
          orgId: automation.orgId,
          userId: automation.ownerUserId,
          threadId: chatThreadId,
          recordLastRunId: launch.recordLastRunId,
          recordLastRunAt: launch.recordLastRunAt,
          disableClaimedOnceSchedule: automation.scheduleType === "once",
        },
      };
    },
  );
  const automationCallbacks$ = computed(async (get) => {
    const launch = await get(automationLaunch$);
    return launch.kind === "launch" ? launch.callbacks : [];
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
  const automationModelReady$ = computed(async (get) => {
    return !("status" in (await get(automationModel$)));
  });
  const selectionReady$ = computed(async (get) => {
    return get(
      (await get(isAutomation$)) ? automationModelReady$ : promptReady$,
    );
  });
  const callbackInputs$ = computed(
    async (get): Promise<readonly RunLaunchCallbackRecord[]> => {
      return (await get(isAutomation$))
        ? get(automationCallbacks$)
        : get(promptCallbacks$);
    },
  );
  const automationContinuation$ = computed(async (get) => {
    if (await get(isAutomation$)) {
      return get(threadContext.threadContinuation$);
    }
    return null;
  });
  const captureNetworkBodiesGate$ = computed(async (get) => {
    const head = await get(head$);
    return enforceCaptureNetworkBodiesGate(
      head.orgId,
      head.captureNetworkBodies,
    );
  });
  const preparedRunInput$ = computed(async (get) => {
    if (!(await get(selectionReady$))) {
      return null;
    }
    const [model, automationContinuation, assembly, head] = await Promise.all([
      get(threadContext.subscriptionSelection$),
      get(automationContinuation$),
      get(assembly$),
      get(head$),
    ]);
    if (assembly.kind !== "assembled") {
      return null;
    }
    if ("status" in model) {
      return model;
    }
    const resolution =
      assembly.source === "prompt"
        ? assembly.promptContinuation
        : automationContinuation;
    if (!resolution) {
      throw new Error(
        "Prepared Thread input is missing its captured continuation",
      );
    }
    const args = buildThreadRunArgs(
      {
        contextType: head.contextType,
        modelSelection: model.pin,
        command: assembly.run,
        threadContinuation: resolution,
      },
      assembly.runPrompt,
    );
    const gate = await get(captureNetworkBodiesGate$);
    return (
      gate ?? {
        args,
        runPrompt: assembly.runPrompt,
        pricedBuiltInRoute: model.pricedBuiltInRoute,
      }
    );
  });
  const promptResources = createPromptAndPackageSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  const preparedRunPrompt$ = computed(
    async (get): Promise<PreparedRunPrompt | CreateRunErrorResult> => {
      const route = await get(threadContext.modelRoute$);
      if (isRouteError(route)) {
        return route;
      }
      const result = await settle(get(promptResources.prompt$));
      if (!result.ok) {
        if (result.error instanceof RunPromptError) {
          // Source admission preserves the channel-specific rejection code.
          return result.error.code === "BAD_REQUEST"
            ? badRequestMessage(result.error.message)
            : conflict(result.error.message);
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
  const inputResources$ = computed(async (get) => {
    if (await get(isAutomation$)) {
      if ((await get(automationSource$)).kind === "ready") {
        await Promise.allSettled([
          get(automationModel$),
          get(connectorAdmission$),
          get(promptResources.suggestionsPrompt$),
        ]);
      }
      return;
    }
    await Promise.allSettled([
      get(threadContext.inputResources$),
      get(connectorAdmission$),
    ]);
  });
  const memoryOwner = { orgId: bootstrap.orgId, userId: bootstrap.userId };
  const memoryHeadAfterInitialization$ = createMemberMemoryHead(memoryOwner);
  const authorizedRunRoute$ = computed(async (get) => {
    const modelProvider = await get(threadContext.modelRoute$);
    if (isRouteError(modelProvider)) {
      return modelProvider;
    }
    return {
      modelProvider,
      framework:
        modelProvider.piModelConfig === undefined
          ? launchFrameworkForProviderType(modelProvider.type)
          : ("pi" as const),
    };
  });
  const runModelInputs$ = computed(async (get) => {
    const [route, vars, featureSwitchContext] = await Promise.all([
      get(authorizedRunRoute$),
      get(bootstrap.runVariables$),
      get(bootstrap.featureSwitches$),
    ]);
    if (isRouteError(route)) {
      return route;
    }
    const providerPermissions = safeSync(() => {
      return modelProviderPermissionManifest(route.modelProvider, vars);
    });
    if ("error" in providerPermissions) {
      if (providerPermissions.error instanceof FirewallBaseUrlResolutionError) {
        return badRequestMessage(providerPermissions.error.message);
      }
      throw providerPermissions.error;
    }
    return {
      ...route,
      vars,
      featureSwitchContext,
      providerPermissions: providerPermissions.ok,
    };
  });
  const runIntegration$ = computed(async (get) => {
    const event = await get(queuedInput$);
    if (!event) {
      throw new Error("Run integration requires its selected input");
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

    return integration;
  });
  const runPlan$ = computed(
    async (get): Promise<RunPlan | CreateRunErrorResult | null> => {
      const input = await get(preparedRunInput$);
      if (!input || isRouteError(input)) {
        return input;
      }
      const { args, runPrompt } = input;
      const usage = (async () => {
        const runtime = await get(runModelInputs$);
        if (
          isRouteError(runtime) ||
          !isBuiltInModelProviderType(runtime.modelProvider.type)
        ) {
          return runtime;
        }
        const [catalog, modelPricing] = await Promise.all([
          get(claimCatalog$),
          get(bootstrap.modelPricing$),
        ]);
        const usageError = validateModelUsage({
          catalog,
          modelProvider: runtime.modelProvider,
          providerPermissions: runtime.providerPermissions,
          pricedRoute: input.pricedBuiltInRoute,
          routePricing: runRoutePricingFromSnapshot(
            {
              modelProvider: runtime.modelProvider,
              serviceTier: args.codexServiceTier,
            },
            modelPricing,
          ),
        });
        return usageError === null ? runtime : providerUnavailable(usageError);
      })();
      const [route, connector, runtimeResult] = await Promise.all([
        get(authorizedRunRoute$),
        get(connectorAdmission$),
        settle(usage),
      ]);
      // Preserve the existing rejection order when both branches reject admission.
      if (isRouteError(route)) {
        return route;
      }
      if (isRouteError(connector)) {
        return connector;
      }
      if (!runtimeResult.ok) {
        throw runtimeResult.error;
      }
      const runtime = runtimeResult.value;
      if (isRouteError(runtime)) {
        return runtime;
      }
      const { vars, featureSwitchContext, modelProvider } = runtime;
      const tierError = checkRunServiceTier(
        args.codexServiceTier,
        featureSwitchContext,
      );
      if (tierError) {
        return tierError;
      }
      const content = {
        prompt: args.prompt,
        appendSystemPrompt: args.appendSystemPrompt,
        triggerSource: args.triggerSource,
        vars,
      };
      const launchSnapshot = {
        schemaVersion: 5 as const,
        framework: runtime.framework,
        runnerProfile: DEFAULT_PROFILE,
      };
      const event = await get(queuedInput$);
      if (!event) {
        throw new Error("Run preparation requires its selected input");
      }
      const integration = await get(runIntegration$);
      return {
        args,
        integrationContext: runPrompt.systemPromptVariables.integrationContext,
        persisted: {
          inputEvent: event,
          content,
          selectedImageModel: runPrompt.selectedImageModel,
          launchSnapshot,
          modelProvider: persistedModelProvider(modelProvider),
        },
        runner: {
          sessionContinuation:
            args.threadContinuation.executionSnapshot.sessionContinuation,
          nativeContinuation:
            args.threadContinuation.executionSnapshot.nativeContinuation,
          realAgentInPreview: args.realAgentInPreview,
          profile: launchSnapshot.runnerProfile,
          featureSwitchContext,
          facts: {
            integration,
            captureNetworkBodies: args.captureNetworkBodies === true,
            modelProvider,
            modelProviderPermissions: runtime.providerPermissions,
            connectorEnvironment: connector.environment,
            userTimezone: runPrompt.userTimezone,
          },
          apiStartTime: await get(runnerApiStartTime$),
          chatThreadId: args.chatThreadId,
        },
      };
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
      const delivery = rejection.delivery
        ? set(
            deliverQueuedPromptRejection$,
            rejection.delivery,
            assistantEventId,
            signal,
          )
        : error.code === "INTERNAL_ERROR"
          ? set(
              deliverUnexpectedQueuedPromptRejection$,
              {
                head,
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
  // Resource reads do not wait for credit admission: its failure is checked
  // with the prepared resources before anything is committed.
  const resourceAllowed$ = computed(async (get) => {
    // Eager preparation must not evaluate a Run plan for an automation source
    // whose delegation admission already rejects it.
    if (await get(isAutomation$)) {
      return (
        (await get(automationBudget$)).kind === "ok" &&
        get(automationModelReady$)
      );
    }
    const [ready, validSource] = await Promise.all([
      get(promptReady$),
      get(promptResourcesValid$),
    ]);
    return ready && validSource;
  });
  // The pick captured Memory alongside the predecessor session binding.
  const memoryHead$ = computed(async (get) => {
    return decodeMemberMemoryHead((await get(preparation$)).memoryHead);
  });
  const preparedMemory$ = computed(async (get) => {
    if (!(await get(resourceAllowed$))) {
      return null;
    }
    const plan = await get(runPlan$);
    if (!plan || isRouteError(plan)) {
      return plan;
    }
    return {
      head: await get(memoryHead$),
    };
  });
  const runnerPackages$ = computed(async (get) => {
    const [route, automation] = await Promise.all([
      get(authorizedRunRoute$),
      get(isAutomation$),
    ]);
    if (isRouteError(route)) {
      return route;
    }
    const timing = get(threadContext.dispatchTiming$);
    const [startupSources, packageSources, ordinaryAutomation] =
      await Promise.all([
        get(promptResources.packageSources$),
        timing.measure(
          "api_dispatch_prepare_execution_package_wait",
          "nested",
          () => {
            return get(threadContext.executionPackageSources$);
          },
        ),
        automation ? get(threadContext.automationTarget$) : null,
      ]);
    const { mounts, memoryMountPath } = prepareRunPackageMounts({
      framework: route.framework,
      sources: startupSources,
    });
    const selected = selectExecutionPackages(
      packageSources,
      ordinaryAutomation,
    );
    if ("error" in selected) {
      return conflict(selected.error);
    }
    return {
      memoryMountPath,
      packages: {
        mounts,
        bundles: selectExecutionContentBundles(selected, mounts),
      },
    };
  });
  const executionBundles$ = computed(async (get) => {
    const [automation, captureNetworkBodies] = await Promise.all([
      get(isAutomation$),
      get(captureNetworkBodiesGate$),
    ]);
    if (captureNetworkBodies) {
      return null;
    }
    if (automation) {
      if (
        !(await get(resourceAllowed$)) ||
        (await get(automationLaunch$)).kind !== "launch"
      ) {
        return null;
      }
    } else {
      // Prompt material can still be loading from an integration. Package
      // selection needs the prepared input's model and templates.
      const [ready, templates] = await Promise.all([
        get(promptReady$),
        get(runTemplates$),
      ]);
      if (!ready || "error" in templates) {
        return null;
      }
    }
    const packagePlan = await get(runnerPackages$);
    return isRouteError(packagePlan) ? null : packagePlan.packages.bundles;
  });
  const executionBundleCache$ = createExecutionBundleCache(executionBundles$);
  /** The run token makes runner input a command; its result is passed on. */
  const prepareRunnerInput$ = command(
    async ({ get, set }, args: ThreadRunnerFacts, signal: AbortSignal) => {
      signal.throwIfAborted();
      const [tokenInput, packagePlan, disabledPaidTools] = await Promise.all([
        get(okouTokenInput$),
        get(runnerPackages$),
        get(bootstrap.disabledPaidTools$),
      ]);
      signal.throwIfAborted();
      if (isRouteError(packagePlan)) {
        return packagePlan;
      }
      const okouToken = set(prepareOkouToken$, tokenInput, signal);
      const antigravityAccountId =
        args.facts.modelProvider.type === "antigravity"
          ? args.facts.modelProvider.id
          : undefined;
      if (antigravityAccountId === null) {
        throw new Error("An Antigravity run requires its member account");
      }
      const antigravityCredential = antigravityAccountId
        ? await set(
            mintAntigravityRunCredential$,
            {
              orgId: bootstrap.orgId,
              userId: bootstrap.userId,
              accountId: antigravityAccountId,
              featureSwitchContext: args.featureSwitchContext,
            },
            signal,
          )
        : undefined;
      signal.throwIfAborted();
      return {
        launch: prepareRunnerLaunch({
          args,
          packageMounts: packagePlan.packages.mounts,
          okouToken,
          antigravityCredential,
          disabledPaidTools,
        }),
        memoryMountPath: packagePlan.memoryMountPath,
      };
    },
  );
  const preparedCallbacks$ = computed(async (get) => {
    const callbacks = await get(callbackInputs$);
    return callbacks.map((callback): PreparedLaunchCallback => {
      // Normalize payloads to JSON: omit optional fields and serialize Dates.
      const serializedPayload = JSON.stringify(callback.payload);
      const payload =
        serializedPayload === undefined
          ? null
          : json().parse(JSON.parse(serializedPayload) as unknown);
      return {
        internalKind: callback.internalKind,
        payload,
      };
    });
  });
  const prepareRunnerStorage$ = command(
    async ({ get, set }, args: ThreadRunnerFacts, signal: AbortSignal) => {
      const [input, memory] = await joinAll([
        set(prepareRunnerInput$, args, signal),
        get(preparedMemory$),
      ]);
      signal.throwIfAborted();
      if (!input || isRouteError(input)) {
        return input;
      }
      if (!memory || isRouteError(memory)) {
        return memory;
      }
      // The initializer returns its own revision. An empty receipt means
      // another writer established HEAD after this pick captured Memory.
      const head =
        memory.head ??
        (await set(initializeMemberMemory$, memoryOwner, signal)) ??
        (await get(memoryHeadAfterInitialization$));
      signal.throwIfAborted();
      if (!head) {
        throw new Error("Member Memory has no HEAD after initialization");
      }
      return {
        ...input.launch,
        memoryMount: buildMemberMemoryMount(
          memoryOwner,
          head,
          input.memoryMountPath,
        ),
      };
    },
  );
  const initializeRunPreparation$ = command(
    async ({ get, set }, timing: ClaimRunTiming, signal: AbortSignal) => {
      signal.throwIfAborted();
      const head = await get(head$);
      signal.throwIfAborted();
      if (head.contextType === "automation") {
        timing.run.recordElapsed(
          "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
          "nested",
          head.apiStartTime,
        );
        const input = await get(automationSource$);
        signal.throwIfAborted();
        if (input.kind === "rejected") {
          if (input.event) {
            await set(
              revokeDeletedWorkflowAutomationInputs$,
              { orgId: claim.orgId, automationId: input.event.automationId },
              signal,
            );
          } else {
            await set(
              rejectChatQueueHead$,
              { head, rejection: input.assembly.rejection },
              signal,
            );
          }
          signal.throwIfAborted();
          return null;
        }
      }
      signal.throwIfAborted();
      const identityInput = await get(identityInput$);
      signal.throwIfAborted();
      if (!identityInput) {
        const assembly = await get(assembly$);
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
      return head;
    },
  );
  const prepareRunnerResources$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const plan = await get(runPlan$);
      signal.throwIfAborted();
      const runnerLaunch =
        !plan || isRouteError(plan)
          ? null
          : await set(prepareRunnerStorage$, plan.runner, signal);
      return { plan, runnerLaunch };
    },
  );
  /** Validate the automation source before starting shared launch reads. */
  const prepareLaunchResources$ = command(
    async ({ get, set }, head: ChatQueueHeadContext, signal: AbortSignal) => {
      if (head.contextType === "automation") {
        const launch = await get(automationLaunch$);
        signal.throwIfAborted();
        if (launch.kind === "rejected") {
          return launch;
        }
        await get(automationAssembly$);
        signal.throwIfAborted();
      }
      const [{ plan: input, runnerLaunch }, callbacks, assembly] =
        await joinAll([
          set(prepareRunnerResources$, signal),
          get(preparedCallbacks$),
          get(assembly$),
        ]);
      signal.throwIfAborted();
      if (assembly.kind !== "assembled") {
        return assembly;
      }
      const rejectResource = (failure: CreateRunErrorResult) => {
        return {
          kind: "rejected" as const,
          rejection: claimAssemblyRejection(assembly, head, failure.body.error),
        };
      };
      if (isRouteError(input)) {
        return rejectResource(input);
      }
      if (isRouteError(runnerLaunch)) {
        return rejectResource(runnerLaunch);
      }
      if (!input || !runnerLaunch) {
        return { kind: "missing-resources" as const };
      }
      return {
        kind: "prepared" as const,
        input,
        runnerLaunch,
        callbacks,
        assembly,
      };
    },
  );
  const prepareRunContext$ = command(
    async (
      { get, set },
      timing: ClaimRunTiming,
      signal: AbortSignal,
    ): Promise<ThreadRunContext | null> => {
      const head = await set(initializeRunPreparation$, timing, signal);
      signal.throwIfAborted();
      if (!head) {
        return null;
      }
      const [resources] = await joinAll([
        set(prepareLaunchResources$, head, signal),
        get(preparedMemory$),
        // Connector reads start independently of prompt/model material. A
        // prefetch miss joins the same loader once for this selected identity.
        get(bootstrap.connectors$),
        get(threadContext.connectorThreadSelections$),
      ]);
      signal.throwIfAborted();
      if (resources.kind === "missing-resources") {
        throw new Error("Prepared claim is missing launch resources");
      }
      if (resources.kind !== "prepared") {
        await set(
          rejectChatQueueHead$,
          {
            head,
            rejection:
              resources.kind === "rejected"
                ? resources.rejection
                : unreadyQueueHeadRejection(head),
          },
          signal,
        );
        return null;
      }
      const { input, runnerLaunch, callbacks, assembly } = resources;
      const { runId } = get(runIds$);
      await set(recordQueuedInputAdmissionTiming$, head, timing.run, signal);
      signal.throwIfAborted();
      const preparedContext = await timing.run.measure(
        "api_dispatch_prepare_atomic_launch_persistence",
        "nested",
        () => {
          return Promise.resolve(
            finalizeClaimRunContext(
              {
                input: claimCommitInput(input),
                identity: { runId },
                callbacks,
                launch: runnerLaunch,
                head,
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

  // Record the committed result only after pending publication returns.
  // This command does no launch preparation.
  const recordRunCommit$ = command(
    (
      _store,
      context: ThreadRunContext,
      committed: AtomicLaunchCommitCompletion,
      timing: ClaimRunTiming,
      signal: AbortSignal,
    ): PendingClaimRun | null => {
      const { input, identity, launch } = context;
      signal.throwIfAborted();
      if (committed.result.kind === "queue-first-claim-lost") {
        flushQueueFirstClaimLostTiming({
          createArgs: input.args,
          identity,
          launch,
          timing: timing.run,
          phaseTiming: timing.phase,
        });
        return null;
      }
      recordAtomicLaunchTiming({
        createArgs: input.args,
        committed: committed.result,
        transactionReturnedAt: committed.transactionReturnedAt,
        timing: timing.run,
        phaseTiming: timing.phase,
      });
      return {
        admittedLaunch: committed.result.admittedLaunch,
        marketingRewardEventId: committed.result.marketingRewardEventId,
        apiStartTime: input.args.apiStartTime,
        head: context.head,
        launchRecord: context.launchRecord,
      };
    },
  );

  const createRun$ = command(
    async (
      { get, set },
      {
        claim,
        context,
        timing,
        dispatchInput,
      }: {
        readonly claim: ThreadClaim;
        readonly context: ThreadRunContext;
        readonly timing: ClaimRunTiming;
        readonly dispatchInput: DirectRunInput;
      },
      signal: AbortSignal,
    ): Promise<PendingClaimRun | null> => {
      signal.throwIfAborted();
      const { input, identity, callbacks, launch } = context;
      const commit: ThreadLaunchCommitInput = {
        createArgs: input.args,
        context: input.context,
        identity,
        callbacks,
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
      const proactive =
        context.head.contextType === "proactive"
          ? await get(threadContext.proactiveInput$)
          : null;
      if (context.head.contextType === "proactive" && !proactive) {
        return null;
      }
      const preparedCommit: PreparedThreadLaunchCommit = {
        ...commit,
        persistence: context.persistence,
        dispatchInput,
        admissionTiming,
        poolCapture,
      };
      const commitTiming = timing.run;
      const commitStartedAt = performance.now();
      const committed: AtomicLaunchCommitCompletion = await (async () => {
        const result = await set(
          commitThreadLaunch$,
          preparedCommit,
          {
            orgId: claim.orgId,
            chatThreadId: claim.chatThreadId,
            claimId: claim.claimId,
            queuedAt: claim.queuedAt,
            ...(proactive
              ? {
                  proactive: {
                    id: context.head.id,
                    userId: context.head.userId,
                    suggestionsEnabled: proactive.suggestionsEnabled,
                    cardDeliveryEnabled: proactive.cardDeliveryEnabled,
                  },
                }
              : {}),
            automationQueueEventId:
              context.head.contextType === "automation"
                ? context.head.id
                : null,
          },
          signal,
        );
        if (result.kind === "pending") {
          set(internalCommittedRunId$, result.admittedLaunch.run.id);
          const launched = context.launchRecord;
          if (launched.kind === "prompt") {
            // Creation is durable even if cancellation or activation fails next.
            recordTemplateUsage(
              {
                runId: result.admittedLaunch.run.id,
                sourceEventId: context.head.id,
                orgId: context.head.orgId,
                userId: context.head.userId,
                chatThreadId: context.head.chatThreadId,
                dispatchPath: "queued-claim",
                triggerSource: launched.context.triggerSource,
                usedAt: new Date(result.publicationReturnedAt),
              },
              launched.templateUsageIdentities,
            );
          }
        }
        const transactionReturnedAt =
          result.kind === "pending" ? result.publicationReturnedAt : now();
        await admissionTiming.finish(
          result.kind === "pending" ? "pending" : "queue_first_claim_lost",
        );
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
      // The committed pending Run is the active indicator's only start edge.
      await publishChatIndicatorsChangedSafely({
        userId: pending.head.userId,
        orgId: pending.head.orgId,
      });
      signal.throwIfAborted();
      recordThreadRunActivationMarkers(
        {
          runId: pending.admittedLaunch.run.id,
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
                chatThreadId: pending.head.chatThreadId,
                chatEventsAppended: false,
              },
          signal,
        );
      }
      if (dispatched.failure !== undefined) {
        throw dispatched.failure;
      }
      const launched = pending.launchRecord;
      if (launched.kind === "prompt") {
        set(
          recordQueuedPromptRunLaunch$,
          launched.context,
          pending.admittedLaunch.run.id,
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
            ...(launched.recordLastRunId
              ? { lastRunId: pending.admittedLaunch.run.id }
              : {}),
            ...(launched.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
            ...(launched.disableClaimedOnceSchedule ? { enabled: false } : {}),
            updatedAt: nowDate(),
          };
        };
        if (
          await set(
            morningBriefScheduleClaimBound$,
            pending.admittedLaunch.run.id,
            signal,
          )
        ) {
          signal.throwIfAborted();
        } else {
          await database
            .update(workflowAutomations)
            .set(lastRunFields())
            .where(eq(workflowAutomations.id, launched.automationId));
        }
        signal.throwIfAborted();
      }
      // The initiating send publishes both invalidations after its sort touch.
      if (
        dispatched.kind !== "accepted" ||
        pending.head.id !== requestInput?.id
      ) {
        await set(publishChatQueueHeadConsumed$, pending.head, signal);
      }
    },
  );

  const hasFirstPickableChatEvent$ = computed(async (get) => {
    get(pickStartedAt$);
    return (await get(pickedEvent$)) !== null;
  });
  const failRunAdmission$ = command(
    async (
      { get, set },
      error: unknown,
      signal: AbortSignal,
    ): Promise<never> => {
      // A durable Run commit is creation success, even if subsequent
      // telemetry or cancellation fails. Never reject its consumed input.
      if (get(internalCommittedRunId$) !== null) {
        throw error;
      }
      const event = await get(pickedEvent$);
      signal.throwIfAborted();
      if (!event) {
        throw error;
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
      throw error;
    },
  );
  const prepareRunAdmission$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const event = get(pickedEvent$);
    const memoryArchive = (async () => {
      const head = await get(memoryHead$);
      return head
        ? await set(prepareExecutionMemoryArchive$, memoryOwner, head, signal)
        : null;
    })();
    const networkPolicyInputs = (async () => {
      const picked = await event;
      signal.throwIfAborted();
      if (
        !picked ||
        (picked.contextType === "automation" &&
          (await get(automationSource$)).kind === "rejected")
      ) {
        return null;
      }
      signal.throwIfAborted();
      const connector = await get(connectorAdmission$);
      signal.throwIfAborted();
      return isRouteError(connector)
        ? null
        : await set(prepareExecutionNetworkPolicy$, {
            connectorRuntimeTargets: connector.environment.runtimeTargets,
            networkPolicyInputs: connector.networkPolicyInputs,
          });
    })();
    const context = (async () => {
      const picked = await event;
      signal.throwIfAborted();
      if (!picked) {
        return null;
      }
      const prepared = await settle(
        set(prepareRunContext$, get(claimRunTiming$), signal),
        signal,
      );
      return prepared.ok
        ? prepared.value
        : await set(failRunAdmission$, prepared.error, signal);
    })();
    return { context, resources: { memoryArchive, networkPolicyInputs } };
  });
  const admitRun$ = command(
    (
      { get, set },
      context: ThreadRunContext,
      { memoryArchive, networkPolicyInputs }: RunResourcePreparation,
      bundleUrls: ExecutionBundleUrlsRead,
      signal: AbortSignal,
    ) => {
      const memory = (async () => {
        const { mount, head } = context.launch.memoryMount;
        // Missing Memory is supplied by the initializer's accepted revision.
        const archive =
          (await memoryArchive) ??
          (await set(
            prepareExecutionMemoryArchive$,
            memoryOwner,
            head,
            signal,
          ));
        signal.throwIfAborted();
        return executionMemoryMount(mount, archive);
      })();
      const dispatchInput = threadDispatchInput(context);
      const pending = (async () => {
        const committed = await settle(
          set(
            createRun$,
            { claim, context, timing: get(claimRunTiming$), dispatchInput },
            signal,
          ),
          signal,
        );
        return committed.ok
          ? committed.value
          : await set(failRunAdmission$, committed.error, signal);
      })();
      const resources = { memory, networkPolicyInputs };
      const early =
        requestInput?.id === context.head.id
          ? set(
              prepareDirectRunInputs$,
              dispatchInput,
              null,
              { bundleUrls, resources },
              signal,
            )
          : undefined;
      return { pending, resources, early };
    },
  );
  return {
    threadHasActiveRun$,
    inputResources$,
    hasFirstPickableChatEvent$,
    orgHasCapacity$,
    executionBundleCache$,
    prepareRunAdmission$,
    admitRun$,
    publishPendingRun$,
    finishPendingRun$,
  };
}

// --- Thread-private implementation: launch persistence ---

function runnerReuseKey(chatThreadId: string): string {
  return `thread:${chatThreadId}`;
}

interface LaunchRunIdentity {
  readonly runId: string;
}

interface PersistedAtomicLaunchRows {
  readonly kind: "pending";
  readonly marketingRewardEventId: string | null;
  readonly createdAt: Date;
  readonly isFirstRun: boolean;
}

interface PreparedRunnerLaunch {
  readonly antigravityEnabled: boolean;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly facts: AdmittedExecutionFacts;
  readonly packageMounts: AdmittedRunLaunch["packageMounts"];
  readonly memoryMount: AcceptedMemoryMount;
}

interface PreparedLaunchCallback {
  readonly internalKind: RunLaunchCallbackRecord["internalKind"];
  readonly payload: AgentRunCallbackPayload;
}

interface QueueFirstRunClaimLost {
  readonly kind: "queue-first-claim-lost";
}

type AtomicLaunchCommitResult =
  | {
      readonly kind: "pending";
      readonly marketingRewardEventId: string | null;
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
  readonly selectedImageModel: ImageModel | null;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly modelProvider: Pick<
    ResolvedModelProviderEnvironment,
    | "accountIdentity"
    | "id"
    | "type"
    | "builtInModelRuntimeRoute"
    | "upstreamModel"
  >;
}

interface ThreadLaunchCommitInput {
  readonly createArgs: ThreadRunPersistenceArgs;
  readonly context: ThreadRunPersistenceContext;
  readonly identity: LaunchRunIdentity;
  readonly callbacks: readonly PreparedLaunchCallback[];
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
}

interface LaunchRunRowsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly identity: LaunchRunIdentity;
  readonly content: ThreadRunContent;
  readonly memoryMount: PersistedStorageMount;
  readonly modelProvider: ThreadRunPersistenceContext["modelProvider"];
  readonly modelSelection: ModelFirstPin;
  readonly selectedImageModel: ImageModel | null;
  readonly callbacks: readonly PreparedLaunchCallback[];
  readonly chatThreadId: string;
  readonly agentRunMetadata: AgentRunMetadata;
  readonly apiStartTime: number;
  readonly runnerGroup: string;
  readonly launchSnapshot: AgentRunLaunchSnapshot;
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
    modelProviderAccountIdentity: args.modelProvider.accountIdentity,
    prompt: args.content.prompt,
    storageMounts: [args.memoryMount],
    runnerGroup: args.runnerGroup,
    launchSnapshot: args.launchSnapshot,
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
    selectedModel:
      args.content.triggerSource === "proactive"
        ? PROACTIVE_SELECTED_MODEL
        : modelPin.selectedModel,
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
    content: commit.context.content,
    memoryMount: commit.launch.memoryMount.mount,
    modelProvider: commit.context.modelProvider,
    modelSelection: commit.createArgs.modelSelection,
    selectedImageModel: commit.context.selectedImageModel,
    callbacks: commit.callbacks,
    chatThreadId: commit.createArgs.chatThreadId,
    agentRunMetadata: commit.createArgs.agentRunMetadata,
    apiStartTime: commit.createArgs.apiStartTime,
    runnerGroup: commit.launch.runnerGroup,
    launchSnapshot: commit.context.launchSnapshot,
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
  readonly dispatchInput: DirectRunInput;
  readonly persistence: PreparedAtomicLaunchPersistence;
  readonly admissionTiming: AdmissionAttemptTiming;
  readonly poolCapture: PgPoolAcquisitionCapture;
}

function prepareAtomicLaunchPersistence(
  commit: ThreadLaunchCommitInput,
): PreparedAtomicLaunchPersistence {
  const rowsArgs = preparedLaunchRowsArgs(commit);
  return {
    rows: { rowsArgs, metadata: launchRunMetadataValues(rowsArgs) },
    diagnosticRegistrationPayload: {
      version: 1,
      targets: [...commit.launch.facts.connectorEnvironment.runtimeTargets],
    },
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
  readonly callbacks: readonly PreparedLaunchCallback[];
  readonly insertedRun: ReturnedIdCte;
  readonly createdAt: Date;
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
            {
              runId: returnedCteId(args.insertedRun),
              internalKind: callback.internalKind,
              payload: callback.payload,
              // The file index is available as soon as the Run is published.
              ...(callback.internalKind === FEISHU_RUN_FILE_INDEX_KIND
                ? { status: "delivered", deliveredAt: args.createdAt }
                : {}),
            },
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
    callbacks: rowsArgs.callbacks,
    insertedRun,
    createdAt,
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
    runId: args.committed.admittedLaunch.run.id,
    runnerGroup: args.committed.admittedLaunch.runnerGroup,
    profile: args.committed.admittedLaunch.profile,
    dimensions: args.createArgs.timingDimensions,
    triggerSource: args.createArgs.triggerSource,
  });
}
// --- Thread-private implementation: model provider environment ---

function persistedModelProvider({
  accountIdentity,
  id,
  type,
  upstreamModel,
  builtInModelRuntimeRoute,
}: ResolvedModelProviderEnvironment): RunPlan["persisted"]["modelProvider"] {
  return {
    accountIdentity,
    id,
    type,
    upstreamModel,
    builtInModelRuntimeRoute,
  };
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
  readonly realAgentInPreview?: boolean;
  readonly captureNetworkBodies?: boolean;
  readonly apiStartTime: number;
  readonly triggerSource: TriggerSource;
  readonly chatThreadId: string;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly agentRunMetadata: AgentRunMetadata;
}

// --- Thread-private implementation: launch input ---

/** The Thread facts needed to prepare one Runner launch. */
interface ThreadRunnerFacts {
  readonly facts: Pick<
    AdmittedExecutionFacts,
    | "integration"
    | "captureNetworkBodies"
    | "modelProvider"
    | "modelProviderPermissions"
    | "connectorEnvironment"
    | "userTimezone"
  >;
  readonly sessionContinuation: ChatThreadContinuation["executionSnapshot"]["sessionContinuation"];
  readonly nativeContinuation: ChatThreadContinuation["executionSnapshot"]["nativeContinuation"];
  readonly realAgentInPreview?: boolean;
  readonly profile: string;
  readonly apiStartTime: number | undefined;
  readonly chatThreadId: string;
  readonly featureSwitchContext: BootstrapFeatureSwitchContext;
}

/** Capture selectors and request receipts; admitted preparation assembles runtime input. */
function prepareRunnerLaunch(input: {
  readonly args: ThreadRunnerFacts;
  readonly packageMounts: AdmittedRunLaunch["packageMounts"];
  readonly okouToken: string;
  readonly antigravityCredential: string | undefined;
  readonly disabledPaidTools: readonly PaidToolId[];
}): Omit<PreparedRunnerLaunch, "memoryMount"> {
  const { args } = input;
  const facts = {
    ...args.facts,
    sessionContinuation: args.sessionContinuation,
    nativeContinuation: args.nativeContinuation,
    okouToken: input.okouToken,
    ...(input.antigravityCredential
      ? { antigravityCredential: input.antigravityCredential }
      : {}),
    disabledPaidTools: input.disabledPaidTools,
    realAgentInPreview: args.realAgentInPreview || undefined,
    apiStartTime: args.apiStartTime,
    featureFlags: {
      [FeatureSwitchKey.ArtifactThreePointTiming]: isFeatureEnabled(
        FeatureSwitchKey.ArtifactThreePointTiming,
        args.featureSwitchContext,
      ),
    },
  };
  return {
    runnerGroup: preparedRunnerGroup(),
    antigravityEnabled: isAntigravityEnabled(args.featureSwitchContext),
    profile: args.profile,
    reuseKey: runnerReuseKey(args.chatThreadId),
    facts,
    packageMounts: input.packageMounts,
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

interface ThreadRunArgsInput {
  readonly contextType: string | null;
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
  prompt: Pick<PreparedRunPrompt, "userPrompt" | "appendedSystemPrompt">,
): ThreadRunArgs {
  const command = args.command;
  const origin = command.agentRunMetadata.workflowAutomationId
    ? "workflow_automation"
    : command.triggerSource === "proactive"
      ? "proactive"
      : "direct";
  return {
    orgId: command.owner.orgId,
    userId: command.owner.userId,
    codexServiceTier: command.codexServiceTier,
    prompt: prompt.userPrompt,
    realAgentInPreview: command.realAgentInPreview,
    captureNetworkBodies: command.captureNetworkBodies,
    triggerSource: command.triggerSource,
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
    timingDimensions: {
      agent_run_origin: origin,
      api_start_source: "queue_event",
      ...(args.contextType ? { context_type: args.contextType } : {}),
    },
  };
}

interface ThreadRunIdentityInput {
  readonly owner: ThreadRunOwner;
}

// --- Thread-private implementation: launch admission ---

interface AtomicLaunchCommitCompletion {
  readonly result: AtomicLaunchCommitResult;
  readonly transactionReturnedAt: number;
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

/** Return the durable identity before the caller observes cancellation. */
async function pendingLaunchCommitResult(
  args: PreparedThreadLaunchCommit,
  publication: Promise<{
    readonly persisted: ReturnType<typeof pendingAtomicLaunchResult>;
    readonly publicationReturnedAt: number;
  }>,
): Promise<AtomicLaunchCommitResult> {
  const { persisted, publicationReturnedAt } = await publication;
  args.admissionTiming.callbackFinished();
  if (persisted.kind === "queue-first-claim-lost") {
    return persisted;
  }
  return {
    kind: "pending",
    marketingRewardEventId: persisted.marketingRewardEventId,
    admittedLaunch: {
      ...args.dispatchInput,
      run: { ...args.dispatchInput.run, isFirstRun: persisted.isFirstRun },
      createdAt: persisted.createdAt,
    },
    publicationReturnedAt,
  };
}

function threadDispatchInput(args: ThreadRunContext): DirectRunInput {
  const { rowsArgs: rows, metadata } = args.persistence.rows;
  return {
    run: {
      id: args.identity.runId,
      triggerSource: metadata.triggerSource,
      userId: rows.userId,
      orgId: rows.orgId,
      chatThreadId: rows.chatThreadId,
      framework: rows.launchSnapshot.framework,
      prompt: rows.content.prompt,
      appendSystemPrompt: rows.content.appendSystemPrompt,
      vars: rows.content.vars,
      modelProvider: rows.modelSelection.modelProviderType,
      selectedModel: rows.modelSelection.selectedModel,
      modelUsageProvider: metadata.modelUsageProvider,
      modelLongContextMinTotalInputTokens:
        metadata.modelLongContextMinTotalInputTokens,
      reasoningEffort: metadata.reasoningEffort,
      codexServiceTier: metadata.codexServiceTier,
    },
    packageMounts: args.launch.packageMounts,
    facts: args.launch.facts,
    runnerGroup: args.launch.runnerGroup,
    profile: args.launch.profile,
    reuseKey: args.launch.reuseKey,
    antigravityEnabled: args.launch.antigravityEnabled,
    predecessorRunId:
      args.input.args.threadContinuation.expected.frameworkSessionRunId,
  };
}

const pendingLaunchRowSchema = discriminatedUnion("kind", [
  object({
    kind: literal("pending"),
    createdAt: pgTimestampWithoutTimezoneToDateSchema,
    isFirstRun: boolean(),
    marketingRewardEventId: uuid().nullable(),
  }),
  object({ kind: literal("claim-lost") }),
]);

function pendingAtomicLaunchResult(
  row: zInfer<typeof pendingLaunchRowSchema> | undefined,
): PersistedAtomicLaunchRows | QueueFirstRunClaimLost {
  if (!row) {
    throw new Error("Atomic pending launch persistence returned no row");
  }
  if (row.kind === "claim-lost") {
    return { kind: "queue-first-claim-lost" };
  }
  return {
    kind: "pending",
    marketingRewardEventId: row.marketingRewardEventId,
    createdAt: row.createdAt,
    isFirstRun: row.isFirstRun,
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
      context.rowsArgs.content.triggerSource === "proactive"
        ? "platform_proactive"
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
  const planned = ctes.map((cte) => {
    return sql`${sql.identifier(cte._.alias)} AS ${cte === context.updatedThread ? sql`MATERIALIZED` : sql.empty()} (${cte._.sql})`;
  });
  if (args.claim.automationQueueEventId !== null) {
    const beforeBinding = pendingLaunchBarrier(names);
    const binding = pendingLaunchMorningBriefBindingSql(
      args.claim.automationQueueEventId,
      context.rowsArgs.identity.runId,
      sql`EXISTS (SELECT 1 FROM ${context.insertedRun}) AND ${beforeBinding} >= 0`,
    );
    const name = "launch_morning_brief_binding";
    names.push(name);
    planned.push(sql`${sql.identifier(name)} AS (${binding})`);
  }
  const active = pendingLaunchActivePublication(
    args,
    context,
    attribution,
    pendingLaunchBarrier(names),
  );
  const earlierRunEvents = new QueryBuilder()
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, args.commit.createArgs.chatThreadId),
        isNotNull(chatEvents.runId),
        ne(chatEvents.runId, context.rowsArgs.identity.runId),
      ),
    );
  return sql`WITH ${pendingLaunchPublicationCtes(args)},
    ${sql.join(planned, sql`, `)},
    launch_active AS (${active})
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM ${context.insertedRun}) THEN 'pending'
      ELSE 'claim-lost' END AS kind,
      (SELECT id FROM launch_workflow_source) AS "marketingRewardEventId",
      (SELECT ${returnedCteColumn(context.insertedRun, "created_at")} FROM ${context.insertedRun})::text AS "createdAt",
      CASE WHEN EXISTS (SELECT 1 FROM ${context.insertedRun}) THEN
        ${notExists(earlierRunEvents)}
      END AS "isFirstRun"
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
  const headMatches = eq(sql`(${currentHead})`, claimedInput.revokesEventId);
  const eligibility = claim.proactive
    ? sql`${headMatches} AND EXISTS (${proactiveInputSql({ ...claim, ...claim.proactive }, claim.proactive)})`
    : headMatches;
  const claimCtes = sql`${canonicalChatEventInputCtes(
    [claimedInput],
    eligibility,
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
  const fencePrerequisite = sql`EXISTS (SELECT 1 FROM inserted)
              AND (SELECT ${count()} FROM launch_claim_relations) >= 0`;
  const deleted = sql`, deleted_pending_token AS (${pendingLaunchEmptyQueueDeleteSql(
    claim,
    claimedInput.revokesEventId,
    fencePrerequisite,
  )})`;
  const released = sql`, released_pending_token AS (${pendingLaunchClaimFenceSql(
    claim,
    sql`NOT EXISTS (SELECT 1 FROM deleted_pending_token)
              AND ${fencePrerequisite}`,
  )})`;
  const receipt = claim.proactive
    ? sql`, admitted_proactive AS (
    UPDATE proactive_occurrences SET run_id=${claimedInput.runId}::uuid,suggestions_enabled=${claim.proactive.suggestionsEnabled},card_delivery_enabled=${claim.proactive.cardDeliveryEnabled}
    WHERE id=${claim.proactive.id}::uuid AND EXISTS (SELECT 1 FROM inserted) RETURNING id)`
    : sql.empty();
  return sql`${claimCtes}${receipt}${deleted}${released}`;
}

function pendingLaunchGuardedRunId(
  args: AtomicLaunchRowsPlanArgs,
  thread: WithSubquery,
): SQL {
  const guards: SQL[] = [
    sql`WHEN (SELECT ${count()} FROM deleted_pending_token) + (SELECT ${count()} FROM released_pending_token) <> 1 THEN '__TX0263_TOKEN__'`,
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
  ): Promise<AtomicLaunchCommitResult> => {
    signal.throwIfAborted();
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
          withPgPoolAcquisitionCapture(args.poolCapture, async () => {
            return parseRawRows(pendingLaunchRowSchema, await db.execute(plan));
          }),
        );
        if (!outcome.ok) {
          signal.throwIfAborted();
          throwPendingLaunchGuardFailure(outcome.error);
          throw outcome.error;
        }
        // Publication has committed. Return its durable identity before the
        // caller observes cancellation; do not orphan an accepted pending Run.
        const materializeStartedAt = monotonicNow();
        const result = pendingAtomicLaunchResult(outcome.value[0]);
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
    return await pendingLaunchCommitResult(args, publication);
  },
);
