import {
  wechatDeliveryTargetSchema,
  type WechatDeliveryTarget,
} from "./wechat-chat-callback-payload";
import { loadWechatQueuedLaunchMaterial$ } from "./wechat-context.service";
import { reconcileWechatThreadTyping$ } from "./wechat-thread-typing.service";
import {
  sendWechatChatReply$,
  dispatchWechatChatDelivery$,
} from "./wechat-delivery.service";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { v5 as uuidv5 } from "uuid";
import type { ChatThreadContinuation } from "./chat-session-continuity.service";

import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";
import { publicProviderBalanceFailureReason } from "@okouai/api-contracts/contracts/run-balance-errors";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { serializeError } from "@okouai/core/log-utils";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { object, string, type infer as zInfer } from "zod";

import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { recordLastEventToComplete$ } from "./internal-chat-run-output-timing.service";
import {
  onRejection,
  settle,
  settleIncludingAbort,
  tapError,
  throwIfAbort,
} from "../utils";
import {
  agentphoneDeliveryTargetSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import { loadAgentPhoneQueuedLaunchMaterial$ } from "./agentphone-queued-launch-context.service";
import { integrationCompletionFallbackEventIdForRun } from "./assistant-event-id";
import { releaseThreadBrowsersForRun$ } from "./browser.service";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  loadCompletedRunOutput$,
  type CompletedRunOutput,
} from "./chat-event-row-read.service";
import {
  clearCanonicalSlackThreadStatusIfIdle$,
  reconcileCanonicalSlackThreadStatus$,
} from "./canonical-slack-thread-status.service";
import {
  insertAssistantEvents$,
  insertRecommendedFollowupsEvent$,
  touchChatThreadLastMessageAtIndependently$,
  type InsertAssistantEventsInput,
} from "./chat-event-shared.service";
import {
  assistantErrorEventInsertSql,
  assistantErrorEventType,
  runLifecycleMarkerEventType,
  runLifecycleMarkerInsertSql,
  integrationCompletionFallbackInsertSql,
} from "./chat-event.service";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
} from "./chat-queue-run-assembly";
import type {
  QueuedUserMessage,
  QueuedUserMessageContextType,
  QueuedUserMessageTriggerSource,
} from "./chat-queued-event.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import { dispatchConfiguredChatRunFinishedEvent$ } from "./chat-run-finished-event-dispatch.service";
import {
  canonicalDeliveryEventReadPlan,
  integrationCompletionFallbackReadPlan,
  loadTerminalChatCallback$,
  loadTerminalChatCallbackLocator$,
  requiredSourceChatCallback,
  requireSourceChatCallback$,
  runLifecycleMarkerReadPlan,
  sourceChatCallbackReadPlan,
  type ChatRunInfo,
  type ChatThreadForRunRow,
} from "./chat-run-state-read.service";
import {
  generateChatNotificationSummary,
  generateChatThreadRecommendedFollowupsFromContext,
  loadChatThreadRecommendedFollowupContext$,
  generateAndPersistChatThreadTitle$,
  type ChatCompletionContextMessage,
} from "./chat-title.service";
import {
  discordDeliveryTargetSchema,
  type DiscordDeliveryTarget,
} from "./discord-chat-callback-payload";
import { loadDiscordQueuedLaunchMaterial$ } from "./discord-queued-launch-context.service";
import { scheduleDiscordRunTyping$ } from "./discord-run-typing.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  feishuDeliveryTargetSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import {
  feishuQueuedLaunchContextReadPlan,
  feishuQueuedLaunchMaterialFromContext,
  requiredFeishuLaunchContext,
} from "./feishu-queued-launch-context.service";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";
import {
  deliverAgentPhoneChatAdmissionFailure$,
  dispatchAgentPhoneChatDeliveryOnce$,
} from "./internal-agentphone-chat-run-callback.service";
import {
  sendDiscordChatReply$,
  type DiscordReplyRequest,
} from "./internal-discord-chat-run-callback.service";
import {
  clearCanonicalFeishuThinkingReaction$,
  deliverFeishuChatAdmissionFailure$,
  dispatchFeishuChatDeliveryOnce$,
} from "./internal-feishu-chat-run-callback.service";
import type { InternalRunCallbackEnvelope } from "./internal-run-callback";
import {
  deliverSlackChatAdmissionFailure$,
  dispatchSlackChatDeliveryOnce$,
} from "./internal-slack-chat-run-callback.service";
import {
  deliverTeamsChatAdmissionFailure$,
  dispatchTeamsChatDeliveryOnce$,
} from "./internal-teams-chat-run-callback.service";
import {
  deliverTelegramChatAdmissionFailure$,
  dispatchTelegramChatDeliveryOnce$,
} from "./internal-telegram-chat-run-callback.service";
import {
  modelProviderWriteTypeForLaunch,
  type ModelFirstPin,
} from "./model-selection.service";
import { sendUserPushNotifications$ } from "./push-notifications.service";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { saveRunSummary$ } from "./run-summary.service";
import { loadSlackQueuedLaunchMaterial$ } from "./slack-queued-launch-context.service";
import {
  slackChatDeliveryFields,
  type SlackDeliveryTarget,
} from "./slack-chat-callback-payload";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import { loadTeamsQueuedLaunchMaterial$ } from "./teams-queued-launch-context.service";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import { loadTelegramQueuedLaunchMaterial$ } from "./telegram-queued-launch-context.service";

const log = logger("callback:chat");
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

const chatCallbackPayloadSchema = object({
  threadId: string(),
  agentId: string(),
  slackDelivery: object({
    workspaceId: string().optional(),
    channelId: string(),
    threadTs: string(),
    routeThreadTs: string().optional(),
  }).optional(),
  feishuDelivery: feishuDeliveryTargetSchema.optional(),
  teamsDelivery: teamsDeliveryTargetSchema.optional(),
  discordDelivery: discordDeliveryTargetSchema.optional(),
  wechatDelivery: wechatDeliveryTargetSchema.optional(),
  telegramDelivery: telegramDeliveryTargetSchema.optional(),
  agentphoneDelivery: agentphoneDeliveryTargetSchema.optional(),
}).passthrough();

type ChatCallbackPayload = zInfer<typeof chatCallbackPayloadSchema>;

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

interface CompletedChatOutputLoad extends CompletedRunOutput {
  readonly assistantItemsToInsert: readonly AssistantEventItem[];
}

interface AgentForAutoSend {
  readonly id: string;
  readonly orgId: string;
}

