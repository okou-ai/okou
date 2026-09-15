import { historicalRunGroupId } from "./run-event-provenance.service";
import { resolveReasoningEffortForDispatch } from "./chat-reasoning-effort.service";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { loadIntroVideoTemplateAccess } from "./intro-video-access.service";
import { randomBytes } from "node:crypto";

import { command, createStore } from "ccstate";
import {
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { formatRunErrorForExternalSurface } from "@okouai/api-contracts/contracts/errors";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  serializeChatFollowupsContent,
  type ChatRecommendedFollowup,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  publicBrandSchema,
  type PublicBrand,
} from "@okouai/api-contracts/contracts/public-brand";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import {
  chatEventTerminalPredicate,
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  max,
  not,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { AUTONOMY_BUDGET_EXHAUSTED_MESSAGE } from "../../lib/error";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import {
  recordSandboxOperation,
  recordSandboxOperations,
} from "../external/sandbox-op-log";
import {
  BEFORE_DISPATCH_CANCELLED_ERROR,
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import type { InternalRunCallbackEnvelope } from "./internal-run-callback";
import {
  feishuDeliveryTargetSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import {
  deliverAgentPhoneChatAdmissionFailure,
  dispatchAgentPhoneChatDeliveryOnce,
} from "./internal-agentphone-chat-run-callback.service";
import {
  deliverSlackChatAdmissionFailure,
  dispatchSlackChatDeliveryOnce,
} from "./internal-slack-chat-run-callback.service";
import {
  clearCanonicalFeishuThinkingReaction,
  deliverFeishuChatAdmissionFailure,
  dispatchFeishuChatDeliveryOnce,
} from "./internal-feishu-chat-run-callback.service";
import {
  deliverGitHubChatAdmissionFailure,
  dispatchGitHubChatDeliveryOnce,
} from "./internal-github-chat-run-callback.service";
import {
  deliverTeamsChatAdmissionFailure,
  dispatchTeamsChatDeliveryOnce,
} from "./internal-teams-chat-run-callback.service";
import {
  deliverTelegramChatAdmissionFailure,
  dispatchTelegramChatDeliveryOnce,
} from "./internal-telegram-chat-run-callback.service";
import {
  agentphoneDeliveryTargetSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import {
  githubDeliveryTargetSchema,
  type GitHubDeliveryTarget,
} from "./github-chat-callback-payload";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import {
  clearCanonicalSlackThreadStatusIfIdle,
  refreshCanonicalSlackThreadStatus,
  type CanonicalSlackThreadStatusTarget,
} from "./canonical-slack-thread-status.service";
import { saveRunSummary, saveRunSummary$ } from "./run-summary.service";
import { dispatchConfiguredChatRunFinishedEvent$ } from "./chat-run-finished-event-dispatch.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import {
  insertAssistantEvents,
  insertAssistantEvents$,
  touchChatThreadLastMessageAt,
  type InsertAssistantEventsInput,
  visibleChatEventCondition,
} from "./chat-event-shared.service";
import { insertChatEvent } from "./chat-event.service";
import { loadWebChatIncompleteContext } from "./chat-incomplete-context.service";
import { chatThreadAdmissionBlocked } from "./chat-active-run.service";
import {
  agentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import { buildWebChatAppendSystemPrompt } from "./web-chat-session-prompt.service";
import { appendQueuedRunAssistantMarker } from "./chat-queue-marker.service";
import {
  integrationCompletionFallbackEventIdForRun,
  followupsEventIdForRun,
} from "./assistant-event-id";
import {
  failQueuedUserMessage,
  isWebChatContextType,
  loadNextUnclaimedQueuedUserMessage,
  queuedUserMessageTriggerSource,
  type QueuedUserMessageContextType,
  type QueuedUserMessageTriggerSource,
  type QueuedUserMessage,
} from "./chat-queued-event.service";
import { sendUserPushNotifications } from "./push-notifications.service";
import {
  type ChatCompletionContextMessage,
  generateChatThreadRecommendedFollowupsFromContext,
  generateChatNotificationSummary,
  loadChatThreadRecommendedFollowupContext,
  scheduleChatThreadTitleGeneration,
} from "./chat-title.service";
import { createQueueFirstAgentRun$ } from "./agent-runs-create.service";
import { shouldUsePiExecution } from "./pi-sandbox-config";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import { onRejection, settle, tapError, throwIfAbort } from "../utils";
import { resolveThreadGenerationTemplatePrompt } from "../../lib/thread-generation-template";
import { logTemplateUsage } from "../../lib/template-usage-log";
import type { GenerationTemplateIdentity } from "@okouai/core/generation-template-identity";
import { resolveChatThreadSession } from "./chat-session-continuity.service";
import { loadComputerUseHostGrantForAutoSend } from "./chat-computer-use-host.service";
import { resolveRunChatThreadModelContext } from "./chat-run-event.service";
import { releaseThreadBrowsersForRun$ } from "./browser.service";
import {
  modelProviderWriteTypeForLaunch,
  type ModelFirstPin,
} from "./model-selection.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
} from "./chat-event-type.service";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import {
  loadSlackQueuedLaunchMaterial,
  type SlackQueuedLaunchMaterial,
} from "./slack-queued-launch-context.service";
import {
  loadFeishuQueuedLaunchMaterial,
  type FeishuQueuedLaunchMaterial,
} from "./feishu-queued-launch-context.service";
import {
  loadTeamsQueuedLaunchMaterial,
  type TeamsQueuedLaunchMaterial,
} from "./teams-queued-launch-context.service";
import {
  loadGitHubQueuedLaunchMaterial,
  type GitHubQueuedLaunchMaterial,
} from "./github-queued-launch-context.service";
import {
  loadAgentPhoneQueuedLaunchMaterial,
  type AgentPhoneQueuedLaunchMaterial,
} from "./agentphone-queued-launch-context.service";
import {
  loadTelegramQueuedLaunchMaterial,
  type TelegramQueuedLaunchMaterial,
} from "./telegram-queued-launch-context.service";
import type { Tx } from "../../lib/db-types";
import {
  resolveBuiltInModelRuntimeRoute,
  type BuiltInModelRuntimeRoute,
} from "./built-in-model-runtime-route.service";
import {
  additionalVolumesForRun,
  authorizedUserPresentationTemplateIds,
  selectedUserPresentationTemplateIds,
  userPresentationTemplateVolumes,
  type PresentationTemplateVolume,
} from "./presentation-template-data.service";
import { OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE } from "./official-workflow-run.service";

const log = logger("callback:chat");
const PG_FOREIGN_KEY_VIOLATION = "23503";
const RECENT_CHAT_RUN_LIMIT = 10;
const PRIOR_MESSAGE_CHAR_CAP = 4000;
type ChatCallbackPreCreateTimingSpanKind = "top_level" | "nested";

type ChatCallbackPreCreateTimingActionType =
  | "api_dispatch_pre_create_agent_chat_callback_load_terminal"
  | "api_dispatch_pre_create_agent_chat_callback_prepare_completed"
  | "api_dispatch_pre_create_agent_chat_callback_prepare_failed"
  | "api_dispatch_pre_create_agent_chat_callback_load_db_output_state"
  | "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items"
  | "api_dispatch_pre_create_agent_chat_callback_insert_lifecycle_marker"
  | "api_dispatch_pre_create_agent_chat_callback_load_followup_context"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_load_thread"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_lookup_queued_message"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_load_agent"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_build_input"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_model_pin"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_load_session_state"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_build_prior_context"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_computer_use_host"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_template_context"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_build_prompt"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_attachments"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_check_active_run"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_queue_age"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_create_run"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_append_marker"
  | "api_dispatch_pre_create_agent_chat_callback_auto_send_publish_signals";

interface ChatCallbackPreCreateTimingRecord {
  readonly actionType: ChatCallbackPreCreateTimingActionType;
  readonly spanKind: ChatCallbackPreCreateTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
}

export class ChatCallbackPreCreateTimingCollector {
  private readonly records: ChatCallbackPreCreateTimingRecord[] = [];
  private flushed = false;

  recordElapsed(args: {
    readonly actionType: ChatCallbackPreCreateTimingActionType;
    readonly spanKind: ChatCallbackPreCreateTimingSpanKind;
    readonly startedAt: number;
    readonly finishedAt?: number;
  }): void {
    if (this.flushed) {
      return;
    }
    const finishedAt = args.finishedAt ?? now();
    this.records.push({
      actionType: args.actionType,
      spanKind: args.spanKind,
      durationMs: Math.max(0, finishedAt - args.startedAt),
      timestamp: new Date(finishedAt).toISOString(),
    });
  }

  async measure<T>(
    actionType: ChatCallbackPreCreateTimingActionType,
    spanKind: ChatCallbackPreCreateTimingSpanKind,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    const result = await onRejection(
      (async () => {
        return await operation();
      })(),
      () => {
        this.recordElapsed({ actionType, spanKind, startedAt });
      },
    );
    this.recordElapsed({ actionType, spanKind, startedAt });
    return result;
  }

  flush(
    runId: string,
    triggerSource: QueuedUserMessageTriggerSource = "web",
  ): void {
    if (this.flushed) {
      return;
    }
    this.flushed = true;
    const records = this.records.splice(0);
    recordSandboxOperations(
      records.map((record) => {
        return {
          sandboxType: "runner",
          actionType: record.actionType,
          durationMs: record.durationMs,
          success: true,
          runId,
          timestamp: record.timestamp,
          dimensions: {
            span_kind: record.spanKind,
            trigger_source: triggerSource,
            agent_run_origin: "direct",
            agent_run_pre_create_source: "chat_callback_auto_send",
          },
        };
      }),
    );
  }
}

function flushChatCallbackTimingOnRejection(args: {
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly getRunId: () => string | null;
  readonly triggerSource: QueuedUserMessageTriggerSource;
}): (error: unknown) => void {
  return () => {
    const runId = args.getRunId();
    if (runId !== null) {
      args.timing.flush(runId, args.triggerSource);
    }
  };
}

async function measureChatCallbackPreCreateTiming<T>(
  timing: ChatCallbackPreCreateTimingCollector | undefined,
  actionType: ChatCallbackPreCreateTimingActionType,
  spanKind: ChatCallbackPreCreateTimingSpanKind,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!timing) {
    return await operation();
  }
  return await timing.measure(actionType, spanKind, operation);
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  return typeof value.code === "string" ? value.code : undefined;
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    errorCode(error) === PG_FOREIGN_KEY_VIOLATION ||
    (error instanceof Error &&
      errorCode(error.cause) === PG_FOREIGN_KEY_VIOLATION)
  );
}

const chatCallbackPayloadSchema = z
  .object({
    threadId: z.string(),
    agentId: z.string(),
    // Missing is the permanent VM0 presentation contract for callbacks
    // persisted before branding and for current unbranded run producers.
    publicBrand: publicBrandSchema.optional(),
    slackDelivery: z
      .object({
        channelId: z.string(),
        threadTs: z.string(),
        routeThreadTs: z.string().optional(),
      })
      .optional(),
    feishuDelivery: feishuDeliveryTargetSchema.optional(),
    teamsDelivery: teamsDeliveryTargetSchema.optional(),
    telegramDelivery: telegramDeliveryTargetSchema.optional(),
    agentphoneDelivery: agentphoneDeliveryTargetSchema.optional(),
    githubDelivery: githubDeliveryTargetSchema.optional(),
  })
  .passthrough();

type ChatCallbackPayload = z.infer<typeof chatCallbackPayloadSchema>;

interface AssistantEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

interface AssistantEventInsertArgs {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly items: readonly AssistantEventItem[];
}

function assistantEventInsertInput(
  args: AssistantEventInsertArgs,
): InsertAssistantEventsInput {
  return {
    ...args,
    items: args.items.map((item) => {
      return {
        eventType: "output.message",
        runEventSequenceNumber: item.sequenceNumber,
        content: item.content,
        runEventId: `callback:${item.sequenceNumber}`,
      };
    }),
  };
}

function terminalCallbackErrorMessage(
  callbackError: string | null | undefined,
  runError: string | null | undefined,
): string {
  if (callbackError !== null && callbackError !== undefined) {
    return callbackError;
  }
  if (runError !== null && runError !== undefined) {
    return runError;
  }
  return "Run failed";
}

interface ResultEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

interface DbCompletedChatOutput {
  readonly latestAssistant: AssistantEventItem | null;
  readonly resultFallback: ResultEventItem | null;
}

interface CompletedChatOutputLoad {
  readonly assistantItemsToInsert: readonly AssistantEventItem[];
  readonly latestAssistant: AssistantEventItem | null;
  readonly resultFallback: ResultEventItem | null;
}

interface PriorRunEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly userMessage: ChatEventUserMessage | null;
}

interface PriorRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly events: readonly PriorRunEvent[];
}

interface AgentForAutoSend {
  readonly id: string;
  readonly orgId: string;
}

type CreatedQueuedRun = {
  readonly runId: string;
  readonly status: "queued" | "pending" | "running";
  readonly claimedEventCreatedAt: Date;
};

type CreateQueuedRun = (
  input: CreateQueuedChatRunInput,
  admissionTime: number,
  signal: AbortSignal,
) => Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null>;

