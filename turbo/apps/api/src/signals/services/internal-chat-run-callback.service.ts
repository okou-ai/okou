import { resolveReasoningEffortForDispatch } from "./chat-reasoning-effort.service";
import { resolveIntegrationChatThreadAgent } from "./integration-chat-thread-agent.service";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { randomBytes } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

import { command } from "ccstate";
import {
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  serializeChatFollowupsContent,
  type ChatRecommendedFollowup,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { publicProviderBalanceFailureReason } from "@okouai/api-contracts/contracts/run-balance-errors";
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
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
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
  deliverTeamsChatAdmissionFailure,
  dispatchTeamsChatDeliveryOnce,
} from "./internal-teams-chat-run-callback.service";
import {
  sendDiscordChatReply$,
  type DiscordReplyRequest,
} from "./internal-discord-chat-run-callback.service";
import {
  deliverTelegramChatAdmissionFailure,
  dispatchTelegramChatDeliveryOnce,
} from "./internal-telegram-chat-run-callback.service";
import {
  agentphoneDeliveryTargetSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import {
  discordDeliveryTargetSchema,
  type DiscordDeliveryTarget,
} from "./discord-chat-callback-payload";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import {
  clearCanonicalSlackThreadStatusIfIdle,
  refreshCanonicalSlackThreadStatus,
} from "./canonical-slack-thread-status.service";
import { saveRunSummary$ } from "./run-summary.service";
import { dispatchConfiguredChatRunFinishedEvent$ } from "./chat-run-finished-event-dispatch.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import {
  insertAssistantEvents$,
  touchChatThreadLastMessageAtIndependently,
  type InsertAssistantEventsInput,
  visibleChatEventCondition,
} from "./chat-event-shared.service";
import { insertChatEvent } from "./chat-event.service";
import { loadWebChatIncompleteContext } from "./chat-incomplete-context.service";
import {
  agentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import {
  buildWebChatAppendSystemPrompt,
  lastRunMessageSeqIds,
} from "./web-chat-session-prompt.service";
import {
  integrationCompletionFallbackEventIdForRun,
  followupsEventIdForRun,
} from "./assistant-event-id";
import {
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
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
  ChatQueueRunAssembly,
} from "./chat-queue-run-assembly";
import { shouldUsePiExecution } from "./pi-sandbox-config";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  onRejection,
  settle,
  settleIncludingAbort,
  tapError,
  throwIfAbort,
} from "../utils";
import { buildGenerationTemplatesPrompt } from "../../lib/generation-template-prompt";
import { logTemplateUsage } from "../../lib/template-usage-log";
import {
  generationTemplateIdentity,
  type GenerationTemplateIdentity,
} from "@okouai/core/generation-template-identity";
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
  DiscordQueuedLaunchUnavailableError,
  loadDiscordQueuedLaunchMaterial$,
  type DiscordQueuedLaunchMaterial,
} from "./discord-queued-launch-context.service";
import { scheduleDiscordRunTyping$ } from "./discord-run-typing.service";
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
import {
  authorizedUserTemplates,
  selectedUserTemplateIds,
  userTemplateVolumes,
  type MountedUserTemplate,
} from "./user-template-data.service";
import { chatNetworkBodyCaptureRequested } from "./chat-network-body-capture.service";

const log = logger("callback:chat");
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

const chatCallbackPayloadSchema = z
  .object({
    threadId: z.string(),
    agentId: z.string(),
    slackDelivery: z
      .object({
        channelId: z.string(),
        threadTs: z.string(),
        routeThreadTs: z.string().optional(),
      })
      .optional(),
    feishuDelivery: feishuDeliveryTargetSchema.optional(),
    teamsDelivery: teamsDeliveryTargetSchema.optional(),
    discordDelivery: discordDeliveryTargetSchema.optional(),
    telegramDelivery: telegramDeliveryTargetSchema.optional(),
    agentphoneDelivery: agentphoneDeliveryTargetSchema.optional(),
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
  readonly modelProvider: string | null;
  readonly lastEventSequence: number | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

interface CreateQueuedChatRunInput {
  readonly expectedThreadAgentId?: string;
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
  /** The send asked this input's run to capture network bodies. */
  readonly captureNetworkBodies: boolean;
  readonly slackDelivery?: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly discordDelivery?: DiscordDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
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
  readonly triggerSource: QueuedUserMessageTriggerSource;
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
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly error: QueuedMessageModelRouteError;
}

interface FeishuQueuedMessageAdmissionFailure {
  readonly kind: "feishu_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly triggerSource: QueuedUserMessageTriggerSource;
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
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly teamsDelivery: TeamsDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface DiscordQueuedMessageAdmissionFailure {
  readonly kind: "discord_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly discordDelivery: DiscordDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface TelegramQueuedMessageAdmissionFailure {
  readonly kind: "telegram_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly triggerSource: QueuedUserMessageTriggerSource;
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
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly agentphoneDelivery: AgentPhoneDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

type QueuedMessageAdmissionFailure =
  | WebQueuedMessageAdmissionFailure
  | SlackQueuedMessageAdmissionFailure
  | FeishuQueuedMessageAdmissionFailure
  | TeamsQueuedMessageAdmissionFailure
  | DiscordQueuedMessageAdmissionFailure
  | TelegramQueuedMessageAdmissionFailure
  | AgentPhoneQueuedMessageAdmissionFailure;

type CompletedChatCallbackResult =
  | {
      readonly outcome: "written" | "replayed";
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
      readonly teamsDeliveryCallbackId?: string;
      readonly discordReply?: DiscordReplyRequest;
      readonly telegramDeliveryCallbackId?: string;
      readonly agentphoneDeliveryCallbackId?: string;
    }
  | ({ readonly outcome: "duplicate" } & RunLifecycleDeliveryCallbacks);

type FailedChatCallbackResult =
  | {
      readonly outcome: "written" | "replayed";
      readonly displayErrorMessage: string;
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
      readonly teamsDeliveryCallbackId?: string;
      readonly discordReply?: DiscordReplyRequest;
      readonly telegramDeliveryCallbackId?: string;
      readonly agentphoneDeliveryCallbackId?: string;
    }
  | ({ readonly outcome: "duplicate" } & RunLifecycleDeliveryCallbacks);

interface TerminalChatCallbackWork {
  readonly outcome: "written" | "replayed" | "duplicate";
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly discordReply?: DiscordReplyRequest;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
  readonly runFinishedEvent?: ChatRunFinishedEvent;
  readonly deferredSideEffects?:
    | {
        readonly status: "completed";
        readonly run: ChatRunInfo;
        readonly lastResultText: string | null;
        readonly followupContext: readonly ChatCompletionContextMessage[];
      }
    | {
        readonly status: "failed";
        readonly run: ChatRunInfo;
        readonly displayErrorMessage: string;
      };
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
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
    expectedThreadAgentId: input.expectedThreadAgentId,
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
          queuedMessageId: input.queuedMessage.id,
          slackDelivery: input.slackDelivery,
          feishuDelivery: input.feishuDelivery,
          teamsDelivery: input.teamsDelivery,
          discordDelivery: input.discordDelivery,
          telegramDelivery: input.telegramDelivery,
          agentphoneDelivery: input.agentphoneDelivery,
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
      threadId: input.threadId,
      eventId: input.queuedMessage.id,
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
      ...(input.captureNetworkBodies ? { captureNetworkBodies: true } : {}),
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

const CHAT_DELIVERY_CALLBACK_NAMESPACE = "3c3c6fe0-1041-4d9b-8fbc-403eec20e47b";

type ChatDeliveryKind =
  | "slack:chat"
  | "feishu:chat"
  | "teams:chat"
  | "telegram:chat"
  | "agentphone:chat";

async function requireSourceChatCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId?: string;
}) {
  const [source] = await args.db
    .select({
      id: agentRunCallbacks.id,
      encryptedSecret: agentRunCallbacks.encryptedSecret,
    })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
        args.sourceCallbackId
          ? eq(agentRunCallbacks.id, args.sourceCallbackId)
          : undefined,
      ),
    )
    .orderBy(asc(agentRunCallbacks.id))
    .limit(1);
  if (!source) {
    throw new Error("Canonical delivery run is missing its chat callback");
  }

  return source;
}

async function insertChatDeliveryCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId: string;
  readonly internalKind: ChatDeliveryKind;
  readonly chatEventId: string;
  readonly payload: NonNullable<
    (typeof agentRunCallbacks.$inferInsert)["payload"]
  >;
}): Promise<string> {
  const source = await requireSourceChatCallback(args);

  const id = uuidv5(
    `${source.id}:${args.internalKind}:${args.chatEventId}`,
    CHAT_DELIVERY_CALLBACK_NAMESPACE,
  );
  await args.db
    .insert(agentRunCallbacks)
    .values({
      id,
      runId: args.runId,
      internalKind: args.internalKind,
      encryptedSecret: source.encryptedSecret,
      payload: args.payload,
    })
    .onConflictDoNothing({ target: agentRunCallbacks.id });
  return id;
}

async function insertSlackChatDeliveryCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId: string;
  readonly target: SlackDeliveryTarget;
  readonly chatEventId: string;
}): Promise<string> {
  return await insertChatDeliveryCallback({
    db: args.db,
    runId: args.runId,
    sourceCallbackId: args.sourceCallbackId,
    internalKind: "slack:chat",
    chatEventId: args.chatEventId,
    payload: {
      ...args.target,
      chatEventId: args.chatEventId,
    },
  });
}

async function insertFeishuChatDeliveryCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId: string;
  readonly target: FeishuDeliveryTarget;
  readonly chatEventId: string;
}): Promise<string> {
  return await insertChatDeliveryCallback({
    db: args.db,
    runId: args.runId,
    sourceCallbackId: args.sourceCallbackId,
    internalKind: "feishu:chat",
    chatEventId: args.chatEventId,
    payload: {
      ...args.target,
      chatEventId: args.chatEventId,
    },
  });
}

async function insertTeamsChatDeliveryCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId: string;
  readonly target: TeamsDeliveryTarget;
  readonly chatEventId: string;
}): Promise<string> {
  return await insertChatDeliveryCallback({
    db: args.db,
    runId: args.runId,
    sourceCallbackId: args.sourceCallbackId,
    internalKind: "teams:chat",
    chatEventId: args.chatEventId,
    payload: {
      ...args.target,
      chatEventId: args.chatEventId,
    },
  });
}

/**
 * Discord replies are fire and forget with no delivery record, so only the
 * attempt that created the event posts it; replays never post twice.
 */
async function discordReplyRequest(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly target: DiscordDeliveryTarget;
  readonly chatEventId: string;
}): Promise<DiscordReplyRequest> {
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  if (!run?.chatThreadId) {
    throw new Error("Canonical Discord delivery run is unavailable");
  }
  return {
    chatEventId: args.chatEventId,
    chatThreadId: run.chatThreadId,
    userId: run.userId,
    orgId: run.orgId,
    target: args.target,
  };
}

async function insertTelegramChatDeliveryCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId: string;
  readonly target: TelegramDeliveryTarget;
  readonly chatEventId: string;
}): Promise<string> {
  return await insertChatDeliveryCallback({
    db: args.db,
    runId: args.runId,
    sourceCallbackId: args.sourceCallbackId,
    internalKind: "telegram:chat",
    chatEventId: args.chatEventId,
    payload: {
      ...args.target,
      chatEventId: args.chatEventId,
    },
  });
}

async function insertAgentPhoneChatDeliveryCallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly sourceCallbackId: string;
  readonly target: AgentPhoneDeliveryTarget;
  readonly chatEventId: string;
}): Promise<string> {
  return await insertChatDeliveryCallback({
    db: args.db,
    runId: args.runId,
    sourceCallbackId: args.sourceCallbackId,
    internalKind: "agentphone:chat",
    chatEventId: args.chatEventId,
    payload: {
      ...args.target,
      chatEventId: args.chatEventId,
    },
  });
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

interface AssistantErrorEventArgs {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly lifecycleEvent: "failed" | "cancelled";
  readonly failureReason: RunFailureReasonToken | null;
  readonly hasCancellationRecoveryState: boolean;
  readonly displayErrorMessage: string;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly discordDelivery?: DiscordDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly sourceCallbackId: string;
}

async function insertAssistantErrorEventTransaction(
  tx: ChatCallbackTransaction,
  input: AssistantErrorEventArgs,
  displayErrorMessage: string,
): Promise<
  (RunLifecycleDeliveryCallbacks & { readonly markerInserted: boolean }) | null
> {
  const insertedEvent = await insertChatEvent(
    tx,
    {
      chatThreadId: input.threadId,
      eventType:
        input.lifecycleEvent === "failed" ? "run.failed" : "run.cancelled",
      content: displayErrorMessage,
      runId: input.runId,
      error: displayErrorMessage,
      ...(input.lifecycleEvent === "failed" && input.failureReason !== null
        ? { failureReason: input.failureReason }
        : {}),
    },
    "run-lifecycle",
  );
  const event =
    insertedEvent ??
    (await loadRunLifecycleMarker(
      tx,
      input.runId,
      input.lifecycleEvent === "failed" ? "run.failed" : "run.cancelled",
    ));
  if (!event) {
    return null;
  }
  const slackDeliveryCallbackId = input.slackDelivery
    ? await insertSlackChatDeliveryCallback({
        db: tx,
        runId: input.runId,
        sourceCallbackId: input.sourceCallbackId,
        target: input.slackDelivery,
        chatEventId: event.id,
      })
    : undefined;
  const feishuDeliveryCallbackId = input.feishuDelivery
    ? await insertFeishuChatDeliveryCallback({
        db: tx,
        runId: input.runId,
        sourceCallbackId: input.sourceCallbackId,
        target: input.feishuDelivery,
        chatEventId: event.id,
      })
    : undefined;
  const teamsDeliveryCallbackId = input.teamsDelivery
    ? await insertTeamsChatDeliveryCallback({
        db: tx,
        runId: input.runId,
        sourceCallbackId: input.sourceCallbackId,
        target: input.teamsDelivery,
        chatEventId: event.id,
      })
    : undefined;
  const discordReply =
    input.discordDelivery && insertedEvent
      ? await discordReplyRequest({
          db: tx,
          runId: input.runId,
          target: input.discordDelivery,
          chatEventId: event.id,
        })
      : undefined;
  const telegramDeliveryCallbackId = input.telegramDelivery
    ? await insertTelegramChatDeliveryCallback({
        db: tx,
        runId: input.runId,
        sourceCallbackId: input.sourceCallbackId,
        target: input.telegramDelivery,
        chatEventId: event.id,
      })
    : undefined;
  const agentphoneDeliveryCallbackId = input.agentphoneDelivery
    ? await insertAgentPhoneChatDeliveryCallback({
        db: tx,
        runId: input.runId,
        sourceCallbackId: input.sourceCallbackId,
        target: input.agentphoneDelivery,
        chatEventId: event.id,
      })
    : undefined;
  return {
    markerInserted: insertedEvent !== null,
    slackDeliveryCallbackId,
    feishuDeliveryCallbackId,
    teamsDeliveryCallbackId,
    discordReply,
    telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId,
  };
}

async function insertAssistantErrorEvent(
  args: AssistantErrorEventArgs,
  signal: AbortSignal,
): Promise<FailedChatCallbackResult> {
  const { displayErrorMessage } = args;
  signal.throwIfAborted();
  const inserted = await insertAssistantErrorEventTransaction(
    args.db,
    args,
    displayErrorMessage,
  );
  if (!inserted) {
    return { outcome: "duplicate" };
  }

  // Replays repeat the monotonic touch and publishes because an earlier
  // attempt may have failed after its marker committed.
  await touchChatThreadLastMessageAtIndependently(args.db, args.threadId, {
    orgId: args.orgId,
    unarchive: args.lifecycleEvent === "failed",
  });
  await publishAssistantErrorEventSignals(args);
  return {
    displayErrorMessage,
    outcome: inserted.markerInserted ? "written" : "replayed",
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    discordReply: inserted.discordReply,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
  };
}

type ChatCallbackTransaction = Db | Tx;

interface CanonicalDeliveryEvent {
  readonly id: string;
}

async function loadRunLifecycleMarker(
  db: Pick<Db, "select">,
  runId: string,
  eventType: "run.completed" | "run.cancelled" | "run.failed",
) {
  const [marker] = await db
    .select({ id: chatEvents.id, createdAt: chatEvents.createdAt })
    .from(chatEvents)
    .where(
      and(eq(chatEvents.runId, runId), eq(chatEvents.eventType, eventType)),
    )
    .limit(1);
  return marker;
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
  readonly discordDelivery?: DiscordDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly sourceCallbackId: string;
}

interface RunLifecycleDeliveryCallbacks {
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly discordReply?: DiscordReplyRequest;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
}

function hasCanonicalIntegrationDelivery(
  args: RunLifecycleMarkerArgs,
): boolean {
  return Boolean(
    args.slackDelivery ||
    args.feishuDelivery ||
    args.teamsDelivery ||
    args.discordDelivery ||
    args.telegramDelivery ||
    args.agentphoneDelivery,
  );
}

function requiresIntegrationCompletionFallback(
  args: RunLifecycleMarkerArgs,
): boolean {
  return (
    args.event === "completed" &&
    Boolean(
      args.teamsDelivery ||
      args.discordDelivery ||
      args.telegramDelivery ||
      args.agentphoneDelivery,
    )
  );
}

async function registerRunLifecycleDeliveryCallbacks(
  tx: ChatCallbackTransaction,
  input: RunLifecycleMarkerArgs,
  deliveryEvent: { readonly id: string } | undefined,
  markerInserted: boolean,
): Promise<RunLifecycleDeliveryCallbacks> {
  const slackDeliveryCallbackId =
    deliveryEvent && input.slackDelivery
      ? await insertSlackChatDeliveryCallback({
          db: tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.slackDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const feishuDeliveryCallbackId =
    deliveryEvent && input.feishuDelivery
      ? await insertFeishuChatDeliveryCallback({
          db: tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.feishuDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const teamsDeliveryCallbackId =
    deliveryEvent && input.teamsDelivery
      ? await insertTeamsChatDeliveryCallback({
          db: tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.teamsDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const discordReply =
    deliveryEvent && input.discordDelivery && markerInserted
      ? await discordReplyRequest({
          db: tx,
          runId: input.runId,
          target: input.discordDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const telegramDeliveryCallbackId =
    deliveryEvent && input.telegramDelivery
      ? await insertTelegramChatDeliveryCallback({
          db: tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.telegramDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const agentphoneDeliveryCallbackId =
    deliveryEvent && input.agentphoneDelivery
      ? await insertAgentPhoneChatDeliveryCallback({
          db: tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.agentphoneDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  return {
    slackDeliveryCallbackId,
    feishuDeliveryCallbackId,
    teamsDeliveryCallbackId,
    discordReply,
    telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId,
  };
}

export async function insertRunLifecycleMarkerProjection(args: {
  readonly tx: ChatCallbackTransaction;
  readonly input: RunLifecycleMarkerArgs;
  readonly markerCreatedAt: Date;
}): Promise<
  (RunLifecycleDeliveryCallbacks & { readonly markerInserted: boolean }) | null
> {
  const { input } = args;
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
      createdAt: args.markerCreatedAt,
    },
    "run-lifecycle",
  );
  if (
    !marker &&
    !(await loadRunLifecycleMarker(
      args.tx,
      input.runId,
      input.event === "completed" ? "run.completed" : "run.cancelled",
    ))
  ) {
    return null;
  }
  return {
    markerInserted: marker !== null,
    ...(await registerRunLifecycleDeliveryCallbacks(
      args.tx,
      input,
      deliveryEvent,
      marker !== null,
    )),
  };
}

async function insertRunLifecycleMarker(
  args: RunLifecycleMarkerArgs,
  signal: AbortSignal,
): Promise<
  | ({ readonly outcome: "duplicate" } & RunLifecycleDeliveryCallbacks)
  | ({
      readonly outcome: "written" | "replayed";
    } & RunLifecycleDeliveryCallbacks)
> {
  signal.throwIfAborted();
  const markerCreatedAt = nowDate();
  const inserted = await insertRunLifecycleMarkerProjection({
    tx: args.db,
    input: args,
    markerCreatedAt,
  });
  if (!inserted) {
    return { outcome: "duplicate" };
  }
  // The marker is only one committed projection. Its source callback still
  // owns completion work until registration and automation admission succeed,
  // so a replay repeats the monotonic touch and publishes an earlier attempt
  // may have lost after the marker committed.
  await touchChatThreadLastMessageAtIndependently(args.db, args.threadId, {
    touchedAt: markerCreatedAt,
    orgId: args.orgId,
    unarchive: args.event === "completed",
  });
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
    outcome: inserted.markerInserted ? "written" : "replayed",
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    discordReply: inserted.discordReply,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
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
  const inserted = await insertChatEvent(
    args.db,
    {
      id: followupsEventIdForRun(args.runId),
      chatThreadId: args.threadId,
      eventType: "output.followups",
      content: serializeChatFollowupsContent(args.followups),
      runId: args.runId,
    },
    "id",
  );

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

const materializeCompletedChatResult$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly chatThread: ChatThreadForRunRow;
      readonly output: CompletedChatOutputLoad;
      readonly preferResultFallback: boolean;
      readonly timing: ChatCallbackPreCreateTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { assistantItemsToInsert, latestAssistant, resultFallback } =
      args.output;
    if (assistantItemsToInsert.length > 0) {
      await measureChatCallbackPreCreateTiming(
        args.timing,
        "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
        "nested",
        () => {
          return set(
            insertAssistantEvents$,
            assistantEventInsertInput({
              runId: args.runId,
              threadId: args.chatThread.chatThreadId,
              userId: args.chatThread.userId,
              orgId: args.chatThread.orgId,
              items: assistantItemsToInsert,
            }),
            signal,
          );
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
          return set(
            insertAssistantEvents$,
            assistantEventInsertInput({
              runId: args.runId,
              threadId: args.chatThread.chatThreadId,
              userId: args.chatThread.userId,
              orgId: args.chatThread.orgId,
              items: [resultFallback],
            }),
            signal,
          );
        },
      );
      signal.throwIfAborted();
      lastResultText = resultFallback.content;
    }
    return lastResultText;
  },
);

const handleCompletedChatCallback$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly timing: ChatCallbackPreCreateTimingCollector;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<CompletedChatCallbackResult> => {
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

    const lastResultText = await set(
      materializeCompletedChatResult$,
      {
        runId: args.runId,
        chatThread: args.chatThread,
        output,
        preferResultFallback:
          args.slackDelivery !== undefined ||
          args.teamsDelivery !== undefined ||
          args.discordDelivery !== undefined ||
          args.telegramDelivery !== undefined ||
          args.agentphoneDelivery !== undefined,
        timing: args.timing,
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
        return insertRunLifecycleMarker(
          {
            db: args.db,
            runId: args.runId,
            threadId: args.chatThread.chatThreadId,
            userId: args.chatThread.userId,
            orgId: args.chatThread.orgId,
            event: "completed",
            slackDelivery: args.slackDelivery,
            feishuDelivery: args.feishuDelivery,
            teamsDelivery: args.teamsDelivery,
            discordDelivery: args.discordDelivery,
            telegramDelivery: args.telegramDelivery,
            agentphoneDelivery: args.agentphoneDelivery,
            sourceCallbackId: args.sourceCallbackId,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (inserted.outcome === "duplicate") {
      return inserted;
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
      outcome: inserted.outcome,
      slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
      feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
      teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
      discordReply: inserted.discordReply,
      telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    };
  },
);

const runCompletedChatCallbackSideEffects$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    // The post-processing steps are mutually independent. Run them after queued
    // auto-send so LLM/push latency does not delay the next run.
    const saveSummaryStep = set(
      saveRunSummary$,
      {
        runId: args.runId,
        triggerSource: "chat",
        prompt: args.run.prompt,
        resultText: args.lastResultText ?? "",
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
      followupsStep,
      pushStep,
    ]);
    signal.throwIfAborted();
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
  },
);

const handleFailedChatCallback$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly chatThread: ChatThreadForRunRow;
      readonly errorMessage: string;
      readonly failureReason: RunFailureReasonToken | null;
      readonly hasCancellationRecoveryState: boolean;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<FailedChatCallbackResult> => {
    const lifecycleEvent =
      args.errorMessage.trim().toLowerCase() === "run cancelled"
        ? "cancelled"
        : "failed";
    const displayErrorMessage = await set(
      formatRunErrorForRunOwner$,
      {
        chatThreadId: args.chatThread.chatThreadId,
        runId: args.runId,
        errorMessage: args.errorMessage,
      },
      signal,
    );
    signal.throwIfAborted();
    return await insertAssistantErrorEvent(
      {
        db: args.db,
        runId: args.runId,
        threadId: args.chatThread.chatThreadId,
        userId: args.chatThread.userId,
        orgId: args.chatThread.orgId,
        lifecycleEvent,
        failureReason: args.failureReason,
        hasCancellationRecoveryState: args.hasCancellationRecoveryState,
        displayErrorMessage,
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        teamsDelivery: args.teamsDelivery,
        discordDelivery: args.discordDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        sourceCallbackId: args.sourceCallbackId,
      },
      signal,
    );
  },
);

async function runFailedChatCallbackSideEffects(args: {
  readonly db: Db;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly displayErrorMessage: string;
}): Promise<void> {
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
  readonly operation: Promise<void>;
}): Promise<void> {
  await tapError(args.operation, (error) => {
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
  triggerSource: QueuedUserMessageTriggerSource,
): string {
  switch (contextType) {
    case "slack": {
      return "Slack";
    }
    case "feishu": {
      return triggerSource === "lark" ? "Lark" : "Feishu";
    }
    case "teams": {
      return "Microsoft Teams";
    }
    case "discord": {
      return "Discord";
    }
    case "telegram": {
      return "Telegram";
    }
    case "web":
    case "agent_run":
    case "agentphone": {
      return "Web Chat";
    }
    case "automation": {
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
  triggerSource: QueuedUserMessageTriggerSource,
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
    `# ${priorRunsContextLabel(contextType, triggerSource)} Run Context`,
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
          : contextType === "feishu"
            ? inArray(agentRuns.triggerSource, ["feishu", "lark"])
            : eq(
                agentRuns.triggerSource,
                queuedUserMessageTriggerSource(contextType),
              ),
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
        // A web round replays only each run's final answer, not the
        // narration of its intermediate steps.
        isWebChatContextType(contextType)
          ? or(
              chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
              inArray(
                chatEvents.seqId,
                lastRunMessageSeqIds(db, threadId, runIds),
              ),
            )
          : undefined,
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

async function buildQueuedPriorContext(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly startNewSession: boolean;
  readonly incompleteContext: string;
  readonly contextType: QueuedUserMessageContextType;
  readonly triggerSource: QueuedUserMessageTriggerSource;
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
    args.triggerSource,
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
}) {
  const piExecution = shouldUsePiExecution({
    chatThreadId: args.input.threadId,
    modelProviderType: args.modelRoute.effectiveModelProvider,
    selectedModel: args.modelRoute.modelPin.selectedModel,
    codexServiceTier: args.modelRoute.codexServiceTier,
    builtInModelRuntimeRoute: args.modelRoute.builtInModelRuntimeRoute,
  });
  return {
    piExecution,
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
  readonly eventId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly contextType: QueuedUserMessageContextType;
  readonly featureSwitchContext: FeatureSwitchContext;
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
        eventId: args.eventId,
        featureSwitchContext: args.featureSwitchContext,
        providerModelSupport: "trust-enqueued",
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
      ? await resolveBuiltInModelRuntimeRoute(
          args.db,
          selectedModel,
          modelContext.featureSwitchContext,
        )
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
  readonly expectedThreadAgentId?: string;
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
  triggerSource: QueuedUserMessageTriggerSource,
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
          expectedThreadAgentId: args.expectedThreadAgentId,
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
        triggerSource,
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
  | "discordDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
>;

interface QueuedLaunchMaterial {
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly connectorSourceId?: string;
  readonly delivery: QueuedIntegrationDeliveries;
  readonly userInfoExtras?: CreateQueuedChatRunInput["userInfoExtras"];
}

interface QueuedLaunchLoaderArgs {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  // The surface note and `# Agent Tools` must agree on every switch, so both
  // read the same override-aware context this admission already loaded.
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly contextType: QueuedUserMessageContextType;
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
}

type LaunchLoader = (
  db: Db,
  args: QueuedLaunchLoaderArgs,
  signal: AbortSignal,
) => Promise<QueuedLaunchMaterial | null>;

/**
 * Web is the only trigger source with no context table: the user typed the
 * message, so `chat_events.payload.userMessage` is the durable original fact
 * rather than a display copy of something stored elsewhere. This is the one
 * place a launch loader reads it, and it is deliberate.
 */
const loadWebQueuedLaunchMaterial: LaunchLoader = (_db, args) => {
  const triggerSource = args.contextType === "agent_run" ? "agent" : "web";
  return Promise.resolve({
    triggerSource,
    prompt: args.userMessageProjection.agentPrompt,
    appendSystemPrompt: buildWebChatAppendSystemPrompt({
      threadId: args.chatThreadId,
      incompleteContext: "",
      priorContext: "",
      context: {
        generationTemplatePrompt: "",
        computerUseHostDisplayName: null,
        triggerSource,
        agentRunSource: args.agentRunSource,
        integrationNote: resolveIntegrationNotePrompt({
          triggerSource,
          featureSwitchContext: args.featureSwitchContext,
        }),
      },
    }),
    delivery: {},
  });
};

type NativeQueuedLaunchMaterial = (
  | SlackQueuedLaunchMaterial
  | FeishuQueuedLaunchMaterial
  | TeamsQueuedLaunchMaterial
  | DiscordQueuedLaunchMaterial
  | AgentPhoneQueuedLaunchMaterial
  | TelegramQueuedLaunchMaterial
) & {
  readonly connectorSourceId?: string;
};

function launchLoader<Material extends NativeQueuedLaunchMaterial>(
  load: (
    db: Db,
    args: QueuedLaunchLoaderArgs,
    signal: AbortSignal,
  ) => Promise<Material | null>,
  launch: (
    material: Material,
  ) => Pick<QueuedLaunchMaterial, "triggerSource" | "delivery">,
): LaunchLoader {
  return async (db, args, signal) => {
    const material = await load(db, args, signal);
    if (!material) {
      return null;
    }
    return {
      prompt: material.prompt,
      appendSystemPrompt: material.appendSystemPrompt,
      ...launch(material),
      ...(material.userInfoExtras
        ? { userInfoExtras: material.userInfoExtras }
        : {}),
      ...(material.connectorSourceId
        ? { connectorSourceId: material.connectorSourceId }
        : {}),
    };
  };
}

const resolveQueuedLaunchMaterial$ = command(
  async (
    { set },
    args: CreateQueuedChatRunInputArgs & {
      readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<QueuedLaunchMaterial> => {
    const contextType = args.queuedMessage.contextType;
    const source: QueuedLaunchLoaderArgs = {
      eventId: args.queuedMessage.id,
      chatThreadId: args.threadId,
      orgId: args.agent.orgId,
      userId: args.userId,
      featureSwitchContext: args.featureSwitchContext,
      contextType: args.queuedMessage.contextType,
      userMessageProjection: args.userMessageProjection,
      agentRunSource: agentRunSourceAnnotation(args.queuedMessage.userMessage),
    };
    let load: LaunchLoader;
    switch (contextType) {
      case "web":
      case "agent_run": {
        load = loadWebQueuedLaunchMaterial;
        break;
      }
      case "slack": {
        load = launchLoader(loadSlackQueuedLaunchMaterial, (material) => {
          return {
            triggerSource: "slack",
            delivery: { slackDelivery: material.slackDelivery },
          };
        });
        break;
      }
      case "feishu": {
        load = launchLoader(loadFeishuQueuedLaunchMaterial, (material) => {
          return {
            triggerSource: material.triggerSource,
            delivery: { feishuDelivery: material.feishuDelivery },
          };
        });
        break;
      }
      case "teams": {
        load = launchLoader(loadTeamsQueuedLaunchMaterial, (material) => {
          return {
            triggerSource: "teams",
            delivery: { teamsDelivery: material.teamsDelivery },
          };
        });
        break;
      }
      case "discord": {
        const material = await set(
          loadDiscordQueuedLaunchMaterial$,
          args.db,
          source,
          signal,
        );
        if (!material) {
          throw new DiscordQueuedLaunchUnavailableError();
        }
        return {
          triggerSource: "discord",
          prompt: material.prompt,
          appendSystemPrompt: material.appendSystemPrompt,
          delivery: { discordDelivery: material.discordDelivery },
        };
      }
      case "telegram": {
        load = launchLoader(loadTelegramQueuedLaunchMaterial, (material) => {
          return {
            triggerSource: "telegram",
            delivery: { telegramDelivery: material.telegramDelivery },
          };
        });
        break;
      }
      case "agentphone": {
        load = launchLoader(loadAgentPhoneQueuedLaunchMaterial, (material) => {
          return {
            triggerSource: "agentphone",
            delivery: { agentphoneDelivery: material.agentphoneDelivery },
          };
        });
        break;
      }
      case "automation": {
        return unreachableQueuedMessageContext(contextType);
      }
      default: {
        return unreachableQueuedContextType(contextType);
      }
    }
    const material = await load(args.db, source, signal);
    if (material) {
      return material;
    }
    throw new Error(
      `${contextType} queue item is missing authorized launch routing`,
    );
  },
);

function queuedIntegrationDeliveries(
  launchMaterial: QueuedLaunchMaterial,
): QueuedIntegrationDeliveries {
  return launchMaterial.delivery;
}

function unreachableQueuedContextType(contextType: never): never {
  throw new Error(`Unsupported queued context type: ${String(contextType)}`);
}

function unreachableQueuedMessageContext(
  contextType: Extract<QueuedUserMessageContextType, "automation">,
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
  return channelQueuedMessageAdmissionFailure(
    {
      orgId: args.agent.orgId,
      userId: args.userId,
      agentId: args.agent.id,
      threadId: args.threadId,
      queuedMessage: args.queuedMessage,
      triggerSource: launchMaterial.triggerSource,
      error,
    },
    launchMaterial.delivery,
  );
}

/** A queued message whose run creation was rejected for a reason other than capacity. */
function rejectedQueuedRunAdmissionFailure(
  input: CreateQueuedChatRunInput,
  error: QueuedMessageModelRouteError,
): QueuedMessageAdmissionFailure {
  return channelQueuedMessageAdmissionFailure(
    {
      orgId: input.orgId,
      userId: input.userId,
      agentId: input.agentId,
      threadId: input.threadId,
      queuedMessage: input.queuedMessage,
      triggerSource: input.triggerSource,
      error,
    },
    input,
  );
}

function channelQueuedMessageAdmissionFailure(
  common: Omit<WebQueuedMessageAdmissionFailure, "kind"> & {
    readonly agentId: string;
  },
  delivery: Pick<
    CreateQueuedChatRunInput,
    | "slackDelivery"
    | "feishuDelivery"
    | "teamsDelivery"
    | "discordDelivery"
    | "telegramDelivery"
    | "agentphoneDelivery"
  >,
): QueuedMessageAdmissionFailure {
  const contextType = common.queuedMessage.contextType;
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
          delivery.slackDelivery,
          contextType,
        ),
      };
    }
    case "feishu": {
      return {
        kind: "feishu_admission_failure",
        ...common,
        feishuDelivery: requiredQueuedDelivery(
          delivery.feishuDelivery,
          contextType,
        ),
      };
    }
    case "teams": {
      return {
        kind: "teams_admission_failure",
        ...common,
        teamsDelivery: requiredQueuedDelivery(
          delivery.teamsDelivery,
          contextType,
        ),
      };
    }
    case "discord": {
      return {
        kind: "discord_admission_failure",
        ...common,
        discordDelivery: requiredQueuedDelivery(
          delivery.discordDelivery,
          contextType,
        ),
      };
    }
    case "telegram": {
      return {
        kind: "telegram_admission_failure",
        ...common,
        telegramDelivery: requiredQueuedDelivery(
          delivery.telegramDelivery,
          contextType,
        ),
      };
    }
    case "agentphone": {
      return {
        kind: "agentphone_admission_failure",
        ...common,
        agentphoneDelivery: requiredQueuedDelivery(
          delivery.agentphoneDelivery,
          contextType,
        ),
      };
    }
    case "automation": {
      return unreachableQueuedMessageContext(contextType);
    }
    default: {
      return unreachableQueuedContextType(contextType);
    }
  }
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
  readonly userMessageProjection: ReturnType<typeof projectUserMessage>;
  readonly mountedUserPresentationTemplateIds: readonly string[];
  readonly mountedUserTemplates: readonly MountedUserTemplate[];
}) {
  return measureChatCallbackPreCreateTiming(
    args.input.timing,
    "api_dispatch_pre_create_agent_chat_callback_auto_send_resolve_template_context",
    "nested",
    () => {
      return buildGenerationTemplatesPrompt(
        args.userMessageProjection.templates,
        {
          mountedUserPresentationTemplateIds:
            args.mountedUserPresentationTemplateIds,
          mountedUserTemplates: args.mountedUserTemplates,
        },
      );
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
 * An unavailable selection rejects the input instead of silently dropping
 * templates the user explicitly requested.
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
}): Promise<
  | {
      readonly generationTemplatePrompt: string;
      readonly generationTemplateIdentities: readonly GenerationTemplateIdentity[];
      readonly presentationTemplateVolumes: readonly PresentationTemplateVolume[];
    }
  | {
      readonly error: {
        readonly code: "BAD_REQUEST";
        readonly message: string;
      };
    }
> {
  const selectedTemplates = args.userMessageProjection.templates;
  const mountedUserPresentationTemplateIds =
    await authorizedUserPresentationTemplateIds(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      templateIds: selectedUserPresentationTemplateIds(selectedTemplates),
    });
  const mountedUserTemplates = await authorizedUserTemplates(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    templateIds: selectedUserTemplateIds(selectedTemplates),
    enabled: isFeatureEnabled(
      FeatureSwitchKey.CustomTemplates,
      args.featureSwitchContext,
    ),
  });
  const generationTemplates =
    await resolveQueuedMessageGenerationTemplatePrompt({
      input: args.input,
      userMessageProjection: args.userMessageProjection,
      mountedUserPresentationTemplateIds,
      mountedUserTemplates,
    });
  if (generationTemplates.status === "invalid") {
    return {
      error: { code: "BAD_REQUEST", message: generationTemplates.message },
    };
  }
  return {
    generationTemplatePrompt: generationTemplates.prompt,
    generationTemplateIdentities: selectedTemplates.map(
      generationTemplateIdentity,
    ),
    // Both catalogs can be selected in one message while the tables are
    // separate, so the run carries whichever packages it was actually given.
    presentationTemplateVolumes: [
      ...userPresentationTemplateVolumes(mountedUserPresentationTemplateIds),
      ...userTemplateVolumes(mountedUserTemplates),
    ],
  };
}

const loadQueuedChatRunContext$ = command(
  async ({ set }, args: CreateQueuedChatRunInputArgs, signal: AbortSignal) => {
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      args.db,
      args.agent.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    const modelRouteResolution = await resolveQueuedMessageModelRoute({
      eventId: args.queuedMessage.id,
      db: args.db,
      threadId: args.threadId,
      userId: args.userId,
      orgId: args.agent.orgId,
      contextType: args.queuedMessage.contextType,
      featureSwitchContext,
      timing: args.timing,
    });
    signal.throwIfAborted();
    const userMessageProjection = queuedUserMessageProjection(
      args.queuedMessage.userMessage,
    );
    const launchMaterial = await set(
      resolveQueuedLaunchMaterial$,
      { ...args, userMessageProjection, featureSwitchContext },
      signal,
    );
    return {
      featureSwitchContext,
      modelRouteResolution,
      userMessageProjection,
      launchMaterial,
    };
  },
);

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

function queuedIntegrationLaunchFields(
  launchMaterial: QueuedLaunchMaterial,
  agentId: string,
) {
  const delivery = queuedIntegrationDeliveries(launchMaterial);
  return {
    ...delivery,
    ...(delivery.telegramDelivery
      ? { telegramDelivery: { ...delivery.telegramDelivery, agentId } }
      : {}),
    ...(delivery.agentphoneDelivery
      ? { agentphoneDelivery: { ...delivery.agentphoneDelivery, agentId } }
      : {}),
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

const buildCreateQueuedChatRunInput$ = command(
  async (
    { set },
    args: CreateQueuedChatRunInputArgs,
    signal: AbortSignal,
  ): Promise<CreateQueuedChatRunInput | QueuedMessageAdmissionFailure> => {
    const {
      featureSwitchContext,
      modelRouteResolution,
      userMessageProjection,
      launchMaterial,
    } = await set(loadQueuedChatRunContext$, args, signal);
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
    const { piExecution, routedModel } = routeQueuedMessagePiExecution({
      input: args,
      modelRoute,
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
      await loadQueuedMessageSessionContext(
        args,
        routedModel,
        launchMaterial.triggerSource,
      );
    signal.throwIfAborted();
    const templateContext = await resolveQueuedMessageTemplateContext({
      db: args.db,
      orgId: args.agent.orgId,
      userId: args.userId,
      input: args,
      userMessageProjection,
      featureSwitchContext,
    });
    signal.throwIfAborted();
    if ("error" in templateContext) {
      return queuedMessageAdmissionFailure(
        args,
        launchMaterial,
        templateContext.error,
      );
    }
    const {
      generationTemplatePrompt,
      generationTemplateIdentities,
      presentationTemplateVolumes,
    } = templateContext;
    const computerUseHostGrant =
      await resolveQueuedMessageComputerUseHostGrant(args);
    signal.throwIfAborted();
    const prompt = queuedMessagePrompt({
      launchMaterial,
    });
    return {
      orgId: args.agent.orgId,
      userId: args.userId,
      agentId: args.agent.id,
      expectedThreadAgentId: args.expectedThreadAgentId,
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
      triggerSource: launchMaterial.triggerSource,
      realAgentInPreview: isFeatureEnabled(
        FeatureSwitchKey.RealAgentInPreview,
        featureSwitchContext,
      ),
      captureNetworkBodies: await chatNetworkBodyCaptureRequested(
        args.db,
        args.queuedMessage.id,
      ),
      ...queuedIntegrationLaunchFields(launchMaterial, args.agent.id),
      autonomyBudget: args.queuedMessage.autonomyBudget.autonomyBudget,
    };
  },
);

interface QueuedAdmissionFailureDelivery {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
}

type QueuedAdmissionFailureChannel = QueuedAdmissionFailureDelivery &
  (
    | {
        readonly kind: "Slack";
        readonly agentId: string;
        readonly target: SlackDeliveryTarget;
      }
    | { readonly kind: "Feishu"; readonly target: FeishuDeliveryTarget }
    | {
        readonly kind: "Teams";
        readonly agentId: string;
        readonly target: TeamsDeliveryTarget;
      }
    | { readonly kind: "Discord"; readonly target: DiscordDeliveryTarget }
    | {
        readonly kind: "Telegram";
        readonly agentId: string;
        readonly target: TelegramDeliveryTarget;
      }
    | {
        readonly kind: "AgentPhone";
        readonly agentId: string;
        readonly target: AgentPhoneDeliveryTarget;
      }
  );

/** Web admissions have no integration delivery. */
function queuedAdmissionFailureChannel(
  failure: QueuedMessageAdmissionFailure,
): QueuedAdmissionFailureChannel | undefined {
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
        ...base,
        kind: "Slack",
        agentId: failure.agentId,
        target: failure.slackDelivery,
      };
    }
    case "feishu_admission_failure": {
      return { ...base, kind: "Feishu", target: failure.feishuDelivery };
    }
    case "teams_admission_failure": {
      return {
        ...base,
        kind: "Teams",
        agentId: failure.agentId,
        target: failure.teamsDelivery,
      };
    }
    case "discord_admission_failure": {
      return { ...base, kind: "Discord", target: failure.discordDelivery };
    }
    case "telegram_admission_failure": {
      return {
        ...base,
        kind: "Telegram",
        agentId: failure.agentId,
        target: failure.telegramDelivery,
      };
    }
    case "agentphone_admission_failure": {
      return {
        ...base,
        kind: "AgentPhone",
        agentId: failure.agentId,
        target: failure.agentphoneDelivery,
      };
    }
    default: {
      return unreachableQueuedAdmissionFailure(failure);
    }
  }
}

const sendQueuedAdmissionFailure$ = command(
  async (
    { set },
    channel: QueuedAdmissionFailureChannel,
    chatEventId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const base = {
      db,
      chatThreadId: channel.chatThreadId,
      orgId: channel.orgId,
      userId: channel.userId,
      chatEventId,
    };
    switch (channel.kind) {
      case "Slack": {
        await deliverSlackChatAdmissionFailure(
          { ...base, agentId: channel.agentId, ...channel.target },
          signal,
        );
        return;
      }
      case "Feishu": {
        await deliverFeishuChatAdmissionFailure(
          { ...base, target: channel.target },
          signal,
        );
        return;
      }
      case "Teams": {
        await deliverTeamsChatAdmissionFailure(
          { ...base, agentId: channel.agentId, target: channel.target },
          signal,
        );
        return;
      }
      case "Discord": {
        await set(
          sendDiscordChatReply$,
          db,
          { ...base, target: channel.target },
          signal,
        );
        return;
      }
      case "Telegram": {
        await deliverTelegramChatAdmissionFailure(
          { ...base, target: channel.target },
          signal,
        );
        return;
      }
      case "AgentPhone": {
        await deliverAgentPhoneChatAdmissionFailure(
          { ...base, agentId: channel.agentId, target: channel.target },
          signal,
        );
        return;
      }
    }
  },
);

const deliverQueuedAdmissionFailureToChannel$ = command(
  async (
    { set },
    channel: QueuedAdmissionFailureChannel,
    chatEventId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await tapError(
      set(sendQueuedAdmissionFailure$, channel, chatEventId, signal),
      (error) => {
        log.warn(
          `Failed to deliver canonical ${channel.kind} admission error`,
          {
            threadId: channel.chatThreadId,
            error,
          },
        );
      },
    );
    signal.throwIfAborted();
    if (channel.kind !== "Feishu") {
      return;
    }
    await tapError(
      clearCanonicalFeishuThinkingReaction(
        set(writeDb$),
        channel.target,
        signal,
      ),
      (error) => {
        log.warn(
          `Failed to clear ${channel.kind} admission thinking reaction`,
          {
            threadId: channel.chatThreadId,
            error,
          },
        );
      },
    );
  },
);

function unreachableQueuedAdmissionFailure(failure: never): never {
  throw new Error(`Unsupported queued admission failure: ${String(failure)}`);
}

export interface QueuedPromptLaunchContext {
  readonly userId: string;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly runInput: CreateQueuedChatRunInput;
}

export const recordQueuedPromptRunLaunch$ = command(
  ({ set }, args: QueuedPromptLaunchContext, runId: string): void => {
    const db = set(writeDb$);
    const { userId, runInput } = args;
    const threadId = runInput.threadId;
    // Only a launched run counts as template use; an unclaimed head may retry.
    logTemplateUsage(
      {
        dispatchPath: "queued-claim",
        orgId: runInput.orgId,
        userId,
        chatThreadId: threadId,
      },
      runInput.generationTemplateIdentities,
    );
    scheduleChatThreadTitleGeneration({
      db,
      threadId,
      userId,
      orgId: runInput.orgId,
      prompt: runInput.prompt,
      includePriorRounds: true,
    });
    if (runInput.discordDelivery) {
      set(scheduleDiscordRunTyping$, db, {
        runId,
        chatThreadId: threadId,
        target: runInput.discordDelivery,
      });
    }
    args.timing.flush(runId, runInput.triggerSource);
  },
);

async function readTerminalChatCallbackRun(db: Db, runId: string) {
  const [run] = await db
    .select({
      threadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run;
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
      modelProvider: agentRuns.modelProvider,
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

const prepareCompletedTerminalChatCallbackWork$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly timing: ChatCallbackPreCreateTimingCollector;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackWork> => {
    const completed = await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_agent_chat_callback_prepare_completed",
      "top_level",
      () => {
        return set(handleCompletedChatCallback$, args, signal);
      },
    );
    signal.throwIfAborted();
    if (completed.outcome !== "written" && completed.outcome !== "replayed") {
      return completed;
    }

    return {
      outcome: completed.outcome,
      slackDeliveryCallbackId: completed.slackDeliveryCallbackId,
      feishuDeliveryCallbackId: completed.feishuDeliveryCallbackId,
      teamsDeliveryCallbackId: completed.teamsDeliveryCallbackId,
      discordReply: completed.discordReply,
      telegramDeliveryCallbackId: completed.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: completed.agentphoneDeliveryCallbackId,
      runFinishedEvent: {
        chatThreadId: args.chatThread.chatThreadId,
        runId: args.runId,
        sourceCallbackId: args.sourceCallbackId,
        runStatus: "completed",
        lastResultText: completed.lastResultText,
        sourceAgentId: args.chatThread.agentId,
        sourceThreadTitle: args.chatThread.title,
      },
      deferredSideEffects: {
        status: "completed",
        run: args.run,
        lastResultText: completed.lastResultText,
        followupContext: completed.followupContext,
      },
    };
  },
);

const prepareFailedTerminalChatCallbackWork$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly errorMessage: string;
      readonly timing: ChatCallbackPreCreateTimingCollector;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackWork> => {
    const failed = await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_agent_chat_callback_prepare_failed",
      "top_level",
      () => {
        return set(
          handleFailedChatCallback$,
          {
            ...args,
            failureReason:
              args.run.failureReason === "provider_insufficient_credits"
                ? (publicProviderBalanceFailureReason(args.run.modelProvider) ??
                  null)
                : args.run.failureReason,
            hasCancellationRecoveryState:
              args.run.cancellationRecoveryCompleted !== null,
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (failed.outcome !== "written" && failed.outcome !== "replayed") {
      return failed;
    }

    return {
      outcome: failed.outcome,
      slackDeliveryCallbackId: failed.slackDeliveryCallbackId,
      feishuDeliveryCallbackId: failed.feishuDeliveryCallbackId,
      teamsDeliveryCallbackId: failed.teamsDeliveryCallbackId,
      discordReply: failed.discordReply,
      telegramDeliveryCallbackId: failed.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: failed.agentphoneDeliveryCallbackId,
      runFinishedEvent: {
        chatThreadId: args.chatThread.chatThreadId,
        runId: args.runId,
        sourceCallbackId: args.sourceCallbackId,
        runStatus:
          args.errorMessage.trim().toLowerCase() === "run cancelled"
            ? "cancelled"
            : "failed",
        // Failed runs surface their error separately; patterns only ever
        // match assistant output, so terminal errors carry no matchable text.
        lastResultText: null,
        sourceAgentId: args.chatThread.agentId,
        sourceThreadTitle: args.chatThread.title,
      },
      deferredSideEffects: {
        status: "failed",
        run: args.run,
        displayErrorMessage: failed.displayErrorMessage,
      },
    };
  },
);

async function clearSlackThreadStatusAfterTerminalCallback(
  args: {
    readonly db: Db;
    readonly chatThreadId: string;
    readonly slackDelivery: SlackDeliveryTarget | undefined;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.slackDelivery) {
    return;
  }
  await tapError(
    clearCanonicalSlackThreadStatusIfIdle(
      args.db,
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
    readonly db: Db;
    readonly feishuDelivery: FeishuDeliveryTarget | undefined;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.feishuDelivery) {
    return;
  }
  await tapError(
    clearCanonicalFeishuThinkingReaction(args.db, args.feishuDelivery, signal),
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
    readonly callback: TerminalChatCallbackArgs;
    readonly error: unknown;
    readonly persistedThreadId: string | undefined;
  },
  signal: AbortSignal,
): Promise<never> {
  // Join the cleanup within the existing owner, including its abort. A
  // secondary cleanup failure must never replace the original load/capture
  // error.
  const cleared = await settleIncludingAbort(
    clearTerminalIntegrationStatus(
      args.callback,
      args.persistedThreadId ?? args.callback.payload.threadId,
      signal,
    ),
  );
  if (!cleared.ok) {
    log.error(
      "Failed to clear integration status after terminal callback error",
      {
        runId: args.callback.callback.runId,
        error: cleared.error,
      },
    );
  }
  throw args.error;
}

const dispatchCanonicalDeliveryCallbacks$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly status: "completed" | "failed";
      readonly slackDeliveryCallbackId: string | undefined;
      readonly feishuDeliveryCallbackId: string | undefined;
      readonly teamsDeliveryCallbackId: string | undefined;
      readonly discordReply: DiscordReplyRequest | undefined;
      readonly telegramDeliveryCallbackId: string | undefined;
      readonly agentphoneDeliveryCallbackId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
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
          return dispatchSlackChatDeliveryOnce(
            args.db,
            callbackId,
            dispatchSignal,
          );
        },
      },
      {
        name: "Feishu",
        callbackId: args.feishuDeliveryCallbackId,
        dispatch: (callbackId, dispatchSignal) => {
          return dispatchFeishuChatDeliveryOnce(
            args.db,
            callbackId,
            dispatchSignal,
          );
        },
      },
      {
        name: "Teams",
        callbackId: args.teamsDeliveryCallbackId,
        dispatch: (callbackId, dispatchSignal) => {
          return dispatchTeamsChatDeliveryOnce(
            args.db,
            callbackId,
            dispatchSignal,
          );
        },
      },
      {
        name: "Telegram",
        callbackId: args.telegramDeliveryCallbackId,
        dispatch: (callbackId, dispatchSignal) => {
          return dispatchTelegramChatDeliveryOnce(
            args.db,
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
          return dispatchAgentPhoneChatDeliveryOnce(
            args.db,
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
      const delivery = await settle(
        channel.dispatch(callbackId, signal),
        signal,
      );
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
    if (args.discordReply) {
      await set(sendDiscordChatReply$, args.db, args.discordReply, signal);
    }
  },
);

interface TerminalChatCallbackArgs {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly payload: ChatCallbackPayload;
}

function terminalIntegrationDeliveries(
  payload: ChatCallbackPayload,
): Pick<
  ChatCallbackPayload,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "discordDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
> {
  return {
    slackDelivery: payload.slackDelivery,
    feishuDelivery: payload.feishuDelivery,
    teamsDelivery: payload.teamsDelivery,
    discordDelivery: payload.discordDelivery,
    telegramDelivery: payload.telegramDelivery,
    agentphoneDelivery: payload.agentphoneDelivery,
  };
}

const releaseManagedBrowsersForTerminalCallback$ = command(
  async (
    { set },
    args: TerminalChatCallbackArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    // The window stays live after the run so the user can keep using it; this only
    // restarts its idle lease. Browser resources outlive thread deletion, so use
    // the callback payload rather than loading the thread first.
    const released = await settle(
      set(
        releaseThreadBrowsersForRun$,
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
  },
);

async function clearTerminalIntegrationStatus(
  args: TerminalChatCallbackArgs,
  chatThreadId: string,
  signal: AbortSignal,
): Promise<void> {
  await clearSlackThreadStatusAfterTerminalCallback(
    {
      db: args.db,
      chatThreadId,
      slackDelivery: args.payload.slackDelivery,
    },
    signal,
  );
  await clearFeishuThinkingAfterTerminalCallback(
    {
      db: args.db,
      feishuDelivery: args.payload.feishuDelivery,
    },
    signal,
  );
}

const finishTerminalChatCallbackAfterProjection$ = command(
  async (
    { set },
    args: {
      readonly callback: TerminalChatCallbackArgs;
      readonly runId: string;
      readonly callbackStatus: "completed" | "failed";
      readonly work: TerminalChatCallbackWork;
      readonly chatThread: ChatThreadForRunRow;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchCanonicalDeliveryCallbacks$,
      {
        db: args.callback.db,
        runId: args.runId,
        status: args.callbackStatus,
        slackDeliveryCallbackId: args.work.slackDeliveryCallbackId,
        feishuDeliveryCallbackId: args.work.feishuDeliveryCallbackId,
        teamsDeliveryCallbackId: args.work.teamsDeliveryCallbackId,
        discordReply: args.work.discordReply,
        telegramDeliveryCallbackId: args.work.telegramDeliveryCallbackId,
        agentphoneDeliveryCallbackId: args.work.agentphoneDeliveryCallbackId,
      },
      signal,
    );

    // Integration status clears keep their established detached owner: they
    // must neither hold the completion ACK nor be cancelled with its request.
    // The thread's queue is woken by whoever releases the run's active slot.
    waitUntil(
      clearTerminalIntegrationStatus(
        args.callback,
        args.chatThread.chatThreadId,
        new AbortController().signal,
      ),
    );

    // A committed marker must not acknowledge an unfinished automation. Throw
    // back to the existing callback owner so its failed/pending row can retry.
    if (args.work.runFinishedEvent) {
      await set(
        dispatchConfiguredChatRunFinishedEvent$,
        args.work.runFinishedEvent,
        signal,
      );
    }
    signal.throwIfAborted();

    // Scheduling is the last step, so a replay after an earlier attempt threw
    // must schedule it. The source callback has no attempt claim: a replay can
    // also follow an attempt that reached this point but failed its final
    // acknowledgement, or overlap a concurrent redrive. That residual is
    // at-least-once for summary, follow-up generation and push.
    const deferredSideEffects = args.work.deferredSideEffects;
    if (
      deferredSideEffects &&
      (args.work.outcome === "written" || args.work.outcome === "replayed")
    ) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        runTerminalChatCallbackSideEffects({
          runId: args.runId,
          status: args.callbackStatus,
          operation:
            deferredSideEffects.status === "completed"
              ? set(
                  runCompletedChatCallbackSideEffects$,
                  {
                    db: args.callback.db,
                    runId: args.runId,
                    chatThread: args.chatThread,
                    run: deferredSideEffects.run,
                    lastResultText: deferredSideEffects.lastResultText,
                    followupContext: deferredSideEffects.followupContext,
                  },
                  backgroundSignal,
                )
              : runFailedChatCallbackSideEffects({
                  db: args.callback.db,
                  run: deferredSideEffects.run,
                  chatThread: args.chatThread,
                  displayErrorMessage: deferredSideEffects.displayErrorMessage,
                }),
        }),
      );
    }
  },
);

async function terminalChatCallbackSourceId(
  args: TerminalChatCallbackArgs,
): Promise<string> {
  // Queue launch failure callbacks carry the run identity before they have
  // an envelope callback ID. Resolve their existing persisted owner exactly
  // as delivery registration does; terminal work must never lose its receipt.
  return (
    await requireSourceChatCallback({
      db: args.db,
      runId: args.callback.runId,
      sourceCallbackId: args.callback.callbackId,
    })
  ).id;
}

const processTerminalChatCallback$ = command(
  async (
    { set },
    args: TerminalChatCallbackArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const { runId, status: callbackStatus } = args.callback;
    if (callbackStatus === "progress") {
      return;
    }
    const timing = new ChatCallbackPreCreateTimingCollector();

    await set(releaseManagedBrowsersForTerminalCallback$, args, signal);

    let persistedThreadId: string | undefined;
    const prepared = await settle(
      (async () => {
        const loaded = await measureChatCallbackPreCreateTiming(
          timing,
          "api_dispatch_pre_create_agent_chat_callback_load_terminal",
          "top_level",
          async () => {
            const existing = await readTerminalChatCallbackRun(args.db, runId);
            signal.throwIfAborted();
            if (!existing?.threadId || existing.triggerSource === null) {
              return null;
            }
            // Retain only a content-free persisted locator across capture failure.
            persistedThreadId = existing.threadId;
            return await loadTerminalChatCallback(
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
          return null;
        }
        const { run, chatThread } = loaded;
        const sourceCallbackId = await terminalChatCallbackSourceId(args);
        signal.throwIfAborted();
        const preparation = {
          db: args.db,
          runId,
          run,
          chatThread,
          timing,
          ...terminalIntegrationDeliveries(args.payload),
          sourceCallbackId,
        };
        const work = await (callbackStatus === "completed"
          ? set(prepareCompletedTerminalChatCallbackWork$, preparation, signal)
          : set(
              prepareFailedTerminalChatCallbackWork$,
              {
                ...preparation,
                errorMessage: terminalCallbackErrorMessage(
                  args.callback.error,
                  run.error,
                ),
              },
              signal,
            ));
        return { work, chatThread };
      })(),
      signal,
    );
    if (!prepared.ok) {
      return await handleTerminalChatCallbackPreparationFailure(
        { callback: args, error: prepared.error, persistedThreadId },
        signal,
      );
    }
    if (!prepared.value) {
      await clearTerminalIntegrationStatus(
        args,
        persistedThreadId ?? args.payload.threadId,
        signal,
      );
      return;
    }
    const { work, chatThread } = prepared.value;
    await set(
      finishTerminalChatCallbackAfterProjection$,
      { callback: args, runId, callbackStatus, work, chatThread },
      signal,
    );
  },
);

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

const dispatchQueuedChatFailedRunCallbacks$: DispatchFailedRunCallbacks =
  command(async ({ set }, input, signal) => {
    if (!(await claimedUserMessageExistsForRun(input.db, input.runId))) {
      return;
    }
    signal.throwIfAborted();
    const callback = input.callbacks.find((item) => {
      return "internalKind" in item && item.internalKind === "chat";
    });
    if (!callback || !("internalKind" in callback)) {
      throw new Error("Queued chat launch is missing its callback payload");
    }
    const parsed = chatCallbackPayloadSchema.safeParse(callback.payload);
    if (!parsed.success) {
      throw new Error("Queued chat launch is missing its callback payload");
    }
    const payload = parsed.data;
    await set(
      processTerminalChatCallback$,
      {
        db: input.db,
        callback: {
          runId: input.runId,
          status: "failed",
          error: input.error,
          payload,
        },
        payload,
      },
      signal,
    );
  });

const processChatInternalCallback$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly callback: InternalRunCallbackEnvelope;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly success: true }
    | { readonly success: false; readonly error: string }
  > => {
    const payload = chatCallbackPayloadSchema.safeParse(args.callback.payload);
    if (!payload.success) {
      return {
        success: false,
        error: "Invalid or missing payload",
      };
    }

    if (args.callback.status === "progress") {
      if (payload.data.discordDelivery) {
        set(scheduleDiscordRunTyping$, args.db, {
          runId: args.callback.runId,
          chatThreadId: payload.data.threadId,
          target: payload.data.discordDelivery,
        });
      }
      if (payload.data.slackDelivery) {
        const backgroundSignal = new AbortController().signal;
        waitUntil(
          tapError(
            refreshCanonicalSlackThreadStatus(
              args.db,
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
    const processingInput = {
      db: args.db,
      callback: args.callback,
      payload: payload.data,
    };
    // Keep required terminal work within the persisted source callback's retry
    // lifetime. Each event, delivery registration and automation commits alone.
    await set(processTerminalChatCallback$, processingInput, signal);

    return { success: true };
  },
);

function queuedMessageRejection(
  failure: QueuedMessageAdmissionFailure,
): ChatQueueHeadRejection {
  const channel = queuedAdmissionFailureChannel(failure);
  return {
    error: failure.error,
    userId: failure.userId,
    ...(channel ? { delivery: { kind: "channel" as const, channel } } : {}),
  };
}

type QueuedRejectionHead = Pick<
  ChatQueueHeadContext,
  "id" | "chatThreadId" | "orgId" | "userId" | "agentId" | "contextType"
>;

/** Data for a static delivery command; it never captures a Store. */
export type QueuedPromptRejectionTarget =
  | { readonly kind: "source"; readonly head: QueuedRejectionHead }
  | {
      readonly kind: "channel";
      readonly channel: QueuedAdmissionFailureChannel;
    };

const loadQueuedRejectionChannel$ = command(
  async (
    { set },
    head: QueuedRejectionHead,
    signal: AbortSignal,
  ): Promise<QueuedAdmissionFailureChannel | undefined> => {
    const contextType = head.contextType;
    if (
      contextType !== "slack" &&
      contextType !== "feishu" &&
      contextType !== "teams" &&
      contextType !== "discord" &&
      contextType !== "telegram" &&
      contextType !== "agentphone"
    ) {
      return undefined;
    }
    const db = set(writeDb$);
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      head.orgId,
      head.userId,
    );
    signal.throwIfAborted();
    const source = {
      eventId: head.id,
      chatThreadId: head.chatThreadId,
      orgId: head.orgId,
      userId: head.userId,
      featureSwitchContext,
    };
    const delivery = {
      chatThreadId: head.chatThreadId,
      orgId: head.orgId,
      userId: head.userId,
      agentId: head.agentId,
    };
    switch (contextType) {
      case "slack": {
        const material = await loadSlackQueuedLaunchMaterial(db, source);
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Slack", target: material.slackDelivery }
          : undefined;
      }
      case "feishu": {
        const material = await loadFeishuQueuedLaunchMaterial(db, source);
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Feishu", target: material.feishuDelivery }
          : undefined;
      }
      case "teams": {
        const material = await loadTeamsQueuedLaunchMaterial(db, source);
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Teams", target: material.teamsDelivery }
          : undefined;
      }
      case "discord": {
        const material = await set(
          loadDiscordQueuedLaunchMaterial$,
          db,
          source,
          signal,
        );
        return material
          ? { ...delivery, kind: "Discord", target: material.discordDelivery }
          : undefined;
      }
      case "telegram": {
        const material = await loadTelegramQueuedLaunchMaterial(db, source);
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Telegram", target: material.telegramDelivery }
          : undefined;
      }
      case "agentphone": {
        const material = await loadAgentPhoneQueuedLaunchMaterial(db, source);
        signal.throwIfAborted();
        return material
          ? {
              ...delivery,
              kind: "AgentPhone",
              target: material.agentphoneDelivery,
            }
          : undefined;
      }
    }
  },
);

export const deliverQueuedPromptRejection$ = command(
  async (
    { set },
    target: QueuedPromptRejectionTarget,
    assistantEventId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const channel =
      target.kind === "source"
        ? await set(loadQueuedRejectionChannel$, target.head, signal)
        : target.channel;
    if (channel) {
      await set(
        deliverQueuedAdmissionFailureToChannel$,
        channel,
        assistantEventId,
        signal,
      );
    }
  },
);

/** Recover authorized source routing only after an unexpected rejection commits. */
export const deliverUnexpectedQueuedPromptRejection$ = command(
  async (
    { set },
    args: {
      readonly head: QueuedRejectionHead;
      readonly assistantEventId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      deliverQueuedPromptRejection$,
      { kind: "source", head: args.head },
      args.assistantEventId,
      signal,
    );
  },
);

/**
 * The prompt assembler: build run parameters for a queued `input.prompt`
 * head from its context row (web, agent, or integration), the thread's model
 * route and session, and the message's own selections. A permanent admission
 * failure rejects the head and is delivered back to its integration.
 */
export const assembleQueuedPromptRun$ = command(
  async (
    { set },
    head: ChatQueueHeadContext,
    signal: AbortSignal,
  ): Promise<ChatQueueRunAssembly> => {
    const db = set(writeDb$);
    const timing = new ChatCallbackPreCreateTimingCollector();
    const queuedMessage = await measureChatCallbackPreCreateTiming(
      timing,
      "api_dispatch_pre_create_agent_chat_callback_auto_send_lookup_queued_message",
      "nested",
      () => {
        return loadNextUnclaimedQueuedUserMessage(db, head.chatThreadId);
      },
    );
    signal.throwIfAborted();
    if (queuedMessage?.id !== head.id) {
      return { kind: "not-ready" };
    }
    timing.recordElapsed({
      actionType:
        "api_dispatch_pre_create_agent_chat_callback_auto_send_queue_age",
      spanKind: "nested",
      startedAt: queuedMessage.createdAt.getTime(),
      finishedAt: head.apiStartTime,
    });
    const agent = await resolveIntegrationChatThreadAgent(db, head);
    signal.throwIfAborted();
    if (!agent) {
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
    const prepared = await settle(
      measureChatCallbackPreCreateTiming(
        timing,
        "api_dispatch_pre_create_agent_chat_callback_auto_send_build_input",
        "top_level",
        () => {
          return set(
            buildCreateQueuedChatRunInput$,
            {
              db,
              threadId: head.chatThreadId,
              userId: head.userId,
              agent: { id: agent.agentId, orgId: head.orgId },
              expectedThreadAgentId: agent.expectedThreadAgentId,
              queuedMessage,
              timing,
            },
            signal,
          );
        },
      ),
      signal,
    );
    if (!prepared.ok) {
      if (!(prepared.error instanceof DiscordQueuedLaunchUnavailableError)) {
        throw prepared.error;
      }
      return {
        kind: "rejected",
        rejection: {
          error: {
            code: "DISCORD_ACCESS_REVOKED",
            message: prepared.error.message,
          },
          userId: head.userId,
        },
      };
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
        ...buildQueuedCreateAgentRunArgs(
          runInput,
          head.apiStartTime,
          dispatchQueuedChatFailedRunCallbacks$,
        ),
        persistProducerRunBinding: agent.persistProducerRunBinding,
      },
      rejection: (error) => {
        return queuedMessageRejection(
          rejectedQueuedRunAdmissionFailure(runInput, error),
        );
      },
      launched: {
        kind: "prompt",
        context: { userId: head.userId, timing, runInput },
      },
    };
  },
);

export const handleChatInternalCallback$ = command(
  async (
    { set },
    input: { readonly callback: InternalRunCallbackEnvelope },
    signal: AbortSignal,
  ): Promise<
    | { readonly success: true }
    | { readonly success: false; readonly error: string }
  > => {
    const db = set(writeDb$);
    return await set(
      processChatInternalCallback$,
      {
        db,
        callback: input.callback,
      },
      signal,
    );
  },
);