export interface CreateQueuedChatRunInput {
  readonly threadContinuation?: ChatThreadContinuation;
  readonly featureSwitchContext?: FeatureSwitchContext;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
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
    readonly workspaceId?: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly discordDelivery?: DiscordDeliveryTarget;
  readonly wechatDelivery?: WechatDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly autonomyBudget: number;
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
    readonly workspaceId?: string;
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

interface WechatQueuedMessageAdmissionFailure {
  readonly kind: "wechat_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly wechatDelivery: WechatDeliveryTarget;
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

export type QueuedMessageAdmissionFailure =
  | WebQueuedMessageAdmissionFailure
  | SlackQueuedMessageAdmissionFailure
  | FeishuQueuedMessageAdmissionFailure
  | TeamsQueuedMessageAdmissionFailure
  | DiscordQueuedMessageAdmissionFailure
  | WechatQueuedMessageAdmissionFailure
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
      readonly wechatDeliveryCallbackId?: string;
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
      readonly wechatDeliveryCallbackId?: string;
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
  readonly wechatDeliveryCallbackId?: string;
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

export function queuedChatRunCallbackInputs(
  input: Pick<
    CreateQueuedChatRunInput,
    | "threadId"
    | "agentId"
    | "queuedMessage"
    | "slackDelivery"
    | "feishuDelivery"
    | "teamsDelivery"
    | "discordDelivery"
    | "wechatDelivery"
    | "telegramDelivery"
    | "agentphoneDelivery"
  >,
) {
  return [
    {
      internalKind: "chat" as const,
      payload: {
        threadId: input.threadId,
        agentId: input.agentId,
        queuedMessageId: input.queuedMessage.id,
        slackDelivery: input.slackDelivery,
        feishuDelivery: input.feishuDelivery,
        teamsDelivery: input.teamsDelivery,
        discordDelivery: input.discordDelivery,
        wechatDelivery: input.wechatDelivery,
        telegramDelivery: input.telegramDelivery,
        agentphoneDelivery: input.agentphoneDelivery,
      },
    },
    ...(input.feishuDelivery
      ? [
          {
            internalKind: "feishu:org" as const,
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
  ];
}

export function buildQueuedRunCommand(
  input: CreateQueuedChatRunInput,
  admissionTime: number,
) {
  return {
    owner: { userId: input.userId, orgId: input.orgId },
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
    callbacks: queuedChatRunCallbackInputs(input),
    triggerSource: input.triggerSource,
    agentRunPreCreateSource: "chat_callback_auto_send" as const,
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
    body: {
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
    },
  };
}

const loadCompletedChatOutput$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly lastEventSequence: number | null;
      readonly timing: ChatCallbackPreCreateTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<CompletedChatOutputLoad> => {
    const timing = {
      actionType:
        "api_dispatch_pre_create_agent_chat_callback_load_db_output_state" as const,
      spanKind: "nested" as const,
      startedAt: now(),
    };
    const dbOutput = await set(loadCompletedRunOutput$, {
      runId: args.runId,
      lastEventSequence: args.lastEventSequence,
    }).finally(() => {
      args.timing.recordElapsed(timing);
    });
    signal.throwIfAborted();

    return {
      assistantItemsToInsert: [],
      latestAssistant: dbOutput.latestAssistant,
      resultFallback: dbOutput.resultFallback,
    };
  },
);

const CHAT_DELIVERY_CALLBACK_NAMESPACE = "3c3c6fe0-1041-4d9b-8fbc-403eec20e47b";

type ChatDeliveryKind =
  | "slack:chat"
  | "wechat:chat"
  | "feishu:chat"
  | "teams:chat"
  | "telegram:chat"
  | "agentphone:chat";

const insertChatDeliveryCallback$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly sourceCallbackId: string;
      readonly internalKind: ChatDeliveryKind;
      readonly chatEventId: string;
      readonly payload: NonNullable<
        (typeof agentRunCallbacks.$inferInsert)["payload"]
      >;
    },
  ): Promise<string> => {
    const database = set(writeDb$);
    const source = await (async () => {
      const plan = sourceChatCallbackReadPlan({
        runId: args.runId,
        sourceCallbackId: args.sourceCallbackId,
      });
      const [source] = await database
        .select(plan.columns)
        .from(agentRunCallbacks)
        .where(plan.condition)
        .orderBy(plan.order)
        .limit(plan.limit);
      return requiredSourceChatCallback(source);
    })();

    const id = uuidv5(
      `${source.id}:${args.internalKind}:${args.chatEventId}`,
      CHAT_DELIVERY_CALLBACK_NAMESPACE,
    );
    await database
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
  },
);

const insertSlackChatDeliveryCallback$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly sourceCallbackId: string;
      readonly target: SlackDeliveryTarget;
      readonly chatEventId: string;
    },
  ): Promise<string> => {
    return await set(insertChatDeliveryCallback$, {
      runId: args.runId,
      sourceCallbackId: args.sourceCallbackId,
      ...slackChatDeliveryFields(args.target, args.chatEventId),
    });
  },
);

function feishuChatDeliveryFields(
  target: FeishuDeliveryTarget,
  chatEventId: string,
) {
  return {
    internalKind: "feishu:chat" as const,
    chatEventId,
    payload: { ...target, chatEventId },
  };
}

function teamsChatDeliveryFields(
  target: TeamsDeliveryTarget,
  chatEventId: string,
) {
  return {
    internalKind: "teams:chat" as const,
    chatEventId,
    payload: { ...target, chatEventId },
  };
}

/**
 * Discord replies are fire and forget with no delivery record, so only the
 * attempt that created the event posts it; replays never post twice.
 */
const discordReplyRunSelection = Object.freeze({
  userId: agentRuns.userId,
  orgId: agentRuns.orgId,
  chatThreadId: agentRuns.chatThreadId,
});