interface ChatCallbackDependencies {
  readonly releaseBrowsersForRun: (
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ) => Promise<{ readonly released: number }>;
  readonly insertAssistantItems: (
    args: AssistantEventInsertArgs,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly saveRunSummary: (
    runId: string,
    prompt: string,
    resultText: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchChatRunFinishedAutomations: (
    event: ChatRunFinishedEvent,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly formatRunError: (
    args: {
      readonly chatThreadId: string;
      readonly runId: string;
      readonly errorMessage: string;
    },
    signal: AbortSignal,
  ) => Promise<string>;
  readonly dispatchSlackDelivery: (
    callbackId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly clearSlackThreadStatusIfIdle: (
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly refreshSlackThreadStatus: (
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly formatIntegrationRunError: (
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly code: string;
      readonly message: string;
    },
    signal: AbortSignal,
  ) => Promise<string>;
  readonly deliverSlackAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly routeThreadTs?: string;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchFeishuDelivery: (
    callbackId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverFeishuAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly target: FeishuDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly clearFeishuThinkingReaction: (
    target: FeishuDeliveryTarget,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchTeamsDelivery: (
    callbackId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverTeamsAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: TeamsDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchTelegramDelivery: (
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverTelegramAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: TelegramDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchAgentPhoneDelivery: (
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverAgentPhoneAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: AgentPhoneDeliveryTarget;
      readonly chatEventId: string;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchGitHubDelivery: (
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverGitHubAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: GitHubDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly createQueuedRun?: CreateQueuedRun;
  readonly drainThreadQueue?: (
    chatThreadId: string,
    signal: AbortSignal,
    timing: ChatCallbackPreCreateTimingCollector | undefined,
  ) => Promise<void>;
}

interface ChatThreadForRunRow {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly title: string | null;
}

interface ChatRunInfo {
  readonly prompt: string;
  readonly error: string | null;
  readonly failureReason: RunFailureReasonToken | null;
  readonly lastEventSequence: number | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

interface CreateQueuedChatRunInput {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  /**
   * Guidance packages to mount for this run, one per uploaded template the
   * queued message selected and its sender may still access.
   */
  readonly presentationTemplateVolumes: readonly PresentationTemplateVolume[];
  /**
   * The selections behind that guidance, reported once the run is created.
   * Building this input does not commit to a run: admission is re-checked
   * afterwards and can leave the message queued for a later attempt, which
   * would report the same message twice.
   */
  readonly generationTemplateIdentities: readonly GenerationTemplateIdentity[];
  readonly publicBrand?: PublicBrand;
  readonly threadId: string;
  readonly connectorSourceId?: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
  readonly cliAgentType: string | null;
  readonly piExecution: boolean;
  readonly codexServiceTier: "fast" | undefined;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly computerUseHostGrant: {
    readonly hostId: string;
    readonly displayName: string;
  } | null;
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly realAgentInPreview?: boolean;
  readonly slackDelivery?: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly autonomyBudget: number;
  readonly userInfoExtras?: {
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
  };
}

interface SlackQueuedMessageAdmissionFailure {
  readonly kind: "slack_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly slackDelivery: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly error: QueuedMessageModelRouteError;
}

interface WebQueuedMessageAdmissionFailure {
  readonly kind: "web_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly error: QueuedMessageModelRouteError;
}

interface FeishuQueuedMessageAdmissionFailure {
  readonly kind: "feishu_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly feishuDelivery: FeishuDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface TeamsQueuedMessageAdmissionFailure {
  readonly kind: "teams_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly teamsDelivery: TeamsDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface TelegramQueuedMessageAdmissionFailure {
  readonly kind: "telegram_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly telegramDelivery: TelegramDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface AgentPhoneQueuedMessageAdmissionFailure {
  readonly kind: "agentphone_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly agentphoneDelivery: AgentPhoneDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface GitHubQueuedMessageAdmissionFailure {
  readonly kind: "github_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly publicBrand: PublicBrand;
  readonly githubDelivery: GitHubDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

type QueuedMessageAdmissionFailure =
  | WebQueuedMessageAdmissionFailure
  | SlackQueuedMessageAdmissionFailure
  | FeishuQueuedMessageAdmissionFailure
  | TeamsQueuedMessageAdmissionFailure
  | TelegramQueuedMessageAdmissionFailure
  | AgentPhoneQueuedMessageAdmissionFailure
  | GitHubQueuedMessageAdmissionFailure;

type CompletedChatCallbackResult =
  | {
      readonly inserted: true;
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
      readonly teamsDeliveryCallbackId?: string;
      readonly telegramDeliveryCallbackId?: string;
      readonly agentphoneDeliveryCallbackId?: string;
      readonly githubDeliveryCallbackId?: string;
    }
  | { readonly inserted: false };

type FailedChatCallbackResult =
  | {
      readonly inserted: true;
      readonly displayErrorMessage: string;
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
      readonly teamsDeliveryCallbackId?: string;
      readonly telegramDeliveryCallbackId?: string;
      readonly agentphoneDeliveryCallbackId?: string;
      readonly githubDeliveryCallbackId?: string;
    }
  | { readonly inserted: false };

interface TerminalChatCallbackWork {
  readonly shouldDrainThreadQueue: boolean;
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
  readonly githubDeliveryCallbackId?: string;
  readonly deferredSideEffects?: () => Promise<void>;
}

type DrainOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

function isCreatedQueuedRunStatus(
  status: string,
): status is CreatedQueuedRun["status"] {
  return status === "queued" || status === "pending" || status === "running";
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function requiredQueuedFeishuPublicBrand(
  input: Pick<CreateQueuedChatRunInput, "publicBrand" | "feishuDelivery">,
): PublicBrand {
  if (!input.feishuDelivery || !input.publicBrand) {
    throw new Error("Queued Feishu delivery is missing its public brand");
  }
  return input.publicBrand;
}

function buildQueuedCreateAgentRunArgs(
  input: CreateQueuedChatRunInput,
  admissionTime: number,
  dispatchFailedCallbacks?: DispatchFailedRunCallbacks,
) {
  return {
    auth: {
      tokenType: "session" as const,
      userId: input.userId,
      orgId: input.orgId,
      orgRole: "member" as const,
    },
    // Startup metrics begin when the queued message is admitted for dispatch.
    // The time spent waiting in the chat queue is recorded separately.
    apiStartTime: admissionTime,
    chatThreadId: input.threadId,
    ...(input.connectorSourceId
      ? { connectorSourceId: input.connectorSourceId }
      : {}),
    computerUseHostId: input.computerUseHostGrant?.hostId,
    modelProviderId: input.modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      input.modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: input.modelPin.selectedModel ?? undefined,
    codexServiceTier: input.codexServiceTier,
    reasoningEffort: input.reasoningEffort,
    callbacks: [
      {
        internalKind: "chat" as const,
        secret: generateCallbackSecret(),
        payload: {
          threadId: input.threadId,
          agentId: input.agentId,
          publicBrand: input.publicBrand ?? "vm0",
          queuedMessageId: input.queuedMessage.id,
          slackDelivery: input.slackDelivery,
          feishuDelivery: input.feishuDelivery,
          teamsDelivery: input.teamsDelivery,
          telegramDelivery: input.telegramDelivery,
          agentphoneDelivery: input.agentphoneDelivery,
          githubDelivery: input.githubDelivery,
        },
      },
      ...(input.feishuDelivery
        ? [
            {
              internalKind: "feishu:org" as const,
              secret: generateCallbackSecret(),
              payload: {
                installationId: input.feishuDelivery.installationId,
                chatId: input.feishuDelivery.chatId,
                messageId: input.feishuDelivery.messageId,
                connectionId: input.feishuDelivery.connectionId,
                sessionKey: input.feishuDelivery.threadId,
                agentId: input.agentId,
                reactionId: input.feishuDelivery.reactionId,
                replyInThread: input.feishuDelivery.replyInThread,
                files: input.feishuDelivery.files,
                canonicalChatDelivery: true,
                publicBrand: requiredQueuedFeishuPublicBrand(input),
              },
            },
          ]
        : []),
    ],
    triggerSource: input.triggerSource,
    agentRunPreCreateSource: "chat_callback_auto_send" as const,
    appendSystemPrompt: input.appendSystemPrompt,
    userInfoExtras: input.userInfoExtras,
    dispatchFailedCallbacks,
    queueFirstAssociation: {
      kind: "user_message" as const,
      threadId: input.threadId,
      eventId: input.queuedMessage.id,
      admissionTime,
    },
    agentRunModelPin: {
      modelProvider: input.effectiveModelProvider ?? null,
      modelProviderId: input.modelPin.modelProviderId,
      modelProviderCredentialScope: input.modelPin.modelProviderCredentialScope,
      selectedModel: input.modelPin.selectedModel,
    },
    piExecution: input.piExecution,
    agentRunMetadata: { autonomyBudget: input.autonomyBudget },
    ...(input.requiredOfficialWorkflowIds === undefined
      ? {}
      : {
          requiredOfficialWorkflowIds: input.requiredOfficialWorkflowIds,
        }),
    ...(input.builtInModelRuntimeRoute
      ? { builtInModelRuntimeRoute: input.builtInModelRuntimeRoute }
      : {}),
    threadSessionRoute: {
      selectedModel: input.modelPin.selectedModel,
      cliAgentType: input.cliAgentType,
    },
    body: {
      prompt: input.prompt,
      agentId: input.agentId,
      ...(input.effectiveModelProvider
        ? {
            modelProvider: modelProviderWriteTypeForLaunch(
              input.effectiveModelProvider,
            ),
          }
        : {}),
      ...(input.realAgentInPreview ? { realAgentInPreview: true } : {}),
      ...additionalVolumesForRun(input.presentationTemplateVolumes),
    },
  };
}

async function latestEventBackedAssistantEvent(
  db: Db,
  runId: string,
  options: { readonly maxSequenceNumber?: number } = {},
): Promise<AssistantEventItem | null> {
  const [event] = await db
    .select({
      content: canonicalChatEventContent(),
      sequenceNumber: chatEvents.runEventSequenceNumber,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatEvents.runEventSequenceNumber),
        isNotNull(canonicalChatEventContent()),
        not(sql`${canonicalChatEventContent()} ~ '^[[:space:]]*$'`),
        ...(options.maxSequenceNumber === undefined
          ? []
          : [
              lte(chatEvents.runEventSequenceNumber, options.maxSequenceNumber),
            ]),
      ),
    )
    .orderBy(desc(chatEvents.runEventSequenceNumber))
    .limit(1);

  if (!event || event.content === null || event.sequenceNumber === null) {
    return null;
  }
  return {
    content: event.content,
    sequenceNumber: event.sequenceNumber,
  };
}

async function loadDbCompletedChatOutput(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
}): Promise<DbCompletedChatOutput> {
  if (args.lastEventSequence === null) {
    return {
      latestAssistant: null,
      resultFallback: null,
    };
  }

  const [state] = await args.db
    .select({
      latestResultSequence: runOutputMaterializations.latestResultSequence,
      latestResultText: runOutputMaterializations.latestResultText,
    })
    .from(runOutputMaterializations)
    .where(eq(runOutputMaterializations.runId, args.runId))
    .limit(1);

  const latestAssistant = await latestEventBackedAssistantEvent(
    args.db,
    args.runId,
    { maxSequenceNumber: args.lastEventSequence },
  );
  const resultFallback =
    state?.latestResultSequence !== null &&
    state?.latestResultSequence !== undefined &&
    state.latestResultSequence <= args.lastEventSequence &&
    state.latestResultText !== null
      ? {
          sequenceNumber: state.latestResultSequence,
          content: visiblePiMemoryCitationText(state.latestResultText),
        }
      : null;
  return {
    latestAssistant,
    resultFallback,
  };
}

async function loadCompletedChatOutput(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly lastEventSequence: number | null;
    readonly timing: ChatCallbackPreCreateTimingCollector;
  },
  signal: AbortSignal,
): Promise<CompletedChatOutputLoad> {
  const dbOutput = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_load_db_output_state",
    "nested",
    () => {
      return loadDbCompletedChatOutput({
        db: args.db,
        runId: args.runId,
        lastEventSequence: args.lastEventSequence,
      });
    },
  );
  signal.throwIfAborted();

  return {
    assistantItemsToInsert: [],
    latestAssistant: dbOutput.latestAssistant,
    resultFallback: dbOutput.resultFallback,
  };
}

async function recordLastEventToComplete(db: Db, runId: string): Promise<void> {
  const [run] = await db
    .select({ completedAt: agentRuns.completedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run?.completedAt) {
    return;
  }

  const [event] = await db
    .select({
      lastEventAt: max(chatEvents.createdAt).mapWith(
        nullableDriverValueDecoder(chatEvents.createdAt),
      ),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatEvents.runEventSequenceNumber),
      ),
    );
  if (!event?.lastEventAt) {
    return;
  }

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "last_event_to_complete",
    durationMs: Math.max(
      0,
      run.completedAt.getTime() - event.lastEventAt.getTime(),
    ),
    success: true,
    runId,
  });
}

interface SlackDeliveryTarget {
  readonly channelId: string;
  readonly threadTs: string;
  readonly routeThreadTs?: string;
}

async function insertSlackChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: SlackDeliveryTarget;
  readonly chatEventId: string;
  readonly publicBrand: PublicBrand;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical Slack run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "slack:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
        publicBrand: args.publicBrand,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Slack delivery callback");
  }
  return callback.id;
}

async function insertFeishuChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: FeishuDeliveryTarget;
  readonly chatEventId: string;
  readonly publicBrand: PublicBrand;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical Feishu run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "feishu:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
        publicBrand: args.publicBrand,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Feishu delivery callback");
  }
  return callback.id;
}

async function insertTeamsChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: TeamsDeliveryTarget;
  readonly chatEventId: string;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical Teams run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "teams:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Teams delivery callback");
  }
  return callback.id;
}

async function insertTelegramChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: TelegramDeliveryTarget;
  readonly chatEventId: string;
  readonly publicBrand: PublicBrand;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical Telegram run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "telegram:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
        publicBrand: args.publicBrand,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Telegram delivery callback");
  }
  return callback.id;
}

async function insertAgentPhoneChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: AgentPhoneDeliveryTarget;
  readonly chatEventId: string;
  readonly publicBrand: PublicBrand;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical AgentPhone run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "agentphone:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
        publicBrand: args.publicBrand,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical AgentPhone delivery callback");
  }
  return callback.id;
}

async function insertGitHubChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: GitHubDeliveryTarget;
  readonly chatEventId: string;
  readonly publicBrand: PublicBrand;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical GitHub run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "github:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
        publicBrand: args.publicBrand,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical GitHub delivery callback");
  }
  return callback.id;
}

async function publishAssistantErrorEventSignals(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly lifecycleEvent: "failed" | "cancelled";
  readonly hasCancellationRecoveryState: boolean;
}): Promise<void> {
  await publishChatThreadMessageCreatedSafely({
    userId: args.userId,
    orgId: args.orgId,
    threadId: args.threadId,
  });
  await publishThreadListChangedSafely({
    userId: args.userId,
    orgId: args.orgId,
  });
  if (
    args.lifecycleEvent === "cancelled" &&
    args.hasCancellationRecoveryState
  ) {
    await publishChatThreadDetailChangedSafely(args.userId, args.threadId);
  }
}

async function insertAssistantErrorEvent(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly lifecycleEvent: "failed" | "cancelled";
  readonly failureReason: RunFailureReasonToken | null;
  readonly hasCancellationRecoveryState: boolean;
  readonly getFormattedError: () => Promise<string>;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
  readonly publicBrand: PublicBrand;
}): Promise<FailedChatCallbackResult> {
  const displayErrorMessage = await args.getFormattedError();
  const goalId = await historicalRunGroupId(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    const event = await insertChatEvent(
      tx,
      {
        chatThreadId: args.threadId,
        eventType:
          args.lifecycleEvent === "failed" ? "run.failed" : "run.cancelled",
        content: displayErrorMessage,
        runId: args.runId,
        runGroupId: goalId,
        error: displayErrorMessage,
        ...(args.lifecycleEvent === "failed" && args.failureReason !== null
          ? { failureReason: args.failureReason }
          : {}),
      },
      "run-lifecycle",
    );
    if (!event) {
      return null;
    }
    const slackDeliveryCallbackId = args.slackDelivery
      ? await insertSlackChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.slackDelivery,
          chatEventId: event.id,
          publicBrand: args.publicBrand,
        })
      : undefined;
    const feishuDeliveryCallbackId = args.feishuDelivery
      ? await insertFeishuChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.feishuDelivery,
          chatEventId: event.id,
          publicBrand: args.publicBrand,
        })
      : undefined;
    const teamsDeliveryCallbackId = args.teamsDelivery
      ? await insertTeamsChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.teamsDelivery,
          chatEventId: event.id,
        })
      : undefined;
    const telegramDeliveryCallbackId = args.telegramDelivery
      ? await insertTelegramChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.telegramDelivery,
          chatEventId: event.id,
          publicBrand: args.publicBrand,
        })
      : undefined;
    const agentphoneDeliveryCallbackId = args.agentphoneDelivery
      ? await insertAgentPhoneChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.agentphoneDelivery,
          chatEventId: event.id,
          publicBrand: args.publicBrand,
        })
      : undefined;
    const githubDeliveryCallbackId = args.githubDelivery
      ? await insertGitHubChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.githubDelivery,
          chatEventId: event.id,
          publicBrand: args.publicBrand,
        })
      : undefined;
    await touchChatThreadLastMessageAt(tx, args.threadId, event.createdAt);
    return {
      slackDeliveryCallbackId,
      feishuDeliveryCallbackId,
      teamsDeliveryCallbackId,
      telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId,
      githubDeliveryCallbackId,
    };
  });
  if (!inserted) {
    return { inserted: false };
  }

  await publishAssistantErrorEventSignals(args);
  return {
    displayErrorMessage,
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: inserted.githubDeliveryCallbackId,
  };
}

type ChatCallbackTransaction = Tx;

interface CanonicalDeliveryEvent {
  readonly id: string;
}

async function teamsRunLifecycleMarkerExists(
  db: ChatCallbackTransaction,
  runId: string,
): Promise<boolean> {
  const [marker] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .limit(1);
  return marker !== undefined;
}

async function loadCanonicalDeliveryEvent(
  db: ChatCallbackTransaction,
  runId: string,
  enabled: boolean,
): Promise<CanonicalDeliveryEvent | undefined> {
  if (!enabled) {
    return undefined;
  }
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(canonicalChatEventContent()),
        isNotNull(chatEvents.runEventSequenceNumber),
      ),
    )
    .orderBy(desc(chatEvents.runEventSequenceNumber))
    .limit(1);
  return event;
}

async function insertIntegrationCompletionFallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly threadId: string;
  readonly goalId: string | null | undefined;
  readonly createdAt: Date;
}): Promise<CanonicalDeliveryEvent> {
  const eventId = integrationCompletionFallbackEventIdForRun(args.runId);
  const inserted = await insertChatEvent(
    args.db,
    {
      id: eventId,
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: "Task completed successfully.",
      runId: args.runId,
      runGroupId: args.goalId,
      createdAt: args.createdAt,
    },
    "id",
  );
  if (inserted) {
    return { id: inserted.id };
  }
  const [existing] = await args.db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  if (!existing) {
    throw new Error("Failed to persist integration completion fallback");
  }
  return existing;
}

interface RunLifecycleMarkerArgs {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly event: "completed" | "cancelled";
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
  readonly publicBrand: PublicBrand;
}

interface RunLifecycleDeliveryCallbacks {
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
  readonly githubDeliveryCallbackId?: string;
}

function hasCanonicalIntegrationDelivery(
  args: RunLifecycleMarkerArgs,
): boolean {
  return Boolean(
    args.slackDelivery ||
    args.feishuDelivery ||
    args.teamsDelivery ||
    args.telegramDelivery ||
    args.agentphoneDelivery ||
    args.githubDelivery,
  );
}

function requiresIntegrationCompletionFallback(
  args: RunLifecycleMarkerArgs,
): boolean {
  return (
    args.event === "completed" &&
    Boolean(
      args.teamsDelivery ||
      args.telegramDelivery ||
      args.agentphoneDelivery ||
      args.githubDelivery,
    )
  );
}

async function insertRunLifecycleMarkerTransaction(args: {
  readonly tx: ChatCallbackTransaction;
  readonly input: RunLifecycleMarkerArgs;
  readonly markerCreatedAt: Date;
  readonly goalId: string | undefined;
}): Promise<RunLifecycleDeliveryCallbacks | null> {
  const { input } = args;
  if (
    input.teamsDelivery &&
    (await teamsRunLifecycleMarkerExists(args.tx, input.runId))
  ) {
    return null;
  }
  let deliveryEvent = await loadCanonicalDeliveryEvent(
    args.tx,
    input.runId,
    hasCanonicalIntegrationDelivery(input),
  );
  if (!deliveryEvent && requiresIntegrationCompletionFallback(input)) {
    deliveryEvent = await insertIntegrationCompletionFallback({
      db: args.tx,
      runId: input.runId,
      threadId: input.threadId,
      goalId: args.goalId,
      createdAt: args.markerCreatedAt,
    });
  }
  const marker = await insertChatEvent(
    args.tx,
    {
      chatThreadId: input.threadId,
      eventType:
        input.event === "completed" ? "run.completed" : "run.cancelled",
      content: null,
      runId: input.runId,
      runGroupId: args.goalId,
      createdAt: args.markerCreatedAt,
    },
    "run-lifecycle",
  );
  if (!marker) {
    return null;
  }
  const slackDeliveryCallbackId =
    deliveryEvent && input.slackDelivery
      ? await insertSlackChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.slackDelivery,
          chatEventId: deliveryEvent.id,
          publicBrand: input.publicBrand,
        })
      : undefined;
  const feishuDeliveryCallbackId =
    deliveryEvent && input.feishuDelivery
      ? await insertFeishuChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.feishuDelivery,
          chatEventId: deliveryEvent.id,
          publicBrand: input.publicBrand,
        })
      : undefined;
  const teamsDeliveryCallbackId =
    deliveryEvent && input.teamsDelivery
      ? await insertTeamsChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.teamsDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const telegramDeliveryCallbackId =
    deliveryEvent && input.telegramDelivery
      ? await insertTelegramChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.telegramDelivery,
          chatEventId: deliveryEvent.id,
          publicBrand: input.publicBrand,
        })
      : undefined;
  const agentphoneDeliveryCallbackId =
    deliveryEvent && input.agentphoneDelivery
      ? await insertAgentPhoneChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.agentphoneDelivery,
          chatEventId: deliveryEvent.id,
          publicBrand: input.publicBrand,
        })
      : undefined;
  const githubDeliveryCallbackId =
    deliveryEvent && input.githubDelivery
      ? await insertGitHubChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.githubDelivery,
          chatEventId: deliveryEvent.id,
          publicBrand: input.publicBrand,
        })
      : undefined;
  await touchChatThreadLastMessageAt(
    args.tx,
    input.threadId,
    args.markerCreatedAt,
  );
  return {
    slackDeliveryCallbackId,
    feishuDeliveryCallbackId,
    teamsDeliveryCallbackId,
    telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId,
  };
}

async function insertRunLifecycleMarker(
  args: RunLifecycleMarkerArgs,
): Promise<
  | { readonly inserted: false }
  | ({ readonly inserted: true } & RunLifecycleDeliveryCallbacks)
> {
  const markerCreatedAt = nowDate();
  const goalId = await historicalRunGroupId(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    return await insertRunLifecycleMarkerTransaction({
      tx,
      input: args,
      markerCreatedAt,
      goalId,
    });
  });
  if (!inserted) {
    return { inserted: false };
  }
  await publishChatThreadMessageCreatedSafely({
    userId: args.userId,
    orgId: args.orgId,
    threadId: args.threadId,
  });
  await publishThreadListChangedSafely({
    userId: args.userId,
    orgId: args.orgId,
  });
  return {
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: inserted.githubDeliveryCallbackId,
  };
}

async function insertRecommendedFollowupsEvent(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly followups: readonly ChatRecommendedFollowup[];
}): Promise<boolean> {
  const goalId = await historicalRunGroupId(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    return await insertChatEvent(
      tx,
      {
        id: followupsEventIdForRun(args.runId),
        chatThreadId: args.threadId,
        eventType: "output.followups",
        content: serializeChatFollowupsContent(args.followups),
        runId: args.runId,
        runGroupId: goalId,
      },
      "id",
    );
  });

  if (!inserted) {
    return false;
  }

  await publishChatThreadMessageCreatedSafely({
    userId: args.userId,
    orgId: args.orgId,
    threadId: args.threadId,
    syncThroughSeqId: inserted.seqId,
  });
  return true;
}

async function generateRecommendedFollowupsForCompletedRun(
  args: {
    readonly followupContext: readonly ChatCompletionContextMessage[];
    readonly threadId: string;
  },
  signal: AbortSignal,
): Promise<readonly ChatRecommendedFollowup[] | undefined> {
  signal.throwIfAborted();
  const suggestions = await generateChatThreadRecommendedFollowupsFromContext(
    {
      messages: args.followupContext,
      threadId: args.threadId,
    },
    signal,
  );
  signal.throwIfAborted();
  return suggestions.length > 0 ? suggestions : undefined;
}

async function loadRecommendedFollowupContextForCompletedRun(args: {
  readonly db: Db;
  readonly threadId: string;
}): Promise<readonly ChatCompletionContextMessage[]> {
  return (
    (await tapError(
      loadChatThreadRecommendedFollowupContext({
        db: args.db,
        threadId: args.threadId,
      }),
      (err) => {
        log.warn("Recommended follow-up context load failed", {
          threadId: args.threadId,
          err,
        });
      },
    )) ?? []
  );
}

async function materializeCompletedChatResult(
  args: {
    readonly output: CompletedChatOutputLoad;
    readonly preferResultFallback: boolean;
    readonly timing: ChatCallbackPreCreateTimingCollector;
    readonly insertAssistantItems: (
      items: readonly AssistantEventItem[],
    ) => Promise<void>;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const { assistantItemsToInsert, latestAssistant, resultFallback } =
    args.output;
  if (assistantItemsToInsert.length > 0) {
    await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
      "nested",
      () => {
        return args.insertAssistantItems(assistantItemsToInsert);
      },
    );
    signal.throwIfAborted();
  }
  let lastResultText = latestAssistant?.content ?? null;
  const latestAssistantSequence = latestAssistant?.sequenceNumber ?? null;

  const shouldInsertResultFallback =
    resultFallback !== null &&
    (lastResultText === null ||
      (args.preferResultFallback &&
        resultFallback.sequenceNumber >
          (latestAssistantSequence ?? Number.NEGATIVE_INFINITY) &&
        resultFallback.content !== lastResultText));
  if (shouldInsertResultFallback) {
    await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
      "nested",
      () => {
        return args.insertAssistantItems([resultFallback]);
      },
    );
    signal.throwIfAborted();
    lastResultText = resultFallback.content;
  }
  return lastResultText;
}

async function handleCompletedChatCallback(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly run: ChatRunInfo;
    readonly chatThread: ChatThreadForRunRow;
    readonly timing: ChatCallbackPreCreateTimingCollector;
    readonly slackDelivery?: SlackDeliveryTarget;
    readonly feishuDelivery?: FeishuDeliveryTarget;
    readonly teamsDelivery?: TeamsDeliveryTarget;
    readonly telegramDelivery?: TelegramDeliveryTarget;
    readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
    readonly githubDelivery?: GitHubDeliveryTarget;
    readonly sourceCallbackId?: string;
    readonly publicBrand: PublicBrand;
    readonly insertAssistantItems: (
      items: readonly AssistantEventItem[],
    ) => Promise<void>;
  },
  signal: AbortSignal,
): Promise<CompletedChatCallbackResult> {
  const output = await loadCompletedChatOutput(
    {
      db: args.db,
      runId: args.runId,
      lastEventSequence: args.run.lastEventSequence,
      timing: args.timing,
    },
    signal,
  );
  signal.throwIfAborted();

  const lastResultText = await materializeCompletedChatResult(
    {
      output,
      preferResultFallback:
        args.slackDelivery !== undefined ||
        args.teamsDelivery !== undefined ||
        args.telegramDelivery !== undefined ||
        args.agentphoneDelivery !== undefined ||
        args.githubDelivery !== undefined,
      timing: args.timing,
      insertAssistantItems: args.insertAssistantItems,
    },
    signal,
  );
  signal.throwIfAborted();

  waitUntil(
    tapError(recordLastEventToComplete(args.db, args.runId), (error) => {
      log.warn("Failed to record last_event_to_complete", {
        runId: args.runId,
        error,
      });
    }),
  );

  const inserted = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_insert_lifecycle_marker",
    "nested",
    () => {
      return insertRunLifecycleMarker({
        db: args.db,
        runId: args.runId,
        threadId: args.chatThread.chatThreadId,
        userId: args.chatThread.userId,
        orgId: args.chatThread.orgId,
        event: "completed",
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        teamsDelivery: args.teamsDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        githubDelivery: args.githubDelivery,
        sourceCallbackId: args.sourceCallbackId,
        publicBrand: args.publicBrand,
      });
    },
  );
  signal.throwIfAborted();
  if (!inserted.inserted) {
    return { inserted: false };
  }

  const followupContext = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_load_followup_context",
    "nested",
    () => {
      return loadRecommendedFollowupContextForCompletedRun({
        db: args.db,
        threadId: args.chatThread.chatThreadId,
      });
    },
  );
  signal.throwIfAborted();

  return {
    lastResultText,
    followupContext,
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: inserted.githubDeliveryCallbackId,
  };
}

async function runCompletedChatCallbackSideEffects(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly run: ChatRunInfo;
    readonly chatThread: ChatThreadForRunRow;
    readonly lastResultText: string | null;
    readonly followupContext: readonly ChatCompletionContextMessage[];
    readonly saveRunSummary: (resultText: string) => Promise<void>;
    readonly dispatchChatRunFinishedAutomations: ChatCallbackDependencies["dispatchChatRunFinishedAutomations"];
  },
  signal: AbortSignal,
): Promise<void> {
  // The post-processing steps are mutually independent. Run them after queued
  // auto-send so LLM/push latency does not delay the next run.
  const saveSummaryStep = args.saveRunSummary(args.lastResultText ?? "");

  const chatRunFinishedStep = args.dispatchChatRunFinishedAutomations(
    {
      chatThreadId: args.chatThread.chatThreadId,
      runId: args.runId,
      runStatus: "completed",
      lastResultText: args.lastResultText,
      sourceAgentId: args.chatThread.agentId,
      sourceThreadTitle: args.chatThread.title,
    },
    signal,
  );

  const followupsStep = (async () => {
    signal.throwIfAborted();
    const followups = await generateRecommendedFollowupsForCompletedRun(
      {
        followupContext: args.followupContext,
        threadId: args.chatThread.chatThreadId,
      },
      signal,
    );
    if (followups) {
      await insertRecommendedFollowupsEvent({
        db: args.db,
        runId: args.runId,
        threadId: args.chatThread.chatThreadId,
        userId: args.chatThread.userId,
        orgId: args.chatThread.orgId,
        followups,
      });
    }
  })();

  const pushStep = (async () => {
    let summary: string | null = null;
    if (args.lastResultText) {
      summary = await generateChatNotificationSummary(
        {
          prompt: args.run.prompt,
          resultText: args.lastResultText,
          runId: args.runId,
        },
        signal,
      );
    }

    signal.throwIfAborted();
    await sendUserPushNotifications({
      db: args.db,
      userId: args.chatThread.userId,
      notification: {
        title: args.run.prompt.slice(0, 60),
        body: summary ?? "Your task is complete",
        url: `/chats/${args.chatThread.chatThreadId}`,
      },
    });
  })();

  const results = await Promise.allSettled([
    saveSummaryStep,
    chatRunFinishedStep,
    followupsStep,
    pushStep,
  ]);
  const errors = results.flatMap((result) => {
    if (result.status === "fulfilled") {
      return [];
    }
    throwIfAbort(result.reason);
    return [result.reason];
  });
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Completed chat callback side effects failed",
    );
  }
}

async function handleFailedChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly chatThread: ChatThreadForRunRow;
  readonly errorMessage: string;
  readonly failureReason: RunFailureReasonToken | null;
  readonly hasCancellationRecoveryState: boolean;
  readonly getFormattedError: () => Promise<string>;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
  readonly publicBrand: PublicBrand;
}): Promise<FailedChatCallbackResult> {
  const lifecycleEvent =
    args.errorMessage.trim().toLowerCase() === "run cancelled"
      ? "cancelled"
      : "failed";
  return await insertAssistantErrorEvent({
    db: args.db,
    runId: args.runId,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    orgId: args.chatThread.orgId,
    lifecycleEvent,
    failureReason: args.failureReason,
    hasCancellationRecoveryState: args.hasCancellationRecoveryState,
    getFormattedError: args.getFormattedError,
    slackDelivery: args.slackDelivery,
    feishuDelivery: args.feishuDelivery,
    teamsDelivery: args.teamsDelivery,
    telegramDelivery: args.telegramDelivery,
    agentphoneDelivery: args.agentphoneDelivery,
    githubDelivery: args.githubDelivery,
    sourceCallbackId: args.sourceCallbackId,
    publicBrand: args.publicBrand,
  });
}

async function runFailedChatCallbackSideEffects(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly run: ChatRunInfo;
    readonly chatThread: ChatThreadForRunRow;
    readonly displayErrorMessage: string;
    readonly runStatus: "failed" | "cancelled";
    readonly dispatchChatRunFinishedAutomations: ChatCallbackDependencies["dispatchChatRunFinishedAutomations"];
  },
  signal: AbortSignal,
): Promise<void> {
  const chatRunFinishedStep = args.dispatchChatRunFinishedAutomations(
    {
      chatThreadId: args.chatThread.chatThreadId,
      runId: args.runId,
      runStatus: args.runStatus,
      // Failed runs surface their error separately; patterns only ever match
      // assistant output, so terminal errors dispatch with no matchable text.
      lastResultText: null,
      sourceAgentId: args.chatThread.agentId,
      sourceThreadTitle: args.chatThread.title,
    },
    signal,
  );

  await chatRunFinishedStep;
  await sendUserPushNotifications({
    db: args.db,
    userId: args.chatThread.userId,
    notification: {
      title: args.run.prompt.slice(0, 60),
      body: `Task failed: ${args.displayErrorMessage.slice(0, 80)}`,
      url: `/chats/${args.chatThread.chatThreadId}`,
    },
  });
}

async function runTerminalChatCallbackSideEffects(args: {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly run: () => Promise<void>;
}): Promise<void> {
  await tapError(args.run(), (error) => {
    log.warn("Failed to process terminal chat callback side effects", {
      runId: args.runId,
      status: args.status,
      error,
    });
  });
}

function buildAppendSystemPrompt(
  integrationPrompt: string,
  incompleteContext: string,
  priorContext: string,
  generationTemplatePrompt: string,
  computerUseHostDisplayName: string | null,
): string {
  return [
    integrationPrompt,
    priorContext,
    incompleteContext,
    generationTemplatePrompt,
    computerUseHostDisplayName
      ? buildComputerUseSystemPrompt(computerUseHostDisplayName)
      : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function buildComputerUseSystemPrompt(displayName: string): string {
  return [
    "# Computer Use",
    `Computer Use is enabled for this run on ${displayName}.`,
    "Use Okou CLI computer-use commands to inspect apps, read app state, and perform desktop actions.",
    "The computer may go offline while this run is active. If a command reports that the computer is unavailable or offline, ask the user to reconnect Okou Computer Use on that computer, then retry.",
  ].join("\n");
}

function truncatePrior(value: string): string {
  if (value.length <= PRIOR_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, PRIOR_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatPriorRunEvent(event: PriorRunEvent): string {
  const roleLabel = event.role === "user" ? "User" : "Assistant";
  const userMessage = requiredUserMessageForEvent(
    event.eventType,
    event.userMessage,
  );
  if (userMessage) {
    const prompt = projectUserMessage(userMessage).agentPrompt;
    return `${roleLabel}: ${truncatePrior(prompt) || "[empty message]"}`;
  }
  return `${roleLabel}: ${
    event.content === null
      ? "[empty message]"
      : truncatePrior(event.content) || "[empty message]"
  }`;
}

function priorRunsContextLabel(
  contextType: QueuedUserMessageContextType,
): string {
  switch (contextType) {
    case "slack": {
      return "Slack";
    }
    case "feishu": {
      return "Feishu";
    }
    case "teams": {
      return "Microsoft Teams";
    }
    case "telegram": {
      return "Telegram";
    }
    case "github": {
      return "GitHub";
    }
    case "web":
    case "agent_run":
    case "agentphone": {
      return "Web Chat";
    }
    case "automation":
    case "goal": {
      return unreachableQueuedMessageContext(contextType);
    }
    default: {
      return unreachableQueuedContextType(contextType);
    }
  }
}

function buildChatPriorRunsContext(
  runs: readonly PriorRun[],
  contextType: QueuedUserMessageContextType,
): string {
  if (runs.length === 0) {
    return "";
  }
  const sections = runs.map((run, index) => {
    const renderedEvents = run.events.map((event) => {
      return formatPriorRunEvent(event);
    });
    const transcript =
      renderedEvents.length > 0
        ? renderedEvents.join("\n\n")
        : [
            `User: ${truncatePrior(run.prompt) || "[empty message]"}`,
            "Assistant: [no visible assistant message recorded]",
          ].join("\n\n");
    return [
      `## Recent Run ${index + 1}`,
      `- RUN_ID: ${run.runId}`,
      `- RUN_STATUS: ${run.status}`,
      `- AGENT_SESSION_COMMAND: okou search "${run.runId}" --source agent-session`,
      "",
      transcript,
    ].join("\n");
  });
  return [
    `# ${priorRunsContextLabel(contextType)} Run Context`,
    "The current CLI session is fresh, so recent visible chat rounds are provided here for continuity.",
    "- Treat the newest run below as the most recent prior round.",
    "- Use the AGENT_SESSION_COMMAND for a run if you need more detailed agent session context.",
    "",
    ...sections,
  ].join("\n");
}

async function getLatestRunsByThreadId(
  db: Db,
  threadId: string,
  contextType: QueuedUserMessageContextType,
  limit: number,
): Promise<PriorRun[]> {
  const triggerSource = queuedUserMessageTriggerSource(contextType);
  const runRows = await db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, threadId),
        isWebChatContextType(contextType)
          ? inArray(agentRuns.triggerSource, ["web", "agent"])
          : eq(agentRuns.triggerSource, triggerSource),
        or(
          sql`${agentRuns.status} IS DISTINCT FROM ${"cancelled"}`,
          sql`${agentRuns.error} IS DISTINCT FROM ${BEFORE_DISPATCH_CANCELLED_ERROR}`,
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);

  const orderedRuns = runRows.reverse();
  const runIds = orderedRuns.map((run) => {
    return run.runId;
  });
  if (runIds.length === 0) {
    return [];
  }

  const eventRows = await db
    .select({
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventContent(),
      userMessage: canonicalChatEventUserMessage(),
      createdAt: chatEvents.createdAt,
      sequenceNumber: chatEvents.runEventSequenceNumber,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTextCondition(),
        inArray(chatEvents.runId, runIds),
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(asc(chatEvents.seqId));

  const eventsByRunId = new Map<string, PriorRunEvent[]>();
  for (const row of eventRows) {
    if (row.runId === null) {
      continue;
    }
    const existing = eventsByRunId.get(row.runId) ?? [];
    existing.push({
      eventType: row.eventType,
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      userMessage: row.userMessage,
    });
    eventsByRunId.set(row.runId, existing);
  }

  return orderedRuns.map((run) => {
    return {
      runId: run.runId,
      status: run.status,
      prompt: run.prompt,
      events: eventsByRunId.get(run.runId) ?? [],
    };
  });
}

async function chatThreadForRunFromDb(
  db: Db,
  runId: string,
): Promise<ChatThreadForRunRow | null> {
  const [row] = await db
    .select({
      chatThreadId: agentRuns.chatThreadId,
      userId: chatThreads.userId,
      orgId: agentRuns.orgId,
      agentId: agents.id,
      title: chatThreads.title,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(agentRuns.chatThreadId, chatThreads.id))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);

  if (!row?.chatThreadId) {
    return null;
  }
  return {
    chatThreadId: row.chatThreadId,
    userId: row.userId,
    orgId: row.orgId,
    agentId: row.agentId,
    title: row.title,
  };
}

async function loadAgentForAutoSend(
  db: Db,
  agentId: string,
): Promise<AgentForAutoSend | null> {
  const [agent] = await db
    .select({ id: agents.id, orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return agent ?? null;
}

async function chatThreadExists(db: Db, threadId: string): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return thread !== undefined;
}

async function buildQueuedPriorContext(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly startNewSession: boolean;
  readonly incompleteContext: string;
  readonly contextType: QueuedUserMessageContextType;
}): Promise<string> {
  if (!args.startNewSession || args.incompleteContext.length > 0) {
    return "";
  }
  return buildChatPriorRunsContext(
    await getLatestRunsByThreadId(
      args.db,
      args.threadId,
      args.contextType,
      RECENT_CHAT_RUN_LIMIT,
    ),
    args.contextType,
  );
}

interface QueuedMessageModelRoute {
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
  readonly cliAgentType: string | null;
  readonly codexServiceTier: "fast" | undefined;
  readonly reasoningEffort?: ReasoningEffort | null;
}

function routeQueuedMessagePiExecution(args: {
  readonly input: CreateQueuedChatRunInputArgs;
  readonly modelRoute: QueuedMessageModelRoute;
  readonly featureSwitchContext: FeatureSwitchContext;
}) {
  const triggerSource = queuedUserMessageTriggerSource(
    args.input.queuedMessage.contextType,
  );
  const piExecution = shouldUsePiExecution({
    chatThreadId: args.input.threadId,
    modelProviderType: args.modelRoute.effectiveModelProvider,
    selectedModel: args.modelRoute.modelPin.selectedModel,
    codexServiceTier: args.modelRoute.codexServiceTier,
    builtInModelRuntimeRoute: args.modelRoute.builtInModelRuntimeRoute,
    featureSwitchContext: args.featureSwitchContext,
  });
  return {
    piExecution,
    triggerSource,
    routedModel: {
      ...args.modelRoute,
      cliAgentType: piExecution
        ? ("pi" as const)
        : args.modelRoute.cliAgentType,
    },
  };
}

interface QueuedMessageModelRouteError {
  readonly code: string;
  readonly message: string;
}

type QueuedMessageModelRouteResolution =
  | { readonly route: QueuedMessageModelRoute }
  | { readonly error: QueuedMessageModelRouteError };

async function resolveQueuedMessageModelRoute(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly contextType: QueuedUserMessageContextType;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}): Promise<QueuedMessageModelRouteResolution> {
  const modelContext = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_model_pin",
    "nested",
    () => {
      return resolveRunChatThreadModelContext({
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        threadId: args.threadId,
      });
    },
  );
  if ("status" in modelContext) {
    return { error: modelContext.body.error };
  }
  if (modelContext.providerAdmission.error) {
    return { error: modelContext.providerAdmission.error.body.error };
  }
  const effectiveModelProvider =
    modelContext.providerAdmission.effectiveModelProvider;
  const selectedModel = modelContext.pin.selectedModel;
  const builtInModelRuntimeRoute =
    isBuiltInModelProviderType(effectiveModelProvider) && selectedModel
      ? await resolveBuiltInModelRuntimeRoute(args.db, selectedModel)
      : undefined;
  if (
    isBuiltInModelProviderType(effectiveModelProvider) &&
    !builtInModelRuntimeRoute
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
      modelPin: modelContext.pin,
      effectiveModelProvider,
      builtInModelRuntimeRoute: builtInModelRuntimeRoute ?? undefined,
      cliAgentType: modelContext.providerAdmission.cliAgentType,
      codexServiceTier: modelContext.runCodexServiceTier,
      reasoningEffort: modelContext.reasoningEffort,
    },
  };
}

interface CreateQueuedChatRunInputArgs {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly agent: AgentForAutoSend;
  readonly queuedMessage: QueuedUserMessage;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}

async function loadQueuedMessageSessionContext(
  args: CreateQueuedChatRunInputArgs,
  modelRoute: QueuedMessageModelRoute,
) {
  const [startNewSession, loadedIncompleteContext] =
    await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_agent_chat_callback_auto_send_load_session_state",
      "nested",
      async () => {
        const sessionResolution = await resolveChatThreadSession({
          db: args.db,
          threadId: args.threadId,
          userId: args.userId,
          orgId: args.agent.orgId,
          agentId: args.agent.id,
          route: {
            selectedModel: modelRoute.modelPin.selectedModel,
            cliAgentType: modelRoute.cliAgentType,
          },
        });
        const incompleteContext = isWebChatContextType(
          args.queuedMessage.contextType,
        )
          ? await loadWebChatIncompleteContext(args.db, args.threadId)
          : "";
        return [
          sessionResolution.action === "rotated",
          incompleteContext,
        ] as const;
      },
    );
  const incompleteContext = startNewSession ? "" : loadedIncompleteContext;
  const priorContext = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_build_prior_context",
    "nested",
    () => {
      return buildQueuedPriorContext({
        db: args.db,
        threadId: args.threadId,
        startNewSession,
        incompleteContext,
        contextType: args.queuedMessage.contextType,
      });
    },
  );
  return { incompleteContext, priorContext };
}

type QueuedIntegrationDeliveries = Pick<
  CreateQueuedChatRunInput,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
  | "githubDelivery"
>;

interface QueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly publicBrand?: PublicBrand;
  readonly connectorSourceId?: string;
  readonly delivery: QueuedIntegrationDeliveries;
  readonly userInfoExtras?: CreateQueuedChatRunInput["userInfoExtras"];
}

interface QueuedLaunchLoaderArgs {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly contextType: QueuedUserMessageContextType;
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
  readonly publicBrand: PublicBrand | null;
}

type LaunchLoader = (
  db: Db,
  args: QueuedLaunchLoaderArgs,
) => Promise<QueuedLaunchMaterial | null>;

/**
 * Web is the only trigger source with no context table: the user typed the
 * message, so `chat_events.payload.userMessage` is the durable original fact
 * rather than a display copy of something stored elsewhere. This is the one
 * place a launch loader reads it, and it is deliberate.
 */
const loadWebQueuedLaunchMaterial: LaunchLoader = (_db, args) => {
  const publicBrand = args.publicBrand ?? undefined;
  return Promise.resolve({
    prompt: args.userMessageProjection.agentPrompt,
    appendSystemPrompt: buildWebChatAppendSystemPrompt({
      threadId: args.chatThreadId,
      incompleteContext: "",
      priorContext: "",
      context: {
        generationTemplatePrompt: "",
        computerUseHostDisplayName: null,
        triggerSource: args.contextType === "agent_run" ? "agent" : "web",
        agentRunSource: args.agentRunSource,
      },
    }),
    delivery: {},
    ...(publicBrand ? { publicBrand } : {}),
  });
};

type NativeQueuedLaunchMaterial = (
  | SlackQueuedLaunchMaterial
  | FeishuQueuedLaunchMaterial
  | TeamsQueuedLaunchMaterial
  | (GitHubQueuedLaunchMaterial & { readonly userInfoExtras?: undefined })
  | AgentPhoneQueuedLaunchMaterial
  | TelegramQueuedLaunchMaterial
) & {
  readonly publicBrand?: PublicBrand;
  readonly connectorSourceId?: string;
};

function launchLoader<Material extends NativeQueuedLaunchMaterial>(
  load: (db: Db, args: QueuedLaunchLoaderArgs) => Promise<Material | null>,
  delivery: (material: Material) => QueuedIntegrationDeliveries,
): LaunchLoader {
  return async (db, args) => {
    const material = await load(db, args);
    if (!material) {
      return null;
    }
    return {
      prompt: material.prompt,
      appendSystemPrompt: material.appendSystemPrompt,
      delivery: delivery(material),
      ...(material.publicBrand ? { publicBrand: material.publicBrand } : {}),
      ...(material.userInfoExtras
        ? { userInfoExtras: material.userInfoExtras }
        : {}),
      ...(material.connectorSourceId
        ? { connectorSourceId: material.connectorSourceId }
        : {}),
    };
  };
}

async function resolveQueuedLaunchMaterial(
  args: CreateQueuedChatRunInputArgs & {
    readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
  },
): Promise<QueuedLaunchMaterial> {
  const contextType = args.queuedMessage.contextType;
  let load: LaunchLoader;
  switch (contextType) {
    case "web":
    case "agent_run": {
      load = loadWebQueuedLaunchMaterial;
      break;
    }
    case "slack": {
      load = launchLoader(loadSlackQueuedLaunchMaterial, (material) => {
        return { slackDelivery: material.slackDelivery };
      });
      break;
    }
    case "feishu": {
      load = launchLoader(loadFeishuQueuedLaunchMaterial, (material) => {
        return { feishuDelivery: material.feishuDelivery };
      });
      break;
    }
    case "teams": {
      load = launchLoader(loadTeamsQueuedLaunchMaterial, (material) => {
        return { teamsDelivery: material.teamsDelivery };
      });
      break;
    }
    case "telegram": {
      load = launchLoader(loadTelegramQueuedLaunchMaterial, (material) => {
        return { telegramDelivery: material.telegramDelivery };
      });
      break;
    }
    case "agentphone": {
      load = launchLoader(loadAgentPhoneQueuedLaunchMaterial, (material) => {
        return { agentphoneDelivery: material.agentphoneDelivery };
      });
      break;
    }
    case "github": {
      load = launchLoader(loadGitHubQueuedLaunchMaterial, (material) => {
        return { githubDelivery: material.githubDelivery };
      });
      break;
    }
    case "automation":
    case "goal": {
      return unreachableQueuedMessageContext(contextType);
    }
    default: {
      return unreachableQueuedContextType(contextType);
    }
  }
  const material = await load(args.db, {
    eventId: args.queuedMessage.id,
    chatThreadId: args.threadId,
    orgId: args.agent.orgId,
    userId: args.userId,
    contextType: args.queuedMessage.contextType,
    userMessageProjection: args.userMessageProjection,
    publicBrand: args.queuedMessage.publicBrand,
    agentRunSource: agentRunSourceAnnotation(args.queuedMessage.userMessage),
  });
  if (material) {
    return material;
  }
  throw new Error(`${contextType} queue item is missing launch material`);
}