function discordReplyRequest(args: {
  readonly run:
    | {
        readonly userId: string;
        readonly orgId: string;
        readonly chatThreadId: string | null;
      }
    | undefined;
  readonly target: DiscordDeliveryTarget;
  readonly chatEventId: string;
}): DiscordReplyRequest {
  const { run } = args;
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

function telegramChatDeliveryFields(
  target: TelegramDeliveryTarget,
  chatEventId: string,
) {
  return {
    internalKind: "telegram:chat" as const,
    chatEventId,
    payload: { ...target, chatEventId },
  };
}

function agentPhoneChatDeliveryFields(
  target: AgentPhoneDeliveryTarget,
  chatEventId: string,
) {
  return {
    internalKind: "agentphone:chat" as const,
    chatEventId,
    payload: { ...target, chatEventId },
  };
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
  readonly wechatDelivery?: WechatDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly sourceCallbackId: string;
}

type AssistantErrorEventProjection = RunLifecycleDeliveryCallbacks & {
  readonly markerInserted: boolean;
};

function assistantErrorEventTouchOptions(args: AssistantErrorEventArgs) {
  return {
    orgId: args.orgId,
    unarchive:
      args.lifecycleEvent === "failed" &&
      !hasExternalNotificationDeliveryChannel(args),
    markRead:
      args.lifecycleEvent === "failed" &&
      hasExternalNotificationDeliveryChannel(args),
  };
}

function assistantErrorEventResult(
  displayErrorMessage: string,
  inserted: AssistantErrorEventProjection,
): FailedChatCallbackResult {
  return {
    displayErrorMessage,
    outcome: inserted.markerInserted ? "written" : "replayed",
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    discordReply: inserted.discordReply,
    wechatDeliveryCallbackId: inserted.wechatDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
  };
}

function assistantErrorWechatCallbackValues(
  input: AssistantErrorEventArgs,
  target: WechatDeliveryTarget,
  chatEventId: string,
) {
  return {
    runId: input.runId,
    sourceCallbackId: input.sourceCallbackId,
    internalKind: "wechat:chat" as const,
    chatEventId,
    payload: {
      userId: input.userId,
      orgId: input.orgId,
      chatThreadId: input.threadId,
      target,
      chatEventId,
    },
  };
}

const insertAssistantErrorEvent$ = command(
  async (
    { set },
    args: AssistantErrorEventArgs,
    signal: AbortSignal,
  ): Promise<FailedChatCallbackResult> => {
    const database = set(writeDb$);
    const { displayErrorMessage } = args;
    signal.throwIfAborted();
    const input = { ...args };
    const inserted =
      await (async (): Promise<AssistantErrorEventProjection | null> => {
        const insertedEvent =
          parseRawRows(
            chatEventCommandResultSchema,
            await database.execute(
              assistantErrorEventInsertSql(input, displayErrorMessage),
            ),
          )[0] ?? null;
        const event =
          insertedEvent ??
          (await (async () => {
            const runId = input.runId;
            const eventType = assistantErrorEventType(input.lifecycleEvent);
            const plan = runLifecycleMarkerReadPlan(runId, eventType);
            const query = database.select(plan.columns).from(chatEvents);
            const [marker] = await query
              .where(plan.condition)
              .limit(plan.limit);
            return marker;
          })());
        if (!event) {
          return null;
        }
        const slackDeliveryCallbackId = input.slackDelivery
          ? await set(insertSlackChatDeliveryCallback$, {
              runId: input.runId,
              sourceCallbackId: input.sourceCallbackId,
              target: input.slackDelivery,
              chatEventId: event.id,
            })
          : undefined;
        const feishuDeliveryCallbackId = input.feishuDelivery
          ? await set(insertChatDeliveryCallback$, {
              runId: input.runId,
              sourceCallbackId: input.sourceCallbackId,
              ...feishuChatDeliveryFields(input.feishuDelivery, event.id),
            })
          : undefined;
        const teamsDeliveryCallbackId = input.teamsDelivery
          ? await set(insertChatDeliveryCallback$, {
              runId: input.runId,
              sourceCallbackId: input.sourceCallbackId,
              ...teamsChatDeliveryFields(input.teamsDelivery, event.id),
            })
          : undefined;
        const discordTarget = input.discordDelivery;
        const discordReply =
          discordTarget && insertedEvent
            ? await (async () => {
                const [run] = await database
                  .select(discordReplyRunSelection)
                  .from(agentRuns)
                  .where(eq(agentRuns.id, input.runId))
                  .limit(1);
                return discordReplyRequest({
                  run,
                  target: discordTarget,
                  chatEventId: event.id,
                });
              })()
            : undefined;
        const wechatDeliveryCallbackId = input.wechatDelivery
          ? await set(insertChatDeliveryCallback$, {
              ...assistantErrorWechatCallbackValues(
                input,
                input.wechatDelivery,
                event.id,
              ),
            })
          : undefined;
        const telegramDeliveryCallbackId = input.telegramDelivery
          ? await set(insertChatDeliveryCallback$, {
              runId: input.runId,
              sourceCallbackId: input.sourceCallbackId,
              ...telegramChatDeliveryFields(input.telegramDelivery, event.id),
            })
          : undefined;
        const agentphoneDeliveryCallbackId = input.agentphoneDelivery
          ? await set(insertChatDeliveryCallback$, {
              runId: input.runId,
              sourceCallbackId: input.sourceCallbackId,
              ...agentPhoneChatDeliveryFields(
                input.agentphoneDelivery,
                event.id,
              ),
            })
          : undefined;
        return {
          markerInserted: insertedEvent !== null,
          slackDeliveryCallbackId,
          feishuDeliveryCallbackId,
          teamsDeliveryCallbackId,
          discordReply,
          wechatDeliveryCallbackId,
          telegramDeliveryCallbackId,
          agentphoneDeliveryCallbackId,
        };
      })();
    signal.throwIfAborted();
    if (!inserted) {
      return { outcome: "duplicate" };
    }

    // Replays repeat the monotonic touch and publishes because an earlier
    // attempt may have failed after its marker committed.
    await set(
      touchChatThreadLastMessageAtIndependently$,
      args.threadId,
      assistantErrorEventTouchOptions(args),
      signal,
    );
    await publishAssistantErrorEventSignals(args);
    signal.throwIfAborted();
    return assistantErrorEventResult(displayErrorMessage, inserted);
  },
);

interface RunLifecycleMarkerArgs {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly event: "completed" | "cancelled";
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly discordDelivery?: DiscordDeliveryTarget;
  readonly wechatDelivery?: WechatDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly sourceCallbackId: string;
}

interface RunLifecycleDeliveryCallbacks {
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly discordReply?: DiscordReplyRequest;
  readonly wechatDeliveryCallbackId?: string;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
}

function hasExternalNotificationDeliveryChannel(
  args: Pick<
    RunLifecycleMarkerArgs,
    | "slackDelivery"
    | "feishuDelivery"
    | "teamsDelivery"
    | "discordDelivery"
    | "wechatDelivery"
    | "telegramDelivery"
    | "agentphoneDelivery"
  >,
): boolean {
  return Boolean(
    args.slackDelivery ||
    args.feishuDelivery ||
    args.teamsDelivery ||
    args.discordDelivery ||
    args.wechatDelivery ||
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
      args.wechatDelivery ||
      args.telegramDelivery ||
      args.agentphoneDelivery,
    )
  );
}

const registerRunLifecycleDeliveryCallbacks$ = command(
  async (
    { set },
    input: RunLifecycleMarkerArgs,
    deliveryEvent: { readonly id: string } | undefined,
    markerInserted: boolean,
  ): Promise<RunLifecycleDeliveryCallbacks> => {
    const slackDeliveryCallbackId =
      deliveryEvent && input.slackDelivery
        ? await set(insertSlackChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            target: input.slackDelivery,
            chatEventId: deliveryEvent.id,
          })
        : undefined;
    const feishuDeliveryCallbackId =
      deliveryEvent && input.feishuDelivery
        ? await set(insertChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            ...feishuChatDeliveryFields(input.feishuDelivery, deliveryEvent.id),
          })
        : undefined;
    const teamsDeliveryCallbackId =
      deliveryEvent && input.teamsDelivery
        ? await set(insertChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            ...teamsChatDeliveryFields(input.teamsDelivery, deliveryEvent.id),
          })
        : undefined;
    const discordTarget = input.discordDelivery;
    const discordReply =
      deliveryEvent && discordTarget && markerInserted
        ? await (async () => {
            const database = set(writeDb$);
            const [run] = await database
              .select(discordReplyRunSelection)
              .from(agentRuns)
              .where(eq(agentRuns.id, input.runId))
              .limit(1);
            return discordReplyRequest({
              run,
              target: discordTarget,
              chatEventId: deliveryEvent.id,
            });
          })()
        : undefined;
    const wechatDeliveryCallbackId =
      deliveryEvent && input.wechatDelivery
        ? await set(insertChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            internalKind: "wechat:chat",
            chatEventId: deliveryEvent.id,
            payload: {
              userId: input.userId,
              orgId: input.orgId,
              chatThreadId: input.threadId,
              target: input.wechatDelivery,
              chatEventId: deliveryEvent.id,
            },
          })
        : undefined;
    const telegramDeliveryCallbackId =
      deliveryEvent && input.telegramDelivery
        ? await set(insertChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            ...telegramChatDeliveryFields(
              input.telegramDelivery,
              deliveryEvent.id,
            ),
          })
        : undefined;
    const agentphoneDeliveryCallbackId =
      deliveryEvent && input.agentphoneDelivery
        ? await set(insertChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            ...agentPhoneChatDeliveryFields(
              input.agentphoneDelivery,
              deliveryEvent.id,
            ),
          })
        : undefined;
    return {
      slackDeliveryCallbackId,
      feishuDeliveryCallbackId,
      teamsDeliveryCallbackId,
      discordReply,
      wechatDeliveryCallbackId,
      telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId,
    };
  },
);

type RunLifecycleMarkerProjection = RunLifecycleDeliveryCallbacks & {
  readonly markerInserted: boolean;
};

function runLifecycleMarkerTouchOptions(
  args: RunLifecycleMarkerArgs,
  markerCreatedAt: Date,
) {
  return {
    touchedAt: markerCreatedAt,
    orgId: args.orgId,
    unarchive:
      args.event === "completed" &&
      !hasExternalNotificationDeliveryChannel(args),
    markRead:
      args.event === "completed" &&
      hasExternalNotificationDeliveryChannel(args),
  };
}