function queuedIntegrationDeliveries(
  launchMaterial: QueuedLaunchMaterial,
): QueuedIntegrationDeliveries {
  return launchMaterial.delivery;
}

function unreachableQueuedContextType(contextType: never): never {
  throw new Error(`Unsupported queued context type: ${String(contextType)}`);
}

function unreachableQueuedMessageContext(
  contextType: Extract<QueuedUserMessageContextType, "automation" | "goal">,
): never {
  throw new Error(`${contextType} context cannot route a queued user message`);
}

function requiredQueuedDelivery<Delivery>(
  delivery: Delivery | undefined,
  contextType: QueuedUserMessageContextType,
): Delivery {
  if (!delivery) {
    throw new Error(`${contextType} queue item is missing delivery material`);
  }
  return delivery;
}

function queuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  launchMaterial: QueuedLaunchMaterial,
  error: QueuedMessageModelRouteError,
): QueuedMessageAdmissionFailure {
  const common = {
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    publicBrand: launchMaterial.publicBrand ?? "vm0",
    error,
  };
  const contextType = args.queuedMessage.contextType;
  switch (contextType) {
    case "web":
    case "agent_run": {
      return { kind: "web_admission_failure", ...common };
    }
    case "slack": {
      return {
        kind: "slack_admission_failure",
        ...common,
        slackDelivery: requiredQueuedDelivery(
          launchMaterial.delivery.slackDelivery,
          contextType,
        ),
      };
    }
    case "feishu": {
      return {
        kind: "feishu_admission_failure",
        ...common,
        feishuDelivery: requiredQueuedDelivery(
          launchMaterial.delivery.feishuDelivery,
          contextType,
        ),
      };
    }
    case "teams": {
      return {
        kind: "teams_admission_failure",
        ...common,
        teamsDelivery: requiredQueuedDelivery(
          launchMaterial.delivery.teamsDelivery,
          contextType,
        ),
      };
    }
    case "telegram": {
      return {
        kind: "telegram_admission_failure",
        ...common,
        telegramDelivery: requiredQueuedDelivery(
          launchMaterial.delivery.telegramDelivery,
          contextType,
        ),
      };
    }
    case "agentphone": {
      return {
        kind: "agentphone_admission_failure",
        ...common,
        agentphoneDelivery: requiredQueuedDelivery(
          launchMaterial.delivery.agentphoneDelivery,
          contextType,
        ),
      };
    }
    case "github": {
      return {
        kind: "github_admission_failure",
        ...common,
        githubDelivery: requiredQueuedDelivery(
          launchMaterial.delivery.githubDelivery,
          contextType,
        ),
      };
    }
    case "automation":
    case "goal": {
      return unreachableQueuedMessageContext(contextType);
    }
    default: {
      return unreachableQueuedContextType(contextType);
    }
  }
}

function officialWorkflowQueuedMessageAdmissionFailure(
  input: CreateQueuedChatRunInput,
): WebQueuedMessageAdmissionFailure {
  if (!input.requiredOfficialWorkflowIds?.length) {
    throw new Error(
      "Official Workflow queue admission conflict is missing its source claim",
    );
  }
  return {
    kind: "web_admission_failure",
    orgId: input.orgId,
    userId: input.userId,
    threadId: input.threadId,
    queuedMessage: input.queuedMessage,
    publicBrand: input.publicBrand ?? "vm0",
    error: {
      code: "CONFLICT",
      message: OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE,
    },
  };
}

function queuedMessagePrompt(args: {
  readonly launchMaterial: QueuedLaunchMaterial;
}): string {
  return args.launchMaterial.prompt;
}

function queuedIntegrationPrompt(args: {
  readonly launchMaterial: QueuedLaunchMaterial;
}): string {
  return args.launchMaterial.appendSystemPrompt;
}

function resolveQueuedMessageGenerationTemplatePrompt(args: {
  readonly input: CreateQueuedChatRunInputArgs;
  readonly userMessageProjection:
    | ReturnType<typeof projectUserMessage>
    | undefined;
  readonly introVideoEnabled: boolean;
  readonly mountedUserPresentationTemplateIds: readonly string[];
}) {
  return measureChatCallbackPreCreateTiming(
    args.input.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_template_context",
    "nested",
    () => {
      return resolveThreadGenerationTemplatePrompt({
        introVideoEnabled: args.introVideoEnabled,
        explicit: args.userMessageProjection?.primaryTemplate,
        explicitTemplates: args.userMessageProjection?.templates,
        mountedUserPresentationTemplateIds:
          args.mountedUserPresentationTemplateIds,
      });
    },
  );
}

/**
 * What a queued message's own selections contribute to the run this dispatch
 * is about to create: the guidance block and the packages that back it.
 *
 * Access is re-checked here rather than trusted from the send that queued the
 * message. The row can be deleted or made private while the message waits, and
 * a volume this user may not read must never be assembled — so the same lookup
 * decides both what is mounted and what the prompt is allowed to mention.
 */
async function resolveQueuedMessageTemplateContext(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly input: Parameters<
    typeof resolveQueuedMessageGenerationTemplatePrompt
  >[0]["input"];
  readonly userMessageProjection: Parameters<
    typeof resolveQueuedMessageGenerationTemplatePrompt
  >[0]["userMessageProjection"];
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<{
  readonly generationTemplatePrompt: string;
  readonly generationTemplateIdentities: readonly GenerationTemplateIdentity[];
  readonly presentationTemplateVolumes: readonly PresentationTemplateVolume[];
}> {
  const mountedUserPresentationTemplateIds =
    await authorizedUserPresentationTemplateIds(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      templateIds: selectedUserPresentationTemplateIds(
        args.userMessageProjection?.templates ?? [],
      ),
    });
  const generationTemplates =
    await resolveQueuedMessageGenerationTemplatePrompt({
      input: args.input,
      userMessageProjection: args.userMessageProjection,
      introVideoEnabled: loadIntroVideoTemplateAccess(
        args.userMessageProjection?.templates ?? [],
        args.featureSwitchContext,
      ),
      mountedUserPresentationTemplateIds,
    });
  return {
    generationTemplatePrompt: generationTemplates.prompt,
    generationTemplateIdentities: generationTemplates.identities,
    presentationTemplateVolumes: userPresentationTemplateVolumes(
      mountedUserPresentationTemplateIds,
    ),
  };
}

async function loadQueuedRunMaterial(
  args: CreateQueuedChatRunInputArgs & {
    readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
  },
) {
  return await resolveQueuedLaunchMaterial(args);
}

function queuedUserMessageProjection(
  message: QueuedUserMessage["userMessage"],
) {
  const queuedUserMessage = requiredUserMessageForEvent(
    "input.prompt",
    message,
  );
  if (!queuedUserMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  return projectUserMessage(queuedUserMessage);
}

function queuedIntegrationLaunchFields(launchMaterial: QueuedLaunchMaterial) {
  return {
    ...queuedIntegrationDeliveries(launchMaterial),
    userInfoExtras: launchMaterial.userInfoExtras,
    ...(launchMaterial.connectorSourceId
      ? { connectorSourceId: launchMaterial.connectorSourceId }
      : {}),
  };
}

function resolveQueuedMessageComputerUseHostGrant(
  args: CreateQueuedChatRunInputArgs,
) {
  return measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_computer_use_host",
    "nested",
    () => {
      return loadComputerUseHostGrantForAutoSend({
        db: args.db,
        threadId: args.threadId,
        orgId: args.agent.orgId,
        userId: args.userId,
      });
    },
  );
}

async function buildCreateQueuedChatRunInput(
  args: CreateQueuedChatRunInputArgs,
): Promise<CreateQueuedChatRunInput | QueuedMessageAdmissionFailure> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    args.db,
    args.agent.orgId,
    args.userId,
  );
  const modelRouteResolution = await resolveQueuedMessageModelRoute({
    db: args.db,
    threadId: args.threadId,
    userId: args.userId,
    orgId: args.agent.orgId,
    contextType: args.queuedMessage.contextType,
    timing: args.timing,
  });
  const userMessageProjection = queuedUserMessageProjection(
    args.queuedMessage.userMessage,
  );
  const launchMaterial = await loadQueuedRunMaterial({
    ...args,
    userMessageProjection,
  });
  if (args.queuedMessage.autonomyBudget.kind !== "ok") {
    return queuedMessageAdmissionFailure(args, launchMaterial, {
      code:
        args.queuedMessage.autonomyBudget.kind === "exhausted"
          ? "AUTONOMY_BUDGET_EXHAUSTED"
          : "AUTONOMY_SOURCE_UNAVAILABLE",
      message:
        args.queuedMessage.autonomyBudget.kind === "exhausted"
          ? AUTONOMY_BUDGET_EXHAUSTED_MESSAGE
          : args.queuedMessage.autonomyBudget.message,
    });
  }
  if ("error" in modelRouteResolution) {
    return queuedMessageAdmissionFailure(
      args,
      launchMaterial,
      modelRouteResolution.error,
    );
  }
  const modelRoute = modelRouteResolution.route;
  // Keep session routing and launch on the same queued-message admission.
  const { piExecution, routedModel, triggerSource } =
    routeQueuedMessagePiExecution({
      input: args,
      modelRoute,
      featureSwitchContext,
    });

  const reasoningEffort = resolveReasoningEffortForDispatch({
    selectedModel: routedModel.modelPin.selectedModel,
    effort: routedModel.reasoningEffort ?? undefined,
    runtimeProviderType:
      routedModel.builtInModelRuntimeRoute?.providerType ??
      routedModel.effectiveModelProvider,
    piExecution,
  });

  const { incompleteContext, priorContext } =
    await loadQueuedMessageSessionContext(args, routedModel);
  const {
    generationTemplatePrompt,
    generationTemplateIdentities,
    presentationTemplateVolumes,
  } = await resolveQueuedMessageTemplateContext({
    db: args.db,
    orgId: args.agent.orgId,
    userId: args.userId,
    input: args,
    userMessageProjection,
    featureSwitchContext,
  });
  const computerUseHostGrant =
    await resolveQueuedMessageComputerUseHostGrant(args);
  const prompt = queuedMessagePrompt({
    launchMaterial,
  });
  return {
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    prompt,
    appendSystemPrompt: buildAppendSystemPrompt(
      queuedIntegrationPrompt({
        launchMaterial,
      }),
      incompleteContext,
      priorContext,
      generationTemplatePrompt,
      computerUseHostGrant?.displayName ?? null,
    ),
    presentationTemplateVolumes,
    generationTemplateIdentities,
    publicBrand: launchMaterial.publicBrand,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    ...(args.queuedMessage.requiredOfficialWorkflowIds === undefined
      ? {}
      : {
          requiredOfficialWorkflowIds:
            args.queuedMessage.requiredOfficialWorkflowIds,
        }),
    modelPin: routedModel.modelPin,
    effectiveModelProvider: routedModel.effectiveModelProvider,
    builtInModelRuntimeRoute: routedModel.builtInModelRuntimeRoute,
    cliAgentType: routedModel.cliAgentType,
    piExecution,
    codexServiceTier: routedModel.codexServiceTier,
    reasoningEffort,
    computerUseHostGrant,
    triggerSource,
    realAgentInPreview: isFeatureEnabled(
      FeatureSwitchKey.RealAgentInPreview,
      featureSwitchContext,
    ),
    ...queuedIntegrationLaunchFields(launchMaterial),
    autonomyBudget: args.queuedMessage.autonomyBudget.autonomyBudget,
  };
}

async function appendAutoSentQueuedRunMarker(args: {
  readonly db: Db;
  readonly createdAfter: Date;
  readonly runId: string;
  readonly threadId: string;
}): Promise<boolean> {
  const marker = await settle(
    args.db.transaction(async (tx) => {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: args.threadId,
        runId: args.runId,
        createdAfter: args.createdAfter,
      });
    }),
  );
  if (marker.ok) {
    return true;
  }
  // The atomic launch can commit immediately before thread deletion. Keep the
  // normal marker path query-free and classify only that expected FK race.
  if (
    isForeignKeyViolation(marker.error) &&
    !(await chatThreadExists(args.db, args.threadId))
  ) {
    return false;
  }
  throw marker.error;
}

async function createAutoSentQueuedRun(args: {
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null>;
  readonly runInput: CreateQueuedChatRunInput;
  readonly timing: ChatCallbackPreCreateTimingCollector;
}): Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null> {
  return await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_create_run",
    "top_level",
    () => {
      return args.createRun(args.runInput);
    },
  );
}

async function appendAutoSentQueuedRunMarkerIfQueued(args: {
  readonly db: Db;
  readonly run: CreatedQueuedRun;
  readonly threadId: string;
  readonly timing: ChatCallbackPreCreateTimingCollector;
}): Promise<boolean> {
  if (args.run.status !== "queued") {
    return true;
  }
  return await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_append_marker",
    "nested",
    () => {
      return appendAutoSentQueuedRunMarker({
        db: args.db,
        createdAfter: args.run.claimedEventCreatedAt,
        runId: args.run.runId,
        threadId: args.threadId,
      });
    },
  );
}

async function publishAutoSentQueuedRunSignals(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly timing: ChatCallbackPreCreateTimingCollector;
}): Promise<void> {
  await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_publish_signals",
    "nested",
    async () => {
      await publishChatThreadMessageCreatedSafely({
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.threadId,
      });
      await publishThreadListChangedSafely({
        userId: args.userId,
        orgId: args.orgId,
      });
    },
  );
}

function recordQueuedMessageAdmissionFailure(
  failure: QueuedMessageAdmissionFailure,
): void {
  const fields = {
    threadId: failure.threadId,
    userMessageId: failure.queuedMessage.id,
    triggerSource: queuedUserMessageTriggerSource(
      failure.queuedMessage.contextType,
    ),
    code: failure.error.code,
  };
  if (failure.error.code === "INSUFFICIENT_CREDITS") {
    log.debug("Queued message rejected by current model admission", fields);
    return;
  }
  if (failure.error.code === "CONFLICT") {
    log.warn("Queued message rejected by permanent launch admission", {
      ...fields,
      error: failure.error.message,
    });
    return;
  }
  log.warn("Queued message rejected because the model route is unavailable", {
    ...fields,
    error: failure.error.message,
  });
}

async function publishQueuedAdmissionFailureInvalidations(
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely({
    userId: args.userId,
    orgId: args.orgId,
    threadId: args.threadId,
  });
  signal.throwIfAborted();
  await publishThreadListChangedSafely({
    userId: args.userId,
    orgId: args.orgId,
  });
  signal.throwIfAborted();
}

interface QueuedAdmissionFailureChannel {
  readonly name: string;
  readonly deliver: (chatEventId: string, signal: AbortSignal) => Promise<void>;
  readonly clearThinking?: (signal: AbortSignal) => Promise<void>;
}

interface QueuedAdmissionFailureDeliverers {
  readonly deliverSlack: ChatCallbackDependencies["deliverSlackAdmissionFailure"];
  readonly deliverFeishu: ChatCallbackDependencies["deliverFeishuAdmissionFailure"];
  readonly clearFeishuThinking: ChatCallbackDependencies["clearFeishuThinkingReaction"];
  readonly deliverTeams: ChatCallbackDependencies["deliverTeamsAdmissionFailure"];
  readonly deliverTelegram: ChatCallbackDependencies["deliverTelegramAdmissionFailure"];
  readonly deliverAgentPhone: ChatCallbackDependencies["deliverAgentPhoneAdmissionFailure"];
  readonly deliverGitHub: ChatCallbackDependencies["deliverGitHubAdmissionFailure"];
}

/**
 * Channel table for admission-failure delivery. Web admissions have no
 * integration delivery, so they resolve to `undefined`.
 */
function queuedAdmissionFailureChannel(
  args: QueuedAdmissionFailureDeliverers & {
    readonly failure: QueuedMessageAdmissionFailure;
  },
): QueuedAdmissionFailureChannel | undefined {
  const failure = args.failure;
  const base = {
    chatThreadId: failure.threadId,
    userId: failure.userId,
    orgId: failure.orgId,
  };
  switch (failure.kind) {
    case "web_admission_failure": {
      return undefined;
    }
    case "slack_admission_failure": {
      return {
        name: "Slack",
        deliver: (chatEventId, signal) => {
          return args.deliverSlack(
            {
              ...base,
              agentId: failure.agentId,
              channelId: failure.slackDelivery.channelId,
              threadTs: failure.slackDelivery.threadTs,
              ...(failure.slackDelivery.routeThreadTs
                ? { routeThreadTs: failure.slackDelivery.routeThreadTs }
                : {}),
              chatEventId,
            },
            signal,
          );
        },
      };
    }
    case "feishu_admission_failure": {
      return {
        name: "Feishu",
        deliver: (chatEventId, signal) => {
          return args.deliverFeishu(
            { ...base, target: failure.feishuDelivery, chatEventId },
            signal,
          );
        },
        clearThinking: (signal) => {
          return args.clearFeishuThinking(failure.feishuDelivery, signal);
        },
      };
    }
    case "teams_admission_failure": {
      return {
        name: "Teams",
        deliver: (chatEventId, signal) => {
          return args.deliverTeams(
            {
              ...base,
              agentId: failure.agentId,
              target: failure.teamsDelivery,
              chatEventId,
            },
            signal,
          );
        },
      };
    }
    case "telegram_admission_failure": {
      return {
        name: "Telegram",
        deliver: (chatEventId, signal) => {
          return args.deliverTelegram(
            {
              ...base,
              agentId: failure.agentId,
              target: failure.telegramDelivery,
              chatEventId,
            },
            signal,
          );
        },
      };
    }
    case "agentphone_admission_failure": {
      return {
        name: "AgentPhone",
        deliver: (chatEventId, signal) => {
          return args.deliverAgentPhone(
            {
              ...base,
              agentId: failure.agentId,
              target: failure.agentphoneDelivery,
              chatEventId,
              publicBrand: failure.publicBrand,
            },
            signal,
          );
        },
      };
    }
    case "github_admission_failure": {
      return {
        name: "GitHub",
        deliver: (chatEventId, signal) => {
          return args.deliverGitHub(
            {
              ...base,
              agentId: failure.agentId,
              target: failure.githubDelivery,
              chatEventId,
            },
            signal,
          );
        },
      };
    }
    default: {
      return unreachableQueuedAdmissionFailure(failure);
    }
  }
}

async function deliverQueuedAdmissionFailureToChannel(
  args: {
    readonly channel: QueuedAdmissionFailureChannel;
    readonly threadId: string;
    readonly chatEventId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const channel = args.channel;
  await tapError(channel.deliver(args.chatEventId, signal), (error) => {
    log.warn(`Failed to deliver canonical ${channel.name} admission error`, {
      threadId: args.threadId,
      error,
    });
  });
  const clearThinking = channel.clearThinking;
  if (!clearThinking) {
    return;
  }
  await tapError(clearThinking(signal), (error) => {
    log.warn(`Failed to clear ${channel.name} admission thinking reaction`, {
      threadId: args.threadId,
      error,
    });
  });
}

async function handleQueuedMessageAdmissionFailure(
  args: QueuedAdmissionFailureDeliverers & {
    readonly db: Db;
    readonly failure: QueuedMessageAdmissionFailure;
    readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  },
  signal: AbortSignal,
): Promise<void> {
  const channel = queuedAdmissionFailureChannel(args);
  const displayError = await args.formatError(
    {
      orgId: args.failure.orgId,
      userId: args.failure.userId,
      code: args.failure.error.code,
      message: args.failure.error.message,
    },
    signal,
  );
  signal.throwIfAborted();
  const failed = await failQueuedUserMessage(args.db, {
    threadId: args.failure.threadId,
    eventId: args.failure.queuedMessage.id,
    assistantContent: displayError,
    errorMarker: args.failure.error.code.toLowerCase(),
    currentTime: nowDate(),
  });
  signal.throwIfAborted();
  if (!failed) {
    return;
  }

  recordQueuedMessageAdmissionFailure(args.failure);
  await publishQueuedAdmissionFailureInvalidations(
    {
      userId: args.failure.userId,
      orgId: args.failure.orgId,
      threadId: args.failure.threadId,
    },
    signal,
  );
  if (!channel) {
    return;
  }
  await deliverQueuedAdmissionFailureToChannel(
    {
      channel,
      threadId: args.failure.threadId,
      chatEventId: failed.assistantEventId,
    },
    signal,
  );
}

function unreachableQueuedAdmissionFailure(failure: never): never {
  throw new Error(`Unsupported queued admission failure: ${String(failure)}`);
}

interface AutoSendQueuedMessageArgs {
  readonly admissionTime: number;
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null>;
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly queueItemCreatedBefore?: Date;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly formatIntegrationRunError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliverSlackAdmissionFailure: ChatCallbackDependencies["deliverSlackAdmissionFailure"];
  readonly deliverFeishuAdmissionFailure: ChatCallbackDependencies["deliverFeishuAdmissionFailure"];
  readonly clearFeishuThinkingReaction: ChatCallbackDependencies["clearFeishuThinkingReaction"];
  readonly deliverTeamsAdmissionFailure: ChatCallbackDependencies["deliverTeamsAdmissionFailure"];
  readonly deliverTelegramAdmissionFailure: ChatCallbackDependencies["deliverTelegramAdmissionFailure"];
  readonly deliverAgentPhoneAdmissionFailure: ChatCallbackDependencies["deliverAgentPhoneAdmissionFailure"];
  readonly deliverGitHubAdmissionFailure: ChatCallbackDependencies["deliverGitHubAdmissionFailure"];
}

async function prepareAutoSendQueuedMessageRunInput(input: {
  readonly args: AutoSendQueuedMessageArgs;
  readonly agent: AgentForAutoSend;
  readonly queuedMessage: QueuedUserMessage;
}): Promise<CreateQueuedChatRunInput | QueuedMessageAdmissionFailure> {
  const { args, agent, queuedMessage } = input;
  return await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_build_input",
    "top_level",
    () => {
      return buildCreateQueuedChatRunInput({
        db: args.db,
        threadId: args.chatThreadId,
        userId: args.userId,
        agent,
        queuedMessage,
        timing: args.timing,
      });
    },
  );
}

function chatThreadAdmissionBlockedForAutoSend(
  args: AutoSendQueuedMessageArgs,
  threadId: string,
): Promise<boolean> {
  return chatThreadAdmissionBlocked(args.db, {
    threadId,
    apiStartTime: args.admissionTime,
  });
}

function autoSendAdmissionBlocked(
  args: AutoSendQueuedMessageArgs,
  threadId: string,
): Promise<boolean> {
  return measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_check_active_run",
    "nested",
    () => {
      return chatThreadAdmissionBlockedForAutoSend(args, threadId);
    },
  );
}

function autoSendAdmissionFailureArgs(
  args: AutoSendQueuedMessageArgs,
  failure: QueuedMessageAdmissionFailure,
) {
  return {
    db: args.db,
    failure,
    formatError: args.formatIntegrationRunError,
    deliverSlack: args.deliverSlackAdmissionFailure,
    deliverFeishu: args.deliverFeishuAdmissionFailure,
    clearFeishuThinking: args.clearFeishuThinkingReaction,
    deliverTeams: args.deliverTeamsAdmissionFailure,
    deliverTelegram: args.deliverTelegramAdmissionFailure,
    deliverAgentPhone: args.deliverAgentPhoneAdmissionFailure,
    deliverGitHub: args.deliverGitHubAdmissionFailure,
  };
}

/**
 * User-message half of the per-thread scheduler: when the thread has no
 * in-flight run, dispatch the oldest queued user message — whoever sent it.
 * The shared thread scheduler calls this before attempting the automation-event
 * half, preserving user-message priority.
 */
async function autoSendQueuedMessageForThread(
  args: AutoSendQueuedMessageArgs,
  signal: AbortSignal,
): Promise<void> {
  const { chatThreadId: threadId, userId } = args;

  const queuedMessage = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_lookup_queued_message",
    "nested",
    () => {
      return loadNextUnclaimedQueuedUserMessage(
        args.db,
        threadId,
        args.queueItemCreatedBefore,
      );
    },
  );
  if (!queuedMessage) {
    return;
  }

  args.timing.recordElapsed({
    actionType:
      "api_dispatch_pre_create_agent_chat_callback_auto_send_queue_age",
    spanKind: "nested",
    startedAt: queuedMessage.createdAt.getTime(),
    finishedAt: args.admissionTime,
  });

  const agent = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_load_agent",
    "nested",
    () => {
      return loadAgentForAutoSend(args.db, args.agentId);
    },
  );
  if (!agent) {
    log.warn("Auto-send aborted: agent not found", {
      threadId,
      agentId: args.agentId,
    });
    return;
  }

  const runInput = await prepareAutoSendQueuedMessageRunInput({
    args,
    agent,
    queuedMessage,
  });
  const activeRunExists = await autoSendAdmissionBlocked(args, threadId);
  if (activeRunExists) {
    return;
  }
  if ("kind" in runInput) {
    await handleQueuedMessageAdmissionFailure(
      autoSendAdmissionFailureArgs(args, runInput),
      signal,
    );
    return;
  }

  let createdRunId: string | null = null;
  const run = await onRejection(
    (async () => {
      const createdRun = await createAutoSentQueuedRun({
        createRun: args.createRun,
        runInput,
        timing: args.timing,
      });
      if (!createdRun) {
        return null;
      }
      if ("kind" in createdRun) {
        await handleQueuedMessageAdmissionFailure(
          autoSendAdmissionFailureArgs(args, createdRun),
          signal,
        );
        return null;
      }
      createdRunId = createdRun.runId;
      const shouldPublishSignals = await appendAutoSentQueuedRunMarkerIfQueued({
        db: args.db,
        run: createdRun,
        threadId,
        timing: args.timing,
      });
      if (!shouldPublishSignals) {
        return createdRun;
      }
      await publishAutoSentQueuedRunSignals({
        threadId,
        userId,
        orgId: runInput.orgId,
        timing: args.timing,
      });
      return createdRun;
    })(),
    flushChatCallbackTimingOnRejection({
      timing: args.timing,
      triggerSource: runInput.triggerSource,
      getRunId: () => {
        return createdRunId;
      },
    }),
  );
  if (run) {
    // The run exists, which is what makes this a use. Building the input does
    // not: admission is re-checked after it and can leave the message queued
    // for a later attempt that reports the same message again.
    logTemplateUsage(
      {
        dispatchPath: "queued-claim",
        orgId: runInput.orgId,
        userId,
        chatThreadId: threadId,
      },
      runInput.generationTemplateIdentities,
    );
    // Ingress channels never touch the web send route, so this is where their
    // threads get an eager title instead of waiting for the run to finish.
    scheduleChatThreadTitleGeneration({
      db: args.db,
      threadId,
      userId,
      orgId: runInput.orgId,
      prompt: runInput.prompt,
      includePriorRounds: true,
    });
    args.timing.flush(run.runId, runInput.triggerSource);
  }
}

async function createQueuedChatRun(
  args: {
    readonly input: CreateQueuedChatRunInput;
    readonly createRun: (
      input: CreateQueuedChatRunInput,
    ) => Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null>;
  },
  signal: AbortSignal,
): Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null> {
  const created = await args.createRun(args.input);
  signal.throwIfAborted();
  return created;
}

async function loadTerminalChatCallback(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly callbackStatus: "completed" | "failed";
    readonly payloadThreadId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
} | null> {
  const [run] = await args.db
    .select({
      prompt: agentRuns.prompt,
      error: agentRuns.error,
      failureReason: agentRuns.failureReason,
      lastEventSequence: agentRuns.lastEventSequence,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return null;
  }

  const chatThread = await chatThreadForRunFromDb(args.db, args.runId);
  signal.throwIfAborted();
  if (!chatThread) {
    log.debug("Skipping terminal chat callback for missing chat thread", {
      runId: args.runId,
      status: args.callbackStatus,
      payloadThreadId: args.payloadThreadId,
    });
    return null;
  }

  if (chatThread.chatThreadId !== args.payloadThreadId) {
    log.warn("Chat callback payload thread does not match run mapping", {
      runId: args.runId,
      payloadThreadId: args.payloadThreadId,
      chatThreadId: chatThread.chatThreadId,
    });
  }

  return { run, chatThread };
}

async function prepareCompletedTerminalChatCallbackWork(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly run: ChatRunInfo;
    readonly chatThread: ChatThreadForRunRow;
    readonly dependencies: ChatCallbackDependencies;
    readonly timing: ChatCallbackPreCreateTimingCollector;
    readonly slackDelivery?: SlackDeliveryTarget;
    readonly feishuDelivery?: FeishuDeliveryTarget;
    readonly teamsDelivery?: TeamsDeliveryTarget;
    readonly telegramDelivery?: TelegramDeliveryTarget;
    readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
    readonly githubDelivery?: GitHubDeliveryTarget;
    readonly sourceCallbackId?: string;
    readonly publicBrand: PublicBrand;
  },
  signal: AbortSignal,
): Promise<TerminalChatCallbackWork> {
  const prepared = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_prepare_completed",
    "top_level",
    async () => {
      const completed = await handleCompletedChatCallback(
        {
          db: args.db,
          runId: args.runId,
          run: args.run,
          chatThread: args.chatThread,
          timing: args.timing,
          slackDelivery: args.slackDelivery,
          feishuDelivery: args.feishuDelivery,
          teamsDelivery: args.teamsDelivery,
          telegramDelivery: args.telegramDelivery,
          agentphoneDelivery: args.agentphoneDelivery,
          githubDelivery: args.githubDelivery,
          sourceCallbackId: args.sourceCallbackId,
          publicBrand: args.publicBrand,
          insertAssistantItems: async (items) => {
            await args.dependencies.insertAssistantItems(
              {
                runId: args.runId,
                threadId: args.chatThread.chatThreadId,
                userId: args.chatThread.userId,
                orgId: args.chatThread.orgId,
                items,
              },
              signal,
            );
          },
        },
        signal,
      );
      return completed;
    },
  );
  const completed = prepared;
  if (!completed.inserted) {
    return { shouldDrainThreadQueue: false };
  }

  return {
    shouldDrainThreadQueue: true,
    slackDeliveryCallbackId: completed.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: completed.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: completed.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: completed.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: completed.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: completed.githubDeliveryCallbackId,
    deferredSideEffects: () => {
      return runCompletedChatCallbackSideEffects(
        {
          db: args.db,
          runId: args.runId,
          run: args.run,
          chatThread: args.chatThread,
          lastResultText: completed.lastResultText,
          followupContext: completed.followupContext,
          saveRunSummary: (resultText) => {
            return args.dependencies.saveRunSummary(
              args.runId,
              args.run.prompt,
              resultText,
              signal,
            );
          },
          dispatchChatRunFinishedAutomations:
            args.dependencies.dispatchChatRunFinishedAutomations,
        },
        signal,
      );
    },
  };
}