function runLifecycleMarkerResult(inserted: RunLifecycleMarkerProjection): {
  readonly outcome: "written" | "replayed";
} & RunLifecycleDeliveryCallbacks {
  return {
    outcome: inserted.markerInserted ? "written" : "replayed",
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    discordReply: inserted.discordReply,
    wechatDeliveryCallbackId: inserted.wechatDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
  };
}

const insertRunLifecycleMarker$ = command(
  async (
    { set },
    args: RunLifecycleMarkerArgs,
    signal: AbortSignal,
  ): Promise<
    | ({ readonly outcome: "duplicate" } & RunLifecycleDeliveryCallbacks)
    | ({
        readonly outcome: "written" | "replayed";
      } & RunLifecycleDeliveryCallbacks)
  > => {
    signal.throwIfAborted();
    const markerCreatedAt = nowDate();
    const tx = set(writeDb$);
    const input = { ...args };
    const inserted =
      await (async (): Promise<RunLifecycleMarkerProjection | null> => {
        const canonicalDatabase = tx;
        const canonicalRunId = input.runId;
        const canonicalReadEnabled =
          hasExternalNotificationDeliveryChannel(input);
        let deliveryEvent = await (async () => {
          if (!canonicalReadEnabled) {
            return undefined;
          }
          const plan = canonicalDeliveryEventReadPlan(canonicalRunId);
          const query = canonicalDatabase.select(plan.columns).from(chatEvents);
          const [event] = await query
            .where(plan.condition)
            .orderBy(plan.order)
            .limit(plan.limit);
          return event;
        })();
        if (!deliveryEvent && requiresIntegrationCompletionFallback(input)) {
          const fallbackDatabase = tx;
          const fallbackInput = {
            runId: input.runId,
            threadId: input.threadId,
            createdAt: markerCreatedAt,
          };
          deliveryEvent = await (async () => {
            const eventId = integrationCompletionFallbackEventIdForRun(
              fallbackInput.runId,
            );
            const inserted =
              parseRawRows(
                chatEventCommandResultSchema,
                await fallbackDatabase.execute(
                  integrationCompletionFallbackInsertSql(
                    eventId,
                    fallbackInput,
                  ),
                ),
              )[0] ?? null;
            if (inserted) {
              return { id: inserted.id };
            }
            const plan = integrationCompletionFallbackReadPlan(eventId);
            const query = fallbackDatabase
              .select(plan.columns)
              .from(chatEvents);
            const [existing] = await query
              .where(plan.condition)
              .limit(plan.limit);
            if (!existing) {
              throw new Error(
                "Failed to persist integration completion fallback",
              );
            }
            return existing;
          })();
        }
        const marker =
          parseRawRows(
            chatEventCommandResultSchema,
            await tx.execute(
              runLifecycleMarkerInsertSql(input, markerCreatedAt),
            ),
          )[0] ?? null;
        if (
          !marker &&
          !(await (async () => {
            const database = tx;
            const runId = input.runId;
            const eventType = runLifecycleMarkerEventType(input.event);
            const plan = runLifecycleMarkerReadPlan(runId, eventType);
            const query = database.select(plan.columns).from(chatEvents);
            const [marker] = await query
              .where(plan.condition)
              .limit(plan.limit);
            return marker;
          })())
        ) {
          return null;
        }
        return {
          markerInserted: marker !== null,
          ...(await set(
            registerRunLifecycleDeliveryCallbacks$,
            input,
            deliveryEvent,
            marker !== null,
          )),
        };
      })();
    signal.throwIfAborted();
    if (!inserted) {
      return { outcome: "duplicate" };
    }
    // The marker is only one committed projection. Its source callback still
    // owns completion work until registration and automation admission succeed,
    // so a replay repeats the monotonic touch and publishes an earlier attempt
    // may have lost after the marker committed.
    await set(
      touchChatThreadLastMessageAtIndependently$,
      args.threadId,
      runLifecycleMarkerTouchOptions(args, markerCreatedAt),
      signal,
    );
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
    return runLifecycleMarkerResult(inserted);
  },
);

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

const loadRecommendedFollowupContextForCompletedRun$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
    },
    signal: AbortSignal,
  ): Promise<readonly ChatCompletionContextMessage[]> => {
    return (
      (await tapError(
        set(loadChatThreadRecommendedFollowupContext$, args, signal),
        (err) => {
          log.warn("Recommended follow-up context load failed", {
            threadId: args.threadId,
            err,
          });
        },
      )) ?? []
    );
  },
);

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
      const timing = args.timing;
      const startedAt = now();
      await (async () => {
        await onRejection(
          (async () => {
            return await set(
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
          })(),
          () => {
            timing.recordElapsed({
              actionType:
                "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
              spanKind: "nested",
              startedAt,
            });
          },
        );
        timing.recordElapsed({
          actionType:
            "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
          spanKind: "nested",
          startedAt,
        });
      })();
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
      const timing = args.timing;
      const startedAt = now();
      await (async () => {
        await onRejection(
          (async () => {
            return await set(
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
          })(),
          () => {
            timing.recordElapsed({
              actionType:
                "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
              spanKind: "nested",
              startedAt,
            });
          },
        );
        timing.recordElapsed({
          actionType:
            "api_dispatch_pre_create_agent_chat_callback_insert_assistant_items",
          spanKind: "nested",
          startedAt,
        });
      })();
      signal.throwIfAborted();
      lastResultText = resultFallback.content;
    }
    return lastResultText;
  },
);

function completedChatResultInput(
  args: ReturnType<typeof terminalIntegrationDeliveries> & {
    readonly runId: string;
    readonly chatThread: ChatThreadForRunRow;
    readonly timing: ChatCallbackPreCreateTimingCollector;
  },
  output: CompletedChatOutputLoad,
) {
  return {
    runId: args.runId,
    chatThread: args.chatThread,
    output,
    preferResultFallback:
      args.slackDelivery !== undefined ||
      args.teamsDelivery !== undefined ||
      args.discordDelivery !== undefined ||
      args.wechatDelivery !== undefined ||
      args.telegramDelivery !== undefined ||
      args.agentphoneDelivery !== undefined,
    timing: args.timing,
  };
}

const handleCompletedChatCallback$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly timing: ChatCallbackPreCreateTimingCollector;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<CompletedChatCallbackResult> => {
    const output = await set(
      loadCompletedChatOutput$,
      {
        runId: args.runId,
        lastEventSequence: args.run.lastEventSequence,
        timing: args.timing,
      },
      signal,
    );
    signal.throwIfAborted();

    const lastResultText = await set(
      materializeCompletedChatResult$,
      completedChatResultInput(args, output),
      signal,
    );
    signal.throwIfAborted();

    waitUntil(
      tapError(set(recordLastEventToComplete$, args.runId), (error) => {
        log.warn("Failed to record last_event_to_complete", {
          runId: args.runId,
          error,
        });
      }),
    );

    const lifecycleTiming = args.timing;
    const lifecycleStartedAt = now();
    const inserted = await onRejection(
      set(
        insertRunLifecycleMarker$,
        {
          runId: args.runId,
          threadId: args.chatThread.chatThreadId,
          userId: args.chatThread.userId,
          orgId: args.chatThread.orgId,
          event: "completed",
          slackDelivery: args.slackDelivery,
          feishuDelivery: args.feishuDelivery,
          teamsDelivery: args.teamsDelivery,
          discordDelivery: args.discordDelivery,
          wechatDelivery: args.wechatDelivery,
          telegramDelivery: args.telegramDelivery,
          agentphoneDelivery: args.agentphoneDelivery,
          sourceCallbackId: args.sourceCallbackId,
        },
        signal,
      ),
      () => {
        lifecycleTiming.recordElapsed({
          actionType:
            "api_dispatch_pre_create_agent_chat_callback_insert_lifecycle_marker",
          spanKind: "nested",
          startedAt: lifecycleStartedAt,
        });
      },
    );
    signal.throwIfAborted();
    lifecycleTiming.recordElapsed({
      actionType:
        "api_dispatch_pre_create_agent_chat_callback_insert_lifecycle_marker",
      spanKind: "nested",
      startedAt: lifecycleStartedAt,
    });
    if (inserted.outcome === "duplicate") {
      return inserted;
    }

    const timing = args.timing;
    const startedAt = now();
    const followupContext = await (async () => {
      const result = await onRejection(
        (async () => {
          return await set(
            loadRecommendedFollowupContextForCompletedRun$,
            {
              threadId: args.chatThread.chatThreadId,
            },
            signal,
          );
        })(),
        () => {
          timing.recordElapsed({
            actionType:
              "api_dispatch_pre_create_agent_chat_callback_load_followup_context",
            spanKind: "nested",
            startedAt,
          });
        },
      );
      timing.recordElapsed({
        actionType:
          "api_dispatch_pre_create_agent_chat_callback_load_followup_context",
        spanKind: "nested",
        startedAt,
      });
      return result;
    })();
    signal.throwIfAborted();

    return {
      lastResultText,
      followupContext,
      outcome: inserted.outcome,
      slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
      feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
      teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
      discordReply: inserted.discordReply,
      wechatDeliveryCallbackId: inserted.wechatDeliveryCallbackId,
      telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    };
  },
);