async function prepareFailedTerminalChatCallbackWork(
  args: {
    readonly db: Db;
    readonly runId: string;
    readonly run: ChatRunInfo;
    readonly chatThread: ChatThreadForRunRow;
    readonly errorMessage: string;
    readonly publicBrand: PublicBrand;
    readonly dependencies: ChatCallbackDependencies;
    readonly timing: ChatCallbackPreCreateTimingCollector;
    readonly slackDelivery?: SlackDeliveryTarget;
    readonly feishuDelivery?: FeishuDeliveryTarget;
    readonly teamsDelivery?: TeamsDeliveryTarget;
    readonly telegramDelivery?: TelegramDeliveryTarget;
    readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
    readonly githubDelivery?: GitHubDeliveryTarget;
    readonly sourceCallbackId?: string;
  },
  signal: AbortSignal,
): Promise<TerminalChatCallbackWork> {
  const failed = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_agent_chat_callback_prepare_failed",
    "top_level",
    () => {
      return handleFailedChatCallback({
        db: args.db,
        runId: args.runId,
        chatThread: args.chatThread,
        errorMessage: args.errorMessage,
        failureReason: args.run.failureReason,
        hasCancellationRecoveryState:
          args.run.cancellationRecoveryCompleted !== null,
        getFormattedError: () => {
          return args.dependencies.formatRunError(
            {
              chatThreadId: args.chatThread.chatThreadId,
              runId: args.runId,
              errorMessage: args.errorMessage,
            },
            signal,
          );
        },
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        teamsDelivery: args.teamsDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        githubDelivery: args.githubDelivery,
        sourceCallbackId: args.sourceCallbackId,
        publicBrand: args.publicBrand,
      });
    },
  );
  if (!failed.inserted) {
    return { shouldDrainThreadQueue: false };
  }

  return {
    shouldDrainThreadQueue: true,
    slackDeliveryCallbackId: failed.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: failed.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: failed.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: failed.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: failed.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: failed.githubDeliveryCallbackId,
    deferredSideEffects: () => {
      return runFailedChatCallbackSideEffects(
        {
          db: args.db,
          runId: args.runId,
          run: args.run,
          chatThread: args.chatThread,
          displayErrorMessage: failed.displayErrorMessage,
          runStatus:
            args.errorMessage.trim().toLowerCase() === "run cancelled"
              ? "cancelled"
              : "failed",
          dispatchChatRunFinishedAutomations:
            args.dependencies.dispatchChatRunFinishedAutomations,
        },
        signal,
      );
    },
  };
}

async function maybeDrainThreadQueueForTerminalCallback(
  args: {
    readonly enabled: boolean;
    readonly chatThreadId: string;
    readonly dependencies: ChatCallbackDependencies;
    readonly timing: ChatCallbackPreCreateTimingCollector;
  },
  signal: AbortSignal,
): Promise<DrainOutcome> {
  if (!args.enabled || !args.dependencies.drainThreadQueue) {
    return { ok: true };
  }

  const result = await settle(
    args.dependencies.drainThreadQueue(args.chatThreadId, signal, args.timing),
    signal,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function clearSlackThreadStatusAfterTerminalCallback(
  args: {
    readonly chatThreadId: string;
    readonly slackDelivery: SlackDeliveryTarget | undefined;
    readonly dependencies: ChatCallbackDependencies;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.slackDelivery) {
    return;
  }
  await tapError(
    args.dependencies.clearSlackThreadStatusIfIdle(
      {
        chatThreadId: args.chatThreadId,
        channelId: args.slackDelivery.channelId,
        threadTs: args.slackDelivery.threadTs,
        ...(args.slackDelivery.routeThreadTs
          ? { routeThreadTs: args.slackDelivery.routeThreadTs }
          : {}),
      },
      signal,
    ),
    (error) => {
      log.warn("Failed to clear canonical Slack thread status", {
        chatThreadId: args.chatThreadId,
        error,
      });
    },
  );
  signal.throwIfAborted();
}

async function clearFeishuThinkingAfterTerminalCallback(
  args: {
    readonly feishuDelivery: FeishuDeliveryTarget | undefined;
    readonly dependencies: ChatCallbackDependencies;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.feishuDelivery) {
    return;
  }
  await tapError(
    args.dependencies.clearFeishuThinkingReaction(args.feishuDelivery, signal),
    (error) => {
      log.warn("Failed to clear canonical Feishu thinking reaction", {
        messageId: args.feishuDelivery?.messageId,
        error,
      });
    },
  );
  signal.throwIfAborted();
}

async function handleTerminalChatCallbackPreparationFailure(
  args: {
    readonly runId: string;
    readonly error: unknown;
    readonly chatThreadId: string;
    readonly slackDelivery: SlackDeliveryTarget | undefined;
    readonly feishuDelivery: FeishuDeliveryTarget | undefined;
    readonly dependencies: ChatCallbackDependencies;
    readonly timing: ChatCallbackPreCreateTimingCollector;
  },
  signal: AbortSignal,
): Promise<never> {
  const fallbackDrain = await maybeDrainThreadQueueForTerminalCallback(
    {
      enabled: true,
      chatThreadId: args.chatThreadId,
      dependencies: args.dependencies,
      timing: args.timing,
    },
    signal,
  );
  if (!fallbackDrain.ok) {
    log.error("Failed to drain thread queue after terminal callback error", {
      runId: args.runId,
      error: fallbackDrain.error,
    });
  }
  await clearSlackThreadStatusAfterTerminalCallback(
    {
      chatThreadId: args.chatThreadId,
      slackDelivery: args.slackDelivery,
      dependencies: args.dependencies,
    },
    signal,
  );
  await clearFeishuThinkingAfterTerminalCallback(
    {
      feishuDelivery: args.feishuDelivery,
      dependencies: args.dependencies,
    },
    signal,
  );
  throw args.error;
}

async function dispatchCanonicalDeliveryCallbacks(
  args: {
    readonly runId: string;
    readonly status: "completed" | "failed";
    readonly slackDeliveryCallbackId: string | undefined;
    readonly feishuDeliveryCallbackId: string | undefined;
    readonly teamsDeliveryCallbackId: string | undefined;
    readonly telegramDeliveryCallbackId: string | undefined;
    readonly agentphoneDeliveryCallbackId: string | undefined;
    readonly githubDeliveryCallbackId: string | undefined;
    readonly dependencies: ChatCallbackDependencies;
  },
  signal: AbortSignal,
): Promise<void> {
  const channels: readonly {
    readonly name: string;
    readonly callbackId: string | undefined;
    readonly dispatch: (
      callbackId: string,
      signal: AbortSignal,
    ) => Promise<void>;
  }[] = [
    {
      name: "Slack",
      callbackId: args.slackDeliveryCallbackId,
      dispatch: (callbackId, dispatchSignal) => {
        return args.dependencies.dispatchSlackDelivery(
          callbackId,
          dispatchSignal,
        );
      },
    },
    {
      name: "Feishu",
      callbackId: args.feishuDeliveryCallbackId,
      dispatch: (callbackId, dispatchSignal) => {
        return args.dependencies.dispatchFeishuDelivery(
          callbackId,
          dispatchSignal,
        );
      },
    },
    {
      name: "Teams",
      callbackId: args.teamsDeliveryCallbackId,
      dispatch: (callbackId, dispatchSignal) => {
        return args.dependencies.dispatchTeamsDelivery(
          callbackId,
          dispatchSignal,
        );
      },
    },
    {
      name: "Telegram",
      callbackId: args.telegramDeliveryCallbackId,
      dispatch: (callbackId, dispatchSignal) => {
        return args.dependencies.dispatchTelegramDelivery(
          callbackId,
          args.status,
          dispatchSignal,
        );
      },
    },
    {
      name: "AgentPhone",
      callbackId: args.agentphoneDeliveryCallbackId,
      dispatch: (callbackId, dispatchSignal) => {
        return args.dependencies.dispatchAgentPhoneDelivery(
          callbackId,
          args.status,
          dispatchSignal,
        );
      },
    },
    {
      name: "GitHub",
      callbackId: args.githubDeliveryCallbackId,
      dispatch: (callbackId, dispatchSignal) => {
        return args.dependencies.dispatchGitHubDelivery(
          callbackId,
          args.status,
          dispatchSignal,
        );
      },
    },
  ];
  for (const channel of channels) {
    const callbackId = channel.callbackId;
    if (!callbackId) {
      continue;
    }
    const delivery = await settle(channel.dispatch(callbackId, signal), signal);
    if (!delivery.ok) {
      log.error(
        `Failed to finalize canonical ${channel.name} delivery callback`,
        {
          runId: args.runId,
          callbackId,
          error: delivery.error,
        },
      );
    }
  }
}

interface TerminalChatCallbackArgs {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly payload: ChatCallbackPayload;
  readonly dependencies: ChatCallbackDependencies;
}

function terminalIntegrationDeliveries(
  payload: ChatCallbackPayload,
): Pick<
  ChatCallbackPayload,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
  | "githubDelivery"
> {
  return {
    slackDelivery: payload.slackDelivery,
    feishuDelivery: payload.feishuDelivery,
    teamsDelivery: payload.teamsDelivery,
    telegramDelivery: payload.telegramDelivery,
    agentphoneDelivery: payload.agentphoneDelivery,
    githubDelivery: payload.githubDelivery,
  };
}

async function releaseManagedBrowsersForTerminalCallback(
  args: TerminalChatCallbackArgs,
  signal: AbortSignal,
): Promise<void> {
  // The window stays live after the run so the user can keep using it; this only
  // restarts its idle lease. Browser resources outlive thread deletion, so use
  // the callback payload rather than loading the thread first.
  const released = await settle(
    args.dependencies.releaseBrowsersForRun(
      { chatThreadId: args.payload.threadId },
      signal,
    ),
    signal,
  );
  if (!released.ok) {
    log.error("Failed to extend managed browser leases for terminal run", {
      runId: args.callback.runId,
      chatThreadId: args.payload.threadId,
      error: released.error,
    });
  }
}

async function clearTerminalIntegrationStatus(
  args: TerminalChatCallbackArgs,
  chatThreadId: string,
  signal: AbortSignal,
): Promise<void> {
  await clearSlackThreadStatusAfterTerminalCallback(
    {
      chatThreadId,
      slackDelivery: args.payload.slackDelivery,
      dependencies: args.dependencies,
    },
    signal,
  );
  await clearFeishuThinkingAfterTerminalCallback(
    {
      feishuDelivery: args.payload.feishuDelivery,
      dependencies: args.dependencies,
    },
    signal,
  );
}

async function drainAndClearTerminalChatThread(
  args: {
    readonly callback: TerminalChatCallbackArgs;
    readonly chatThreadId: string;
    readonly timing: ChatCallbackPreCreateTimingCollector;
    readonly work: TerminalChatCallbackWork;
  },
  signal: AbortSignal,
): Promise<DrainOutcome> {
  const result = await maybeDrainThreadQueueForTerminalCallback(
    {
      enabled: args.work.shouldDrainThreadQueue,
      chatThreadId: args.chatThreadId,
      dependencies: args.callback.dependencies,
      timing: args.timing,
    },
    signal,
  );
  await clearTerminalIntegrationStatus(
    args.callback,
    args.chatThreadId,
    signal,
  );
  return result;
}

async function processTerminalChatCallback(
  args: TerminalChatCallbackArgs,
  signal: AbortSignal,
): Promise<void> {
  const { runId, status: callbackStatus } = args.callback;
  if (callbackStatus === "progress") {
    return;
  }
  const timing = new ChatCallbackPreCreateTimingCollector();

  await releaseManagedBrowsersForTerminalCallback(args, signal);

  const loaded = await measureChatCallbackPreCreateTiming(
    timing,
    "api_dispatch_pre_create_agent_chat_callback_load_terminal",
    "top_level",
    () => {
      return loadTerminalChatCallback(
        {
          db: args.db,
          runId,
          callbackStatus,
          payloadThreadId: args.payload.threadId,
        },
        signal,
      );
    },
  );
  if (!loaded) {
    await clearTerminalIntegrationStatus(args, args.payload.threadId, signal);
    return;
  }
  const { run, chatThread } = loaded;

  const prepared = await settle(
    callbackStatus === "completed"
      ? prepareCompletedTerminalChatCallbackWork(
          {
            db: args.db,
            runId,
            run,
            chatThread,
            dependencies: args.dependencies,
            timing,
            publicBrand: args.payload.publicBrand ?? "vm0",
            ...terminalIntegrationDeliveries(args.payload),
            sourceCallbackId: args.callback.callbackId,
          },
          signal,
        )
      : prepareFailedTerminalChatCallbackWork(
          {
            db: args.db,
            runId,
            run,
            chatThread,
            errorMessage: terminalCallbackErrorMessage(
              args.callback.error,
              run.error,
            ),
            publicBrand: args.payload.publicBrand ?? "vm0",
            dependencies: args.dependencies,
            timing,
            ...terminalIntegrationDeliveries(args.payload),
            sourceCallbackId: args.callback.callbackId,
          },
          signal,
        ),
    signal,
  );

  if (!prepared.ok) {
    return await handleTerminalChatCallbackPreparationFailure(
      {
        runId,
        error: prepared.error,
        chatThreadId: chatThread.chatThreadId,
        slackDelivery: args.payload.slackDelivery,
        feishuDelivery: args.payload.feishuDelivery,
        dependencies: args.dependencies,
        timing,
      },
      signal,
    );
  }
  const work = prepared.value;

  await dispatchCanonicalDeliveryCallbacks(
    {
      runId,
      status: callbackStatus,
      slackDeliveryCallbackId: work.slackDeliveryCallbackId,
      feishuDeliveryCallbackId: work.feishuDeliveryCallbackId,
      teamsDeliveryCallbackId: work.teamsDeliveryCallbackId,
      telegramDeliveryCallbackId: work.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: work.agentphoneDeliveryCallbackId,
      githubDeliveryCallbackId: work.githubDeliveryCallbackId,
      dependencies: args.dependencies,
    },
    signal,
  );

  const drainResult = await drainAndClearTerminalChatThread(
    {
      chatThreadId: chatThread.chatThreadId,
      callback: args,
      timing,
      work,
    },
    signal,
  );

  const deferredSideEffects = work.deferredSideEffects;
  if (deferredSideEffects) {
    await runTerminalChatCallbackSideEffects({
      runId,
      status: callbackStatus,
      run: () => {
        return deferredSideEffects();
      },
    });
  }

  if (!drainResult.ok) {
    throw drainResult.error;
  }
}

function withoutQueuedRunDependency(
  dependencies: ChatCallbackDependencies,
): ChatCallbackDependencies {
  return {
    releaseBrowsersForRun: dependencies.releaseBrowsersForRun,
    insertAssistantItems: dependencies.insertAssistantItems,
    saveRunSummary: dependencies.saveRunSummary,
    dispatchChatRunFinishedAutomations:
      dependencies.dispatchChatRunFinishedAutomations,
    formatRunError: dependencies.formatRunError,
    dispatchSlackDelivery: dependencies.dispatchSlackDelivery,
    clearSlackThreadStatusIfIdle: dependencies.clearSlackThreadStatusIfIdle,
    refreshSlackThreadStatus: dependencies.refreshSlackThreadStatus,
    formatIntegrationRunError: dependencies.formatIntegrationRunError,
    deliverSlackAdmissionFailure: dependencies.deliverSlackAdmissionFailure,
    deliverFeishuAdmissionFailure: dependencies.deliverFeishuAdmissionFailure,
    deliverTeamsAdmissionFailure: dependencies.deliverTeamsAdmissionFailure,
    deliverTelegramAdmissionFailure:
      dependencies.deliverTelegramAdmissionFailure,
    deliverAgentPhoneAdmissionFailure:
      dependencies.deliverAgentPhoneAdmissionFailure,
    dispatchFeishuDelivery: dependencies.dispatchFeishuDelivery,
    dispatchTeamsDelivery: dependencies.dispatchTeamsDelivery,
    dispatchTelegramDelivery: dependencies.dispatchTelegramDelivery,
    dispatchAgentPhoneDelivery: dependencies.dispatchAgentPhoneDelivery,
    deliverGitHubAdmissionFailure: dependencies.deliverGitHubAdmissionFailure,
    dispatchGitHubDelivery: dependencies.dispatchGitHubDelivery,
    clearFeishuThinkingReaction: dependencies.clearFeishuThinkingReaction,
    drainThreadQueue: dependencies.drainThreadQueue,
  };
}

async function claimedUserMessageExistsForRun(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["input.prompt"]),
        isNotNull(chatEvents.revokesEventId),
      ),
    )
    .limit(1);
  return event !== undefined;
}

function buildQueuedChatDispatchFailedCallbacks(
  args: {
    readonly dependencies: ChatCallbackDependencies;
    readonly runInput: CreateQueuedChatRunInput;
  },
  signal: AbortSignal,
): DispatchFailedRunCallbacks {
  return async (db, runId, error) => {
    if (!(await claimedUserMessageExistsForRun(db, runId))) {
      return;
    }
    const payload = {
      threadId: args.runInput.threadId,
      agentId: args.runInput.agentId,
      publicBrand: args.runInput.feishuDelivery
        ? requiredQueuedFeishuPublicBrand(args.runInput)
        : (args.runInput.publicBrand ?? "vm0"),
      slackDelivery: args.runInput.slackDelivery,
      feishuDelivery: args.runInput.feishuDelivery,
      teamsDelivery: args.runInput.teamsDelivery,
      telegramDelivery: args.runInput.telegramDelivery,
      agentphoneDelivery: args.runInput.agentphoneDelivery,
      githubDelivery: args.runInput.githubDelivery,
    };
    await processTerminalChatCallback(
      {
        db,
        callback: {
          runId,
          status: "failed",
          error,
          payload,
        },
        payload,
        dependencies: withoutQueuedRunDependency(args.dependencies),
      },
      signal,
    );
  };
}

function queuedChatDispatchFailedCallbacks(
  dependencies: ChatCallbackDependencies,
  runInput: CreateQueuedChatRunInput,
  signal: AbortSignal,
): DispatchFailedRunCallbacks {
  return buildQueuedChatDispatchFailedCallbacks(
    { dependencies, runInput },
    signal,
  );
}

const createQueuedRunForChatCallback$ = command(
  async (
    { set },
    input: {
      readonly db: Db;
      readonly dependencies: ChatCallbackDependencies;
      readonly runInput: CreateQueuedChatRunInput;
      readonly admissionTime: number;
    },
    signal: AbortSignal,
  ): Promise<CreatedQueuedRun | QueuedMessageAdmissionFailure | null> => {
    const dispatchFailedCallbacks = queuedChatDispatchFailedCallbacks(
      input.dependencies,
      input.runInput,
      signal,
    );
    const createArgs = buildQueuedCreateAgentRunArgs(
      input.runInput,
      input.admissionTime,
      dispatchFailedCallbacks,
    );
    const settledRunResult = await settle(
      set(createQueueFirstAgentRun$, createArgs, signal),
    );
    signal.throwIfAborted();
    if (!settledRunResult.ok) {
      if (
        isForeignKeyViolation(settledRunResult.error) &&
        !(await chatThreadExists(input.db, input.runInput.threadId))
      ) {
        return null;
      }
      signal.throwIfAborted();
      throw settledRunResult.error;
    }
    const runResult = settledRunResult.value;
    if (isQueueFirstRunClaimLost(runResult)) {
      signal.throwIfAborted();
      // Claim loss is expected exactly-one-winner arbitration; structured
      // queue-first timing telemetry remains the diagnostic source.
      return null;
    }
    if (
      input.runInput.requiredOfficialWorkflowIds !== undefined &&
      runResult.status === 409 &&
      runResult.body.error.code === "CONFLICT" &&
      runResult.body.error.message === OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE
    ) {
      signal.throwIfAborted();
      return officialWorkflowQueuedMessageAdmissionFailure(input.runInput);
    }
    if (runResult.status !== 201) {
      signal.throwIfAborted();
      log.warn("Auto-send failed to create run", {
        threadId: input.runInput.threadId,
        status: runResult.status,
      });
      return null;
    }
    if (!isCreatedQueuedRunStatus(runResult.body.status)) {
      log.warn("Auto-send created run with unexpected status", {
        threadId: input.runInput.threadId,
        runId: runResult.body.runId,
        status: runResult.body.status,
      });
      return null;
    }
    return {
      runId: runResult.body.runId,
      status: runResult.body.status,
      claimedEventCreatedAt: runResult.queueFirstClaim.createdAt,
    };
  },
);

function handleChatInternalCallback(
  args: {
    readonly db: Db;
    readonly callback: InternalRunCallbackEnvelope;
    readonly dependencies: ChatCallbackDependencies;
  },
  signal: AbortSignal,
):
  | { readonly success: true }
  | { readonly success: false; readonly error: string } {
  const payload = chatCallbackPayloadSchema.safeParse(args.callback.payload);
  if (!payload.success) {
    return {
      success: false,
      error: "Invalid or missing payload",
    };
  }

  if (args.callback.status === "progress") {
    if (payload.data.slackDelivery) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          args.dependencies.refreshSlackThreadStatus(
            {
              chatThreadId: payload.data.threadId,
              channelId: payload.data.slackDelivery.channelId,
              threadTs: payload.data.slackDelivery.threadTs,
              ...(payload.data.slackDelivery.routeThreadTs
                ? {
                    routeThreadTs: payload.data.slackDelivery.routeThreadTs,
                  }
                : {}),
            },
            backgroundSignal,
          ),
          (error) => {
            log.warn("Failed to refresh canonical Slack thread status", {
              runId: args.callback.runId,
              error,
            });
          },
        ),
      );
    }
    return { success: true };
  }

  signal.throwIfAborted();
  // The webhook sender (dispatchRunCallbacks) awaits this response only to
  // record delivery; it does not retry and nothing downstream reads the body.
  // The frontend learns about new messages through Ably realtime signals, not
  // this HTTP response. Acknowledge before
  // running heavy terminal processing (message persistence, LLM generation,
  // and push delivery) in the background, mirroring webhooks-agent-complete.
  // Use a detached signal so request cancellation cannot interrupt the
  // idempotency marker -> queued auto-send sequence after acknowledgement.
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    tapError(
      processTerminalChatCallback(
        {
          db: args.db,
          callback: args.callback,
          payload: payload.data,
          dependencies: args.dependencies,
        },
        backgroundSignal,
      ),
      (error) => {
        log.error("Failed to process terminal chat callback", {
          runId: args.callback.runId,
          status: args.callback.status,
          error,
        });
      },
    ),
  );

  return { success: true };
}

function feishuChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  | "deliverFeishuAdmissionFailure"
  | "dispatchFeishuDelivery"
  | "clearFeishuThinkingReaction"
> {
  return {
    deliverFeishuAdmissionFailure: (params, signal) => {
      return deliverFeishuChatAdmissionFailure({ db, ...params }, signal);
    },
    dispatchFeishuDelivery: (callbackId, signal) => {
      return dispatchFeishuChatDeliveryOnce(db, callbackId, signal);
    },
    clearFeishuThinkingReaction: (target, signal) => {
      return clearCanonicalFeishuThinkingReaction(db, target, signal);
    },
  };
}

function teamsChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverTeamsAdmissionFailure" | "dispatchTeamsDelivery"
> {
  return {
    deliverTeamsAdmissionFailure: (params, signal) => {
      return deliverTeamsChatAdmissionFailure({ db, ...params }, signal);
    },
    dispatchTeamsDelivery: (callbackId, signal) => {
      return dispatchTeamsChatDeliveryOnce(db, callbackId, signal);
    },
  };
}

function telegramChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverTelegramAdmissionFailure" | "dispatchTelegramDelivery"
> {
  return {
    deliverTelegramAdmissionFailure: (params, signal) => {
      return deliverTelegramChatAdmissionFailure(
        {
          db,
          ...params,
        },
        signal,
      );
    },
    dispatchTelegramDelivery: (callbackId, status, signal) => {
      return dispatchTelegramChatDeliveryOnce(db, callbackId, status, signal);
    },
  };
}

function agentPhoneChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverAgentPhoneAdmissionFailure" | "dispatchAgentPhoneDelivery"
> {
  return {
    deliverAgentPhoneAdmissionFailure: (params, signal) => {
      return deliverAgentPhoneChatAdmissionFailure(
        {
          db,
          ...params,
        },
        signal,
      );
    },
    dispatchAgentPhoneDelivery: (callbackId, status, signal) => {
      return dispatchAgentPhoneChatDeliveryOnce(db, callbackId, status, signal);
    },
  };
}

function githubChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverGitHubAdmissionFailure" | "dispatchGitHubDelivery"
> {
  return {
    deliverGitHubAdmissionFailure: (params, signal) => {
      return deliverGitHubChatAdmissionFailure(
        {
          db,
          ...params,
        },
        signal,
      );
    },
    dispatchGitHubDelivery: (callbackId, status, signal) => {
      return dispatchGitHubChatDeliveryOnce(db, callbackId, status, signal);
    },
  };
}

export async function handleChatInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal = new AbortController().signal,
): Promise<
  | { readonly success: true }
  | { readonly success: false; readonly error: string }
> {
  return await handleChatInternalCallback(
    {
      db,
      callback,
      dependencies: {
        releaseBrowsersForRun: (args, inputSignal) => {
          return createStore().set(
            releaseThreadBrowsersForRun$,
            args,
            inputSignal,
          );
        },
        insertAssistantItems: async (args, inputSignal) => {
          await insertAssistantEvents(
            db,
            assistantEventInsertInput(args),
            inputSignal,
          );
        },
        saveRunSummary: (runId, prompt, resultText, inputSignal) => {
          return saveRunSummary(
            db,
            { runId, triggerSource: "chat", prompt, resultText },
            inputSignal,
          );
        },
        dispatchChatRunFinishedAutomations: (event, inputSignal) => {
          return createStore().set(
            dispatchConfiguredChatRunFinishedEvent$,
            event,
            inputSignal,
          );
        },
        formatRunError: (params) => {
          return Promise.resolve(
            formatRunErrorForExternalSurface({
              code: "INTERNAL_SERVER_ERROR",
              message: params.errorMessage,
            }),
          );
        },
        dispatchSlackDelivery: (callbackId, inputSignal) => {
          return dispatchSlackChatDeliveryOnce(db, callbackId, inputSignal);
        },
        clearSlackThreadStatusIfIdle: (target, inputSignal) => {
          return clearCanonicalSlackThreadStatusIfIdle(db, target, inputSignal);
        },
        refreshSlackThreadStatus: (target, inputSignal) => {
          return refreshCanonicalSlackThreadStatus(db, target, inputSignal);
        },
        formatIntegrationRunError: (params) => {
          return Promise.resolve(
            formatRunErrorForExternalSurface({
              code: params.code,
              message: params.message,
            }),
          );
        },
        deliverSlackAdmissionFailure: (params, inputSignal) => {
          return deliverSlackChatAdmissionFailure(
            {
              db,
              ...params,
            },
            inputSignal,
          );
        },
        ...feishuChatDeliveryDependencies(db),
        ...teamsChatDeliveryDependencies(db),
        ...telegramChatDeliveryDependencies(db),
        ...agentPhoneChatDeliveryDependencies(db),
        ...githubChatDeliveryDependencies(db),
      },
    },
    signal,
  );
}

const buildChatCallbackDependencies$ = command(
  (
    { set },
    input: {
      readonly db: Db;
      readonly drainThreadQueue?: ChatCallbackDependencies["drainThreadQueue"];
    },
  ): ChatCallbackDependencies => {
    const { db } = input;
    const baseDependencies: ChatCallbackDependencies = {
      releaseBrowsersForRun: (args, inputSignal) => {
        return set(releaseThreadBrowsersForRun$, args, inputSignal);
      },
      insertAssistantItems: async (args, inputSignal) => {
        await set(
          insertAssistantEvents$,
          assistantEventInsertInput(args),
          inputSignal,
        );
      },
      dispatchChatRunFinishedAutomations: (event, inputSignal) => {
        return set(dispatchConfiguredChatRunFinishedEvent$, event, inputSignal);
      },
      saveRunSummary: (runId, prompt, resultText, inputSignal) => {
        return set(
          saveRunSummary$,
          {
            runId,
            triggerSource: "chat",
            prompt,
            resultText,
          },
          inputSignal,
        );
      },
      formatRunError: (params, inputSignal) => {
        return set(formatRunErrorForRunOwner$, params, inputSignal);
      },
      dispatchSlackDelivery: (callbackId, inputSignal) => {
        return dispatchSlackChatDeliveryOnce(db, callbackId, inputSignal);
      },
      clearSlackThreadStatusIfIdle: (target, inputSignal) => {
        return clearCanonicalSlackThreadStatusIfIdle(db, target, inputSignal);
      },
      refreshSlackThreadStatus: (target, inputSignal) => {
        return refreshCanonicalSlackThreadStatus(db, target, inputSignal);
      },
      formatIntegrationRunError: (params, inputSignal) => {
        return set(formatIntegrationRunError$, params, inputSignal);
      },
      deliverSlackAdmissionFailure: (params, inputSignal) => {
        const admissionArgs = { db, ...params };
        return deliverSlackChatAdmissionFailure(admissionArgs, inputSignal);
      },
      ...feishuChatDeliveryDependencies(db),
      ...teamsChatDeliveryDependencies(db),
      ...telegramChatDeliveryDependencies(db),
      ...agentPhoneChatDeliveryDependencies(db),
      ...githubChatDeliveryDependencies(db),
      drainThreadQueue: input.drainThreadQueue,
    };
    const dependencies: ChatCallbackDependencies = {
      ...baseDependencies,
      createQueuedRun: (runInput, admissionTime, inputSignal) => {
        return set(
          createQueuedRunForChatCallback$,
          {
            db,
            dependencies: baseDependencies,
            runInput,
            admissionTime,
          },
          inputSignal,
        );
      },
    };
    return dependencies;
  },
);

/** User-message drain used by the shared event-backed thread scheduler. */
export const drainQueuedUserMessagesForThread$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly apiStartTime: number;
      readonly queueItemCreatedBefore?: Date;
      readonly timing?: ChatCallbackPreCreateTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [thread] = await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_agent_chat_callback_auto_send_load_thread",
      "nested",
      () => {
        return db
          .select({
            userId: chatThreads.userId,
            agentId: agents.id,
          })
          .from(chatThreads)
          .innerJoin(agents, eq(agents.id, chatThreads.agentId))
          .where(eq(chatThreads.id, args.chatThreadId))
          .limit(1);
      },
    );
    signal.throwIfAborted();
    if (!thread) {
      return;
    }
    const dependencies = set(buildChatCallbackDependencies$, { db });
    const createQueuedRun = dependencies.createQueuedRun;
    if (!createQueuedRun) {
      return;
    }
    const admissionTime = args.apiStartTime;
    await autoSendQueuedMessageForThread(
      {
        db,
        chatThreadId: args.chatThreadId,
        admissionTime,
        userId: thread.userId,
        agentId: thread.agentId,
        queueItemCreatedBefore: args.queueItemCreatedBefore,
        timing: args.timing ?? new ChatCallbackPreCreateTimingCollector(),
        formatIntegrationRunError: dependencies.formatIntegrationRunError,
        deliverSlackAdmissionFailure: dependencies.deliverSlackAdmissionFailure,
        deliverFeishuAdmissionFailure:
          dependencies.deliverFeishuAdmissionFailure,
        clearFeishuThinkingReaction: dependencies.clearFeishuThinkingReaction,
        deliverTeamsAdmissionFailure: dependencies.deliverTeamsAdmissionFailure,
        deliverTelegramAdmissionFailure:
          dependencies.deliverTelegramAdmissionFailure,
        deliverAgentPhoneAdmissionFailure:
          dependencies.deliverAgentPhoneAdmissionFailure,
        deliverGitHubAdmissionFailure:
          dependencies.deliverGitHubAdmissionFailure,
        createRun: (input) => {
          return createQueuedChatRun(
            {
              input,
              createRun: (runInput) => {
                return createQueuedRun(runInput, admissionTime, signal);
              },
            },
            signal,
          );
        },
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

export const handleChatInternalCallback$ = command(
  async (
    { set },
    input: {
      readonly callback: InternalRunCallbackEnvelope;
      readonly drainThreadQueue?: ChatCallbackDependencies["drainThreadQueue"];
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly success: true }
    | { readonly success: false; readonly error: string }
  > => {
    const db = set(writeDb$);
    const dependencies = set(buildChatCallbackDependencies$, {
      db,
      drainThreadQueue: input.drainThreadQueue,
    });
    return await handleChatInternalCallback(
      {
        db,
        callback: input.callback,
        dependencies,
      },
      signal,
    );
  },
);