const runCompletedChatCallbackSideEffects$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
      readonly sendClientPush: boolean;
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
        await set(
          insertRecommendedFollowupsEvent$,
          {
            runId: args.runId,
            threadId: args.chatThread.chatThreadId,
            userId: args.chatThread.userId,
            orgId: args.chatThread.orgId,
            followups,
            markRead: !args.sendClientPush,
          },
          signal,
        );
      }
    })();

    const pushStep = (async () => {
      if (!args.sendClientPush) {
        return;
      }
      const summaryStarted = performance.now();
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

      log.debug("Push summary generated", {
        runId: args.runId,
        durationMs: performance.now() - summaryStarted,
      });
      signal.throwIfAborted();
      await set(
        sendUserPushNotifications$,
        {
          runId: args.runId,
          status: "completed",
          userId: args.chatThread.userId,
          orgId: args.chatThread.orgId,
          threadId: args.chatThread.chatThreadId,
          notification: {
            title: args.run.prompt.slice(0, 60),
            body: summary ?? "Your task is complete",
            url: `/chats/${args.chatThread.chatThreadId}`,
          },
        },
        signal,
      );
    })();

    const results = await Promise.allSettled([
      saveSummaryStep,
      followupsStep,
      pushStep,
    ]);
    signal.throwIfAborted();
    const operations = [
      ["save_summary", results[0]],
      ["followups", results[1]],
      ["push", results[2]],
    ] as const;
    const failures = operations.flatMap(([operation, result]) => {
      if (result.status === "fulfilled") {
        return [];
      }
      throwIfAbort(result.reason);
      const sqlState = safeSqlStateCode(result.reason);
      return [
        {
          operation,
          reason: sqlState
            ? "database_error"
            : result.reason instanceof TypeError
              ? "type_error"
              : result.reason instanceof SyntaxError
                ? "syntax_error"
                : result.reason instanceof Error
                  ? "error"
                  : "non_error",
          ...(sqlState === undefined ? {} : { sqlState }),
        },
      ];
    });
    if (failures.length > 0) {
      // Keep only finite diagnostics: child errors can contain prompts, provider
      // responses, SQL and parameters. `cause` survives Error serialization.
      throw new AggregateError(
        failures,
        "Completed chat callback side effects failed",
        { cause: { failures } },
      );
    }
  },
);

const handleFailedChatCallback$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly chatThread: ChatThreadForRunRow;
      readonly errorMessage: string;
      readonly failureReason: RunFailureReasonToken | null;
      readonly hasCancellationRecoveryState: boolean;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
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
    return await set(
      insertAssistantErrorEvent$,
      {
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
        wechatDelivery: args.wechatDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        sourceCallbackId: args.sourceCallbackId,
      },
      signal,
    );
  },
);

const runFailedChatCallbackSideEffects$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly displayErrorMessage: string;
      readonly sendClientPush: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.sendClientPush) {
      return;
    }
    await set(
      sendUserPushNotifications$,
      {
        runId: args.runId,
        status: "failed",
        userId: args.chatThread.userId,
        orgId: args.chatThread.orgId,
        threadId: args.chatThread.chatThreadId,
        notification: {
          title: args.run.prompt.slice(0, 60),
          body: `Task failed: ${args.displayErrorMessage.slice(0, 80)}`,
          url: `/chats/${args.chatThread.chatThreadId}`,
        },
      },
      signal,
    );
  },
);

async function runTerminalChatCallbackSideEffects(args: {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly operation: Promise<void>;
}): Promise<void> {
  await tapError(args.operation, (error) => {
    log.warn("Failed to process terminal chat callback side effects", {
      runId: args.runId,
      status: args.status,
      error:
        args.status === "completed" && error instanceof AggregateError
          ? serializeError(error)
          : error,
    });
  });
}

export interface QueuedMessageModelRouteError {
  readonly code: string;
  readonly message: string;
}

export interface QueuedChatPromptData {
  readonly threadId: string;
  readonly userId: string;
  readonly agent: AgentForAutoSend;
  readonly queuedMessage: QueuedUserMessage;
}

type QueuedIntegrationDeliveries = Pick<
  CreateQueuedChatRunInput,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "discordDelivery"
  | "wechatDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
>;

export interface QueuedLaunchMaterial {
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly connectorSourceId?: string;
  readonly delivery: QueuedIntegrationDeliveries;
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

export function queuedMessageAdmissionFailure(
  args: QueuedChatPromptData,
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

/** Captured identity and delivery data needed to report a commit rejection. */
export type QueuedRunAdmissionFailureInput = Pick<
  CreateQueuedChatRunInput,
  | "orgId"
  | "userId"
  | "agentId"
  | "threadId"
  | "queuedMessage"
  | "triggerSource"
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "discordDelivery"
  | "wechatDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
>;

/** A queued message whose run creation was rejected for a reason other than capacity. */
export function rejectedQueuedRunAdmissionFailure(
  input: QueuedRunAdmissionFailureInput,
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
    | "wechatDelivery"
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
    case "wechat": {
      return {
        kind: "wechat_admission_failure",
        ...common,
        wechatDelivery: requiredQueuedDelivery(
          delivery.wechatDelivery,
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

export function queuedIntegrationLaunchFields(
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
    ...(launchMaterial.connectorSourceId
      ? { connectorSourceId: launchMaterial.connectorSourceId }
      : {}),
  };
}

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
    | { readonly kind: "Wechat"; readonly target: WechatDeliveryTarget }
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
    case "wechat_admission_failure": {
      return { ...base, kind: "Wechat", target: failure.wechatDelivery };
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
    // Preserve acquisition before channel dispatch, without forwarding the DB.
    set(writeDb$);
    const base = {
      chatThreadId: channel.chatThreadId,
      orgId: channel.orgId,
      userId: channel.userId,
      chatEventId,
    };
    switch (channel.kind) {
      case "Slack": {
        await set(
          deliverSlackChatAdmissionFailure$,
          {
            chatThreadId: channel.chatThreadId,
            orgId: channel.orgId,
            userId: channel.userId,
            chatEventId,
            agentId: channel.agentId,
            ...channel.target,
          },
          signal,
        );
        return;
      }
      case "Feishu": {
        await set(
          deliverFeishuChatAdmissionFailure$,
          {
            chatThreadId: channel.chatThreadId,
            orgId: channel.orgId,
            userId: channel.userId,
            chatEventId,
            target: channel.target,
          },
          signal,
        );
        return;
      }
      case "Teams": {
        await set(
          deliverTeamsChatAdmissionFailure$,
          {
            chatThreadId: channel.chatThreadId,
            orgId: channel.orgId,
            userId: channel.userId,
            chatEventId,
            agentId: channel.agentId,
            target: channel.target,
          },
          signal,
        );
        return;
      }
      case "Discord": {
        await set(
          sendDiscordChatReply$,
          {
            chatThreadId: channel.chatThreadId,
            orgId: channel.orgId,
            userId: channel.userId,
            chatEventId,
            target: channel.target,
          },
          signal,
        );
        return;
      }
      case "Wechat": {
        await set(
          sendWechatChatReply$,
          { ...base, target: channel.target },
          signal,
        );
        return;
      }
      case "Telegram": {
        await set(
          deliverTelegramChatAdmissionFailure$,
          {
            chatThreadId: channel.chatThreadId,
            userId: channel.userId,
            orgId: channel.orgId,
            chatEventId,
            target: channel.target,
          },
          signal,
        );
        return;
      }
      case "AgentPhone": {
        await set(
          deliverAgentPhoneChatAdmissionFailure$,
          {
            chatThreadId: channel.chatThreadId,
            userId: channel.userId,
            orgId: channel.orgId,
            chatEventId,
            agentId: channel.agentId,
            target: channel.target,
          },
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
    if (channel.kind === "Wechat") {
      waitUntil(
        set(
          reconcileWechatThreadTyping$,
          { chatThreadId: channel.chatThreadId, target: channel.target },
          new AbortController().signal,
        ),
      );
    }
    if (channel.kind !== "Feishu") {
      return;
    }
    await tapError(
      set(clearCanonicalFeishuThinkingReaction$, channel.target, signal),
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

/** The committed run's title and typing observations need no read plan. */
export type QueuedPromptLaunchInput = Pick<
  CreateQueuedChatRunInput,
  | "orgId"
  | "threadId"
  | "prompt"
  | "discordDelivery"
  | "wechatDelivery"
  | "triggerSource"
>;

export interface QueuedPromptLaunchContext {
  readonly userId: string;
  readonly runInput: QueuedPromptLaunchInput;
}

export const recordQueuedPromptRunLaunch$ = command(
  (
    { set },
    args: QueuedPromptLaunchContext,
    runId: string,
    timing: ChatCallbackPreCreateTimingCollector,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(writeDb$);
    const { userId, runInput } = args;
    const threadId = runInput.threadId;
    waitUntil(
      set(
        generateAndPersistChatThreadTitle$,
        {
          threadId,
          userId,
          orgId: runInput.orgId,
          prompt: runInput.prompt,
          includePriorRounds: true,
        },
        signal,
      ),
    );
    if (runInput.discordDelivery) {
      set(scheduleDiscordRunTyping$, {
        runId,
        chatThreadId: threadId,
        target: runInput.discordDelivery,
      });
    }
    if (runInput.wechatDelivery) {
      waitUntil(
        set(
          reconcileWechatThreadTyping$,
          { chatThreadId: threadId, target: runInput.wechatDelivery },
          new AbortController().signal,
        ),
      );
    }
    timing.flush(runId, runInput.triggerSource);
  },
);

const prepareCompletedTerminalChatCallbackWork$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly timing: ChatCallbackPreCreateTimingCollector;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackWork> => {
    const timing = args.timing;
    const startedAt = now();
    const completed = await (async () => {
      const result = await onRejection(
        (async () => {
          return await set(handleCompletedChatCallback$, args, signal);
        })(),
        () => {
          timing.recordElapsed({
            actionType:
              "api_dispatch_pre_create_agent_chat_callback_prepare_completed",
            spanKind: "top_level",
            startedAt,
          });
        },
      );
      timing.recordElapsed({
        actionType:
          "api_dispatch_pre_create_agent_chat_callback_prepare_completed",
        spanKind: "top_level",
        startedAt,
      });
      return result;
    })();
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
      wechatDeliveryCallbackId: completed.wechatDeliveryCallbackId,
      telegramDeliveryCallbackId: completed.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: completed.agentphoneDeliveryCallbackId,
      runFinishedEvent: {
        chatThreadId: args.chatThread.chatThreadId,
        runId: args.runId,
        sourceCallbackId: args.sourceCallbackId,
        runStatus: "completed",
        failureReason: null,
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
    { get, set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly errorMessage: string;
      readonly timing: ChatCallbackPreCreateTimingCollector;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackWork> => {
    const timing = args.timing;
    const startedAt = now();
    const failed = await (async () => {
      const result = await onRejection(
        (async () => {
          return await set(
            handleFailedChatCallback$,
            {
              ...args,
              failureReason:
                args.run.failureReason === "provider_insufficient_credits"
                  ? (publicProviderBalanceFailureReason(
                      args.run.modelProvider,
                    ) ?? null)
                  : args.run.failureReason,
              hasCancellationRecoveryState:
                args.run.cancellationRecoveryCompleted !== null,
            },
            signal,
          );
        })(),
        () => {
          timing.recordElapsed({
            actionType:
              "api_dispatch_pre_create_agent_chat_callback_prepare_failed",
            spanKind: "top_level",
            startedAt,
          });
        },
      );
      timing.recordElapsed({
        actionType:
          "api_dispatch_pre_create_agent_chat_callback_prepare_failed",
        spanKind: "top_level",
        startedAt,
      });
      return result;
    })();
    signal.throwIfAborted();
    if (failed.outcome !== "written" && failed.outcome !== "replayed") {
      return failed;
    }

    const runStatus =
      args.errorMessage.trim().toLowerCase() === "run cancelled"
        ? "cancelled"
        : "failed";
    const [terminalEvent] = await get(db$)
      .select({ failureReason: chatEvents.failureReason })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, args.runId),
          eq(chatEvents.chatThreadId, args.chatThread.chatThreadId),
          eq(
            chatEvents.eventType,
            runStatus === "failed" ? "run.failed" : "run.cancelled",
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!terminalEvent) {
      throw new Error("Failed chat callback is missing its terminal event");
    }

    return {
      outcome: failed.outcome,
      slackDeliveryCallbackId: failed.slackDeliveryCallbackId,
      feishuDeliveryCallbackId: failed.feishuDeliveryCallbackId,
      teamsDeliveryCallbackId: failed.teamsDeliveryCallbackId,
      discordReply: failed.discordReply,
      wechatDeliveryCallbackId: failed.wechatDeliveryCallbackId,
      telegramDeliveryCallbackId: failed.telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId: failed.agentphoneDeliveryCallbackId,
      runFinishedEvent: {
        chatThreadId: args.chatThread.chatThreadId,
        runId: args.runId,
        sourceCallbackId: args.sourceCallbackId,
        runStatus,
        failureReason:
          runStatus === "failed" ? terminalEvent.failureReason : null,
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

const clearSlackThreadStatusAfterTerminalCallback$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly slackDelivery: SlackDeliveryTarget | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.slackDelivery) {
      return;
    }
    await tapError(
      set(
        clearCanonicalSlackThreadStatusIfIdle$,
        {
          chatThreadId: args.chatThreadId,
          channelId: args.slackDelivery.channelId,
          threadTs: args.slackDelivery.threadTs,
          workspaceId: args.slackDelivery.workspaceId,
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
  },
);

const clearFeishuThinkingAfterTerminalCallback$ = command(
  async (
    { set },
    args: {
      readonly feishuDelivery: FeishuDeliveryTarget | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.feishuDelivery) {
      return;
    }
    await tapError(
      set(clearCanonicalFeishuThinkingReaction$, args.feishuDelivery, signal),
      (error) => {
        log.warn("Failed to clear canonical Feishu thinking reaction", {
          messageId: args.feishuDelivery?.messageId,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);

const tryClearTerminalIntegrationStatus$ = command(
  async (
    { set },
    callback: Pick<TerminalChatCallbackArgs, "payload">,
    chatThreadId: string,
    signal: AbortSignal,
  ) => {
    return await settleIncludingAbort(
      set(clearTerminalIntegrationStatus$, callback, chatThreadId, signal),
    );
  },
);

const handleTerminalChatCallbackPreparationFailure$ = command(
  async (
    { set },
    args: {
      readonly callback: Pick<TerminalChatCallbackArgs, "callback" | "payload">;
      readonly error: unknown;
      readonly persistedThreadId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<never> => {
    // Join the cleanup within the existing owner, including its abort. A
    // secondary cleanup failure must never replace the original load/capture
    // error.
    const cleared = await set(
      tryClearTerminalIntegrationStatus$,
      { payload: args.callback.payload },
      args.persistedThreadId ?? args.callback.payload.threadId,
      signal,
    );
    if (!cleared.ok) {
      log.error(
        "Failed to clear integration status after terminal callback error",
        { runId: args.callback.callback.runId, error: cleared.error },
      );
    }
    throw args.error;
  },
);

const dispatchCanonicalDeliveryCallbacks$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly status: "completed" | "failed";
      readonly slackDeliveryCallbackId: string | undefined;
      readonly feishuDeliveryCallbackId: string | undefined;
      readonly teamsDeliveryCallbackId: string | undefined;
      readonly discordReply: DiscordReplyRequest | undefined;
      readonly wechatDeliveryCallbackId: string | undefined;
      readonly telegramDeliveryCallbackId: string | undefined;
      readonly agentphoneDeliveryCallbackId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.slackDeliveryCallbackId) {
      const delivery = await settle(
        set(
          dispatchSlackChatDeliveryOnce$,
          args.slackDeliveryCallbackId,
          signal,
        ),
        signal,
      );
      if (!delivery.ok) {
        log.error("Failed to finalize canonical Slack delivery callback", {
          runId: args.runId,
          callbackId: args.slackDeliveryCallbackId,
          error: delivery.error,
        });
      }
    }
    const channels: readonly {
      readonly name: "Feishu" | "Teams" | "Telegram";
      readonly callbackId: string | undefined;
    }[] = [
      {
        name: "Feishu",
        callbackId: args.feishuDeliveryCallbackId,
      },
      {
        name: "Teams",
        callbackId: args.teamsDeliveryCallbackId,
      },
      {
        name: "Telegram",
        callbackId: args.telegramDeliveryCallbackId,
      },
    ];
    for (const channel of channels) {
      const callbackId = channel.callbackId;
      if (!callbackId) {
        continue;
      }
      let deliveryPromise: Promise<void>;
      if (channel.name === "Teams") {
        deliveryPromise = set(
          dispatchTeamsChatDeliveryOnce$,
          callbackId,
          signal,
        );
      } else if (channel.name === "Feishu") {
        deliveryPromise = set(
          dispatchFeishuChatDeliveryOnce$,
          callbackId,
          signal,
        );
      } else {
        deliveryPromise = set(
          dispatchTelegramChatDeliveryOnce$,
          callbackId,
          args.status,
          signal,
        );
      }
      const delivery = await settle(deliveryPromise, signal);
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
    if (args.agentphoneDeliveryCallbackId) {
      const delivery = await settle(
        set(
          dispatchAgentPhoneChatDeliveryOnce$,
          args.agentphoneDeliveryCallbackId,
          args.status,
          signal,
        ),
        signal,
      );
      if (!delivery.ok) {
        log.error("Failed to finalize canonical AgentPhone delivery callback", {
          runId: args.runId,
          callbackId: args.agentphoneDeliveryCallbackId,
          error: delivery.error,
        });
      }
    }
    if (args.wechatDeliveryCallbackId) {
      await set(
        dispatchWechatChatDelivery$,
        args.wechatDeliveryCallbackId,
        signal,
      );
    }
    if (args.discordReply) {
      await set(sendDiscordChatReply$, args.discordReply, signal);
    }
  },
);

interface TerminalChatCallbackArgs {
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
  | "wechatDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
> {
  return {
    slackDelivery: payload.slackDelivery,
    feishuDelivery: payload.feishuDelivery,
    teamsDelivery: payload.teamsDelivery,
    discordDelivery: payload.discordDelivery,
    wechatDelivery: payload.wechatDelivery,
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

const clearTerminalIntegrationStatus$ = command(
  async (
    { set },
    args: Pick<TerminalChatCallbackArgs, "payload">,
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.payload.wechatDelivery) {
      await set(
        reconcileWechatThreadTyping$,
        { chatThreadId, target: args.payload.wechatDelivery },
        signal,
      );
    }
    await set(
      clearSlackThreadStatusAfterTerminalCallback$,
      {
        chatThreadId,
        slackDelivery: args.payload.slackDelivery,
      },
      signal,
    );
    await set(
      clearFeishuThinkingAfterTerminalCallback$,
      {
        feishuDelivery: args.payload.feishuDelivery,
      },
      signal,
    );
  },
);

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
        runId: args.runId,
        status: args.callbackStatus,
        slackDeliveryCallbackId: args.work.slackDeliveryCallbackId,
        feishuDeliveryCallbackId: args.work.feishuDeliveryCallbackId,
        teamsDeliveryCallbackId: args.work.teamsDeliveryCallbackId,
        discordReply: args.work.discordReply,
        wechatDeliveryCallbackId: args.work.wechatDeliveryCallbackId,
        telegramDeliveryCallbackId: args.work.telegramDeliveryCallbackId,
        agentphoneDeliveryCallbackId: args.work.agentphoneDeliveryCallbackId,
      },
      signal,
    ).finally(() => {
      // Integration status clears keep their established detached owner: they
      // must neither hold the completion ACK nor be cancelled with its request.
      // The thread's queue is woken by whoever releases the run's active slot.
      waitUntil(
        set(
          clearTerminalIntegrationStatus$,
          { payload: args.callback.payload },
          args.chatThread.chatThreadId,
          new AbortController().signal,
        ),
      );
    });
    signal.throwIfAborted();

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
      // Use this Run's persisted delivery targets, not thread history or
      // delivery success. Channel failures must not fall back to Web push.
      const sendClientPush = !hasExternalNotificationDeliveryChannel(
        args.callback.payload,
      );
      waitUntil(
        runTerminalChatCallbackSideEffects({
          runId: args.runId,
          status: args.callbackStatus,
          operation:
            deferredSideEffects.status === "completed"
              ? set(
                  runCompletedChatCallbackSideEffects$,
                  {
                    runId: args.runId,
                    chatThread: args.chatThread,
                    run: deferredSideEffects.run,
                    lastResultText: deferredSideEffects.lastResultText,
                    followupContext: deferredSideEffects.followupContext,
                    sendClientPush,
                  },
                  backgroundSignal,
                )
              : set(
                  runFailedChatCallbackSideEffects$,
                  {
                    runId: args.runId,
                    run: deferredSideEffects.run,
                    chatThread: args.chatThread,
                    displayErrorMessage:
                      deferredSideEffects.displayErrorMessage,
                    sendClientPush,
                  },
                  backgroundSignal,
                ),
        }),
      );
    }
  },
);

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
        const startedAt = now();
        const loaded = await onRejection(
          (async () => {
            const existing = await set(loadTerminalChatCallbackLocator$, runId);
            signal.throwIfAborted();
            if (!existing?.threadId || existing.triggerSource === null) {
              return null;
            }
            // Retain only a content-free persisted locator across capture failure.
            persistedThreadId = existing.threadId;
            return await set(
              loadTerminalChatCallback$,
              {
                runId,
                callbackStatus,
                payloadThreadId: args.payload.threadId,
              },
              signal,
            );
          })(),
          () => {
            timing.recordElapsed({
              actionType:
                "api_dispatch_pre_create_agent_chat_callback_load_terminal",
              spanKind: "top_level",
              startedAt,
            });
          },
        );
        timing.recordElapsed({
          actionType:
            "api_dispatch_pre_create_agent_chat_callback_load_terminal",
          spanKind: "top_level",
          startedAt,
        });
        if (!loaded) {
          return null;
        }
        const { run, chatThread } = loaded;
        // Queue launch failure callbacks carry the run identity before they have
        // an envelope callback ID. Resolve their existing persisted owner exactly
        // as delivery registration does; terminal work must never lose its receipt.
        const sourceCallbackId = await (async () => {
          return (
            await set(requireSourceChatCallback$, {
              runId: args.callback.runId,
              sourceCallbackId: args.callback.callbackId,
            })
          ).id;
        })();
        signal.throwIfAborted();
        const preparation = {
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
                runId: preparation.runId,
                run: preparation.run,
                chatThread: preparation.chatThread,
                timing: preparation.timing,
                slackDelivery: preparation.slackDelivery,
                feishuDelivery: preparation.feishuDelivery,
                teamsDelivery: preparation.teamsDelivery,
                discordDelivery: preparation.discordDelivery,
                wechatDelivery: preparation.wechatDelivery,
                telegramDelivery: preparation.telegramDelivery,
                agentphoneDelivery: preparation.agentphoneDelivery,
                sourceCallbackId: preparation.sourceCallbackId,
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
      return await set(
        handleTerminalChatCallbackPreparationFailure$,
        {
          callback: { callback: args.callback, payload: args.payload },
          error: prepared.error,
          persistedThreadId,
        },
        signal,
      );
    }
    if (!prepared.value) {
      await set(
        clearTerminalIntegrationStatus$,
        { payload: args.payload },
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

const processChatInternalCallback$ = command(
  async (
    { set },
    args: {
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
      if (payload.data.wechatDelivery) {
        waitUntil(
          set(
            reconcileWechatThreadTyping$,
            {
              chatThreadId: payload.data.threadId,
              target: payload.data.wechatDelivery,
            },
            new AbortController().signal,
          ),
        );
      }
      if (payload.data.discordDelivery) {
        set(scheduleDiscordRunTyping$, {
          runId: args.callback.runId,
          chatThreadId: payload.data.threadId,
          target: payload.data.discordDelivery,
        });
      }
      if (payload.data.slackDelivery) {
        const backgroundSignal = new AbortController().signal;
        waitUntil(
          tapError(
            set(
              reconcileCanonicalSlackThreadStatus$,
              {
                chatThreadId: payload.data.threadId,
                channelId: payload.data.slackDelivery.channelId,
                threadTs: payload.data.slackDelivery.threadTs,
                workspaceId: payload.data.slackDelivery.workspaceId,
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
      callback: args.callback,
      payload: payload.data,
    };
    // Keep required terminal work within the persisted source callback's retry
    // lifetime. Each event, delivery registration and automation commits alone.
    await set(processTerminalChatCallback$, processingInput, signal);

    return { success: true };
  },
);

export function queuedMessageRejection(
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

function isQueuedRejectionDeliveryType(contextType: string): boolean {
  const deliveryTypes: readonly string[] = [
    "slack",
    "feishu",
    "teams",
    "discord",
    "wechat",
    "telegram",
    "agentphone",
  ];
  return deliveryTypes.includes(contextType);
}

function queuedRejectionChannelContext(
  head: QueuedRejectionHead,
  featureSwitchContext: FeatureSwitchContext,
) {
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
  return { source, delivery };
}

const loadQueuedRejectionChannel$ = command(
  async (
    { set },
    head: QueuedRejectionHead,
    signal: AbortSignal,
  ): Promise<QueuedAdmissionFailureChannel | undefined> => {
    const contextType = head.contextType;
    if (contextType === null || !isQueuedRejectionDeliveryType(contextType)) {
      return undefined;
    }
    const db = set(writeDb$);
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      head.orgId,
      head.userId,
      signal,
    );
    signal.throwIfAborted();
    const { source, delivery } = queuedRejectionChannelContext(
      head,
      featureSwitchContext,
    );
    switch (contextType) {
      case "slack": {
        const material = await set(loadSlackQueuedLaunchMaterial$, source);
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Slack", target: material.slackDelivery }
          : undefined;
      }
      case "feishu": {
        const material = await (async () => {
          const context = await (async () => {
            const plan = feishuQueuedLaunchContextReadPlan(source);
            const [row] = await db
              .select(plan.columns)
              .from(chatEvents)
              .innerJoin(chatFeishuContext, plan.contextJoin)
              .innerJoin(feishuChatThreadRoutes, plan.routeJoin)
              .innerJoin(feishuOrgConnections, plan.connectionJoin)
              .innerJoin(feishuOrgInstallations, plan.installationJoin)
              .where(plan.condition)
              .limit(1);
            if (
              row &&
              !(await (async () => {
                const availability = feishuInstallationAvailabilityReadPlan({
                  ...row,
                  orgId: source.orgId,
                });
                if (availability.kind === "resolved") {
                  return availability.enabled;
                }
                const rows = await db
                  .select(availability.columns)
                  .from(userFeatureSwitches)
                  .where(availability.condition);
                return feishuInstallationEnabledFromRows(
                  availability.scope,
                  rows,
                );
              })())
            ) {
              return null;
            }
            return requiredFeishuLaunchContext(row);
          })();
          return feishuQueuedLaunchMaterialFromContext(
            context,
            source.featureSwitchContext,
          );
        })();
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Feishu", target: material.feishuDelivery }
          : undefined;
      }
      case "teams": {
        const material = await set(
          loadTeamsQueuedLaunchMaterial$,
          source,
          signal,
        );
        return material
          ? { ...delivery, kind: "Teams", target: material.teamsDelivery }
          : undefined;
      }
      case "discord": {
        const material = await set(
          loadDiscordQueuedLaunchMaterial$,
          source,
          signal,
        );
        return material
          ? { ...delivery, kind: "Discord", target: material.discordDelivery }
          : undefined;
      }
      case "wechat": {
        const material = await set(
          loadWechatQueuedLaunchMaterial$,
          source,
          signal,
        );
        return material
          ? { ...delivery, kind: "Wechat", target: material.wechatDelivery }
          : undefined;
      }
      case "telegram": {
        const material = await set(loadTelegramQueuedLaunchMaterial$, source);
        signal.throwIfAborted();
        return material
          ? { ...delivery, kind: "Telegram", target: material.telegramDelivery }
          : undefined;
      }
      case "agentphone": {
        const material = await set(loadAgentPhoneQueuedLaunchMaterial$, source);
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

export const handleChatInternalCallback$ = command(
  async (
    { set },
    input: { readonly callback: InternalRunCallbackEnvelope },
    signal: AbortSignal,
  ): Promise<
    | { readonly success: true }
    | { readonly success: false; readonly error: string }
  > => {
    set(writeDb$);
    return await set(
      processChatInternalCallback$,
      {
        callback: input.callback,
      },
      signal,
    );
  },
);
