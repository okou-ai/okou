import {
  publishChatThreadMessageCreated$,
  projectCommittedChatThreadSearch$,
} from "./chat-event-publication.service";
import {
  emailDeliveryTargetSchema,
  type EmailDeliveryTarget,
} from "./email-chat-callback-payload";
import { createEmailQueuedDelivery } from "./email-queued-launch-context.service";
import {
  dispatchEmailChatDeliveryOnce$,
  deliverEmailChatAdmissionFailure$,
} from "./internal-email-chat-run-callback.service";
import {
  wechatDeliveryTargetSchema,
  type WechatDeliveryTarget,
} from "./wechat-chat-callback-payload";
import { loadWechatQueuedDelivery$ } from "./wechat-context.service";
import { reconcileWechatThreadTyping$ } from "./wechat-thread-typing.service";
import {
  sendWechatChatReply$,
  dispatchWechatChatDelivery$,
} from "./wechat-delivery.service";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { v5 as uuidv5 } from "uuid";

import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";
import { publicProviderBalanceFailureReason } from "@okouai/api-contracts/contracts/run-balance-errors";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { serializeError } from "@okouai/core/log-utils";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { DatabaseError } from "pg";
import { object, string, type infer as zInfer } from "zod";

import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatIndicatorsChangedSafely,
  publishChatThreadDetailChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { recordLastEventToComplete$ } from "./internal-chat-run-output-timing.service";
import { settle, settleIncludingAbort, tapError, throwIfAbort } from "../utils";
import {
  agentphoneDeliveryTargetSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import { createAgentPhoneQueuedDelivery } from "./agentphone-queued-launch-context.service";
import { integrationCompletionFallbackEventIdForRun } from "./assistant-event-id";
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
  QueuedUserMessageTriggerSource,
} from "./chat-queued-event.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import { dispatchConfiguredChatRunFinishedEvent$ } from "./chat-run-finished-event-dispatch.service";
import {
  canonicalDeliveryEventReadPlan,
  integrationCompletionFallbackReadPlan,
  loadTerminalChatCallback$,
  loadTerminalChatCallbackLocator$,
  requireSourceChatCallback$,
  runLifecycleMarkerReadPlan,
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
import { loadDiscordQueuedDelivery$ } from "./discord-queued-launch-context.service";
import { scheduleDiscordRunTyping$ } from "./discord-run-typing.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  feishuDeliveryTargetSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import {
  createFeishuLaunchContext,
  feishuDeliveryFromContext,
} from "./feishu-queued-launch-context.service";
import {
  FEISHU_RUN_FILE_INDEX_KIND,
  type FeishuRunFileIndex,
} from "./feishu-run-file-index";
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
import type {
  InternalRunCallbackEnvelope,
  TerminalRunCallbackKind,
} from "./internal-run-callback";
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
import { sendUserPushNotifications$ } from "./push-notifications.service";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import { saveRunSummary$ } from "./run-summary.service";
import { createSlackQueuedDelivery } from "./slack-queued-launch-context.service";
import {
  slackChatDeliveryFields,
  type SlackDeliveryTarget,
} from "./slack-chat-callback-payload";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import { createTeamsQueuedDelivery } from "./teams-queued-launch-context.service";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import { createTelegramQueuedDelivery } from "./telegram-queued-launch-context.service";

const log = logger("callback:chat");
const chatCallbackPayloadSchema = object({
  threadId: string(),
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
  emailDelivery: emailDeliveryTargetSchema.optional(),
  agentphoneDelivery: agentphoneDeliveryTargetSchema.optional(),
}).passthrough();

type ChatCallbackPayload = zInfer<typeof chatCallbackPayloadSchema>;

type CompletedChatCallbackResult =
  | {
      readonly outcome: "written" | "replayed";
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
      readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
    }
  | DuplicateTerminalCallback;

type FailedChatCallbackResult =
  | {
      readonly outcome: "written" | "replayed";
      readonly displayErrorMessage: string;
      readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
    }
  | DuplicateTerminalCallback;

type TerminalChatCallbackWork =
  | DuplicateTerminalCallback
  | {
      readonly outcome: "written" | "replayed";
      readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
      readonly runFinishedEvent: ChatRunFinishedEvent;
      readonly deferredSideEffects:
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
    };

export type RunLaunchCallbackRecord =
  | {
      readonly internalKind: TerminalRunCallbackKind;
      readonly payload: unknown;
    }
  | {
      readonly internalKind: typeof FEISHU_RUN_FILE_INDEX_KIND;
      readonly payload: FeishuRunFileIndex;
    };

export function queuedChatRunCallbackInputs(input: {
  readonly threadId: string;
  readonly queuedMessageId: string;
  readonly delivery: QueuedIntegrationDeliveries;
}): RunLaunchCallbackRecord[] {
  const callbacks: RunLaunchCallbackRecord[] = [
    {
      internalKind: "chat",
      payload: {
        threadId: input.threadId,
        queuedMessageId: input.queuedMessageId,
        ...input.delivery,
      },
    },
  ];
  const feishu = input.delivery.feishuDelivery;
  if (feishu?.files?.length) {
    callbacks.push({
      internalKind: FEISHU_RUN_FILE_INDEX_KIND,
      payload: {
        installationId: feishu.installationId,
        chatId: feishu.chatId,
        messageId: feishu.messageId,
        connectionId: feishu.connectionId,
        files: feishu.files,
      },
    });
  }
  return callbacks;
}

const CHAT_DELIVERY_CALLBACK_NAMESPACE = "3c3c6fe0-1041-4d9b-8fbc-403eec20e47b";

type ChatDeliveryKind =
  | "slack:chat"
  | "wechat:chat"
  | "feishu:chat"
  | "teams:chat"
  | "telegram:chat"
  | "email:chat"
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
    const id = uuidv5(
      `${args.sourceCallbackId}:${args.internalKind}:${args.chatEventId}`,
      CHAT_DELIVERY_CALLBACK_NAMESPACE,
    );
    await database
      .insert(agentRunCallbacks)
      .values({
        id,
        runId: args.runId,
        internalKind: args.internalKind,
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

function emailChatDeliveryFields(
  target: EmailDeliveryTarget,
  chatEventId: string,
) {
  return {
    internalKind: "email:chat" as const,
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

const publishAssistantErrorEventSignals$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly threadId: string;
      readonly lifecycleEvent: "failed" | "cancelled";
      readonly hasCancellationRecoveryState: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.threadId,
      },
      signal,
    );
    await publishThreadListChangedSafely({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    // The Run's terminal status committed before its callback wrote this marker.
    await publishChatIndicatorsChangedSafely({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    if (
      args.lifecycleEvent === "cancelled" &&
      args.hasCancellationRecoveryState
    ) {
      await publishChatThreadDetailChangedSafely(args.userId, args.threadId);
      signal.throwIfAborted();
    }
  },
);

const publishRunLifecycleMarkerSignals$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly threadId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.threadId,
      },
      signal,
    );
    await publishThreadListChangedSafely({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    // The Run's terminal status committed before its callback wrote this marker.
    await publishChatIndicatorsChangedSafely({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
  },
);

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
  readonly emailDelivery?: EmailDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly sourceCallbackId: string;
}

interface TerminalEventProjection {
  readonly markerInserted: boolean;
  readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
}

interface DuplicateTerminalCallback {
  readonly outcome: "duplicate";
  readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
}

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
  inserted: TerminalEventProjection,
): FailedChatCallbackResult {
  return {
    displayErrorMessage,
    outcome: inserted.markerInserted ? "written" : "replayed",
    deliveryReceipts: inserted.deliveryReceipts,
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

const insertEmailDeliveryCallback$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly sourceCallbackId: string;
      readonly emailDelivery?: EmailDeliveryTarget;
      readonly chatEventId: string;
    },
  ) => {
    if (!args.emailDelivery) {
      return undefined;
    }
    return await set(insertChatDeliveryCallback$, {
      runId: args.runId,
      sourceCallbackId: args.sourceCallbackId,
      ...emailChatDeliveryFields(args.emailDelivery, args.chatEventId),
    });
  },
);

const insertAssistantErrorEvent$ = command(
  async (
    { set },
    input: AssistantErrorEventArgs,
    signal: AbortSignal,
  ): Promise<FailedChatCallbackResult> => {
    const database = set(writeDb$);
    const { displayErrorMessage } = input;
    signal.throwIfAborted();
    const inserted =
      await (async (): Promise<TerminalEventProjection | null> => {
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
        const emailDeliveryCallbackId = await set(
          insertEmailDeliveryCallback$,
          { ...input, chatEventId: event.id },
        );
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
          deliveryReceipts: {
            slackDeliveryCallbackId,
            feishuDeliveryCallbackId,
            teamsDeliveryCallbackId,
            discordReply,
            wechatDeliveryCallbackId,
            telegramDeliveryCallbackId,
            emailDeliveryCallbackId,
            agentphoneDeliveryCallbackId,
          },
        };
      })();
    signal.throwIfAborted();
    if (!inserted) {
      return { outcome: "duplicate", deliveryReceipts: {} };
    }

    // Replays repeat the monotonic touch and publishes because an earlier
    // attempt may have failed after its marker committed.
    await set(
      touchChatThreadLastMessageAtIndependently$,
      input.threadId,
      assistantErrorEventTouchOptions(input),
      signal,
    );
    await set(publishAssistantErrorEventSignals$, input, signal);
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
  readonly emailDelivery?: EmailDeliveryTarget;
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
  readonly emailDeliveryCallbackId?: string;
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
    | "emailDelivery"
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
    args.emailDelivery ||
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
      args.emailDelivery ||
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
    const emailDeliveryCallbackId =
      deliveryEvent && input.emailDelivery
        ? await set(insertChatDeliveryCallback$, {
            runId: input.runId,
            sourceCallbackId: input.sourceCallbackId,
            ...emailChatDeliveryFields(input.emailDelivery, deliveryEvent.id),
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
      emailDeliveryCallbackId,
      agentphoneDeliveryCallbackId,
    };
  },
);

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

const insertRunLifecycleMarker$ = command(
  async (
    { set },
    args: RunLifecycleMarkerArgs,
    signal: AbortSignal,
  ): Promise<
    | DuplicateTerminalCallback
    | {
        readonly outcome: "written" | "replayed";
        readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
      }
  > => {
    signal.throwIfAborted();
    const markerCreatedAt = nowDate();
    const tx = set(writeDb$);
    const input = { ...args };
    const inserted =
      await (async (): Promise<TerminalEventProjection | null> => {
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
          deliveryReceipts: await set(
            registerRunLifecycleDeliveryCallbacks$,
            input,
            deliveryEvent,
            marker !== null,
          ),
        };
      })();
    signal.throwIfAborted();
    if (!inserted) {
      return { outcome: "duplicate", deliveryReceipts: {} };
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
    await set(publishRunLifecycleMarkerSignals$, args, signal);
    signal.throwIfAborted();
    return {
      outcome: inserted.markerInserted ? "written" : "replayed",
      deliveryReceipts: inserted.deliveryReceipts,
    };
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
    args: { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<readonly ChatCompletionContextMessage[]> => {
    const result = await tapError(
      set(loadChatThreadRecommendedFollowupContext$, args, signal),
      (err) => {
        log.warn("Recommended follow-up context load failed", {
          threadId: args.threadId,
          err,
        });
      },
    );
    signal.throwIfAborted();
    return result ?? [];
  },
);

const materializeCompletedChatResult$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly chatThread: ChatThreadForRunRow;
      readonly output: CompletedRunOutput;
      readonly preferResultFallback: boolean;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { latestAssistant, resultFallback } = args.output;
    const shouldInsertResultFallback =
      resultFallback !== null &&
      (latestAssistant === null ||
        (args.preferResultFallback &&
          resultFallback.sequenceNumber > latestAssistant.sequenceNumber &&
          resultFallback.content !== latestAssistant.content));
    if (shouldInsertResultFallback) {
      const inserted = await set(
        insertAssistantEvents$,
        {
          runId: args.runId,
          threadId: args.chatThread.chatThreadId,
          userId: args.chatThread.userId,
          orgId: args.chatThread.orgId,
          items: [
            {
              eventType: "output.message",
              runEventSequenceNumber: resultFallback.sequenceNumber,
              content: resultFallback.content,
              runEventId: `callback:${resultFallback.sequenceNumber}`,
            },
          ],
        },
        signal,
      );
      if (inserted > 0) {
        waitUntil(
          set(
            projectCommittedChatThreadSearch$,
            {
              userId: args.chatThread.userId,
              orgId: args.chatThread.orgId,
              threadId: args.chatThread.chatThreadId,
            },
            signal,
          ),
        );
      }
      signal.throwIfAborted();
      return resultFallback.content;
    }
    return latestAssistant?.content ?? null;
  },
);

function completedChatResultInput(
  args: ReturnType<typeof terminalIntegrationDeliveries> & {
    readonly runId: string;
    readonly chatThread: ChatThreadForRunRow;
  },
  output: CompletedRunOutput,
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
      args.emailDelivery !== undefined ||
      args.agentphoneDelivery !== undefined,
  };
}

const handleCompletedChatCallback$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly emailDelivery?: EmailDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<CompletedChatCallbackResult> => {
    const output = await set(loadCompletedRunOutput$, {
      runId: args.runId,
      lastEventSequence: args.run.lastEventSequence,
    });
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

    const inserted = await set(
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
        emailDelivery: args.emailDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        sourceCallbackId: args.sourceCallbackId,
      },
      signal,
    );
    signal.throwIfAborted();
    waitUntil(
      set(
        projectCommittedChatThreadSearch$,
        {
          userId: args.chatThread.userId,
          orgId: args.chatThread.orgId,
          threadId: args.chatThread.chatThreadId,
        },
        signal,
      ),
    );
    if (inserted.outcome === "duplicate") {
      return inserted;
    }

    const followupContext = await set(
      loadRecommendedFollowupContextForCompletedRun$,
      { threadId: args.chatThread.chatThreadId },
      signal,
    );
    signal.throwIfAborted();

    return {
      lastResultText,
      followupContext,
      outcome: inserted.outcome,
      deliveryReceipts: inserted.deliveryReceipts,
    };
  },
);

/** Child errors can contain private provider responses, SQL and parameters. */
function completedChatCallbackFailure(
  operation: "save_summary" | "followups" | "push",
  error: unknown,
) {
  const sqlState =
    error instanceof Error && error.cause instanceof DatabaseError
      ? safeSqlStateCode(error)
      : undefined;
  return {
    operation,
    reason: sqlState
      ? "database_error"
      : error instanceof TypeError
        ? "type_error"
        : error instanceof SyntaxError
          ? "syntax_error"
          : error instanceof Error
            ? "error"
            : "non_error",
    ...(sqlState === undefined ? {} : { sqlState }),
  };
}

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
    // Summary, follow-ups, and push run independently in the background.
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
        const inserted = await set(
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
        if (inserted) {
          waitUntil(
            set(
              projectCommittedChatThreadSearch$,
              {
                userId: args.chatThread.userId,
                orgId: args.chatThread.orgId,
                threadId: args.chatThread.chatThreadId,
              },
              signal,
            ),
          );
        }
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
      return [completedChatCallbackFailure(operation, result.reason)];
    });
    if (failures.length > 0) {
      // `cause` preserves the finite projection through Error serialization.
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
      readonly failureReason: RunFailureReasonToken | null;
      readonly lifecycleEvent: "failed" | "cancelled";
      readonly hasCancellationRecoveryState: boolean;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly emailDelivery?: EmailDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<FailedChatCallbackResult> => {
    const lifecycleEvent = args.lifecycleEvent;
    const displayErrorMessage = await set(
      formatRunErrorForRunOwner$,
      {
        chatThreadId: args.chatThread.chatThreadId,
        runId: args.runId,
        externalSurface: hasExternalNotificationDeliveryChannel(args),
      },
      signal,
    );
    signal.throwIfAborted();
    const result = await set(
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
        emailDelivery: args.emailDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        sourceCallbackId: args.sourceCallbackId,
      },
      signal,
    );
    waitUntil(
      set(
        projectCommittedChatThreadSearch$,
        {
          userId: args.chatThread.userId,
          orgId: args.chatThread.orgId,
          threadId: args.chatThread.chatThreadId,
        },
        signal,
      ),
    );
    return result;
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

export interface QueuedChatPromptData {
  readonly threadId: string;
  readonly userId: string;
  readonly agent: {
    readonly id: string;
    readonly orgId: string;
  };
  readonly queuedMessage: QueuedUserMessage;
}

type QueuedIntegrationDeliveries = Pick<
  ChatCallbackPayload,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "discordDelivery"
  | "wechatDelivery"
  | "telegramDelivery"
  | "emailDelivery"
  | "agentphoneDelivery"
>;

export interface QueuedLaunchMaterial {
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly delivery: QueuedIntegrationDeliveries;
}

function unreachableQueuedContextType(contextType: never): never {
  throw new Error(`Unsupported queued context type: ${String(contextType)}`);
}

function requiredQueuedDelivery<Delivery>(
  delivery: Delivery | undefined,
  contextType: QueuedUserMessage["contextType"],
): Delivery {
  if (!delivery) {
    throw new Error(`${contextType} queue item is missing delivery material`);
  }
  return delivery;
}

export function queuedPromptRejectionContext(
  input: QueuedChatPromptData,
  delivery: QueuedIntegrationDeliveries,
): Omit<ChatQueueHeadRejection, "error"> {
  const channel = queuedPromptRejectionChannel(input, delivery);
  return {
    userId: input.userId,
    ...(channel ? { delivery: { kind: "channel", channel } } : {}),
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
        readonly kind: "Email";
        readonly agentId: string;
        readonly target: EmailDeliveryTarget;
      }
    | {
        readonly kind: "AgentPhone";
        readonly agentId: string;
        readonly target: AgentPhoneDeliveryTarget;
      }
  );

/** Web admissions have no integration delivery. */
function queuedPromptRejectionChannel(
  input: QueuedChatPromptData,
  delivery: QueuedIntegrationDeliveries,
): QueuedAdmissionFailureChannel | undefined {
  const base = {
    chatThreadId: input.threadId,
    userId: input.userId,
    orgId: input.agent.orgId,
  };
  const agentId = input.agent.id;
  const contextType = input.queuedMessage.contextType;
  switch (contextType) {
    case "web":
    case "agent_run": {
      return undefined;
    }
    case "slack": {
      return {
        ...base,
        kind: "Slack",
        agentId,
        target: requiredQueuedDelivery(delivery.slackDelivery, contextType),
      };
    }
    case "feishu": {
      return {
        ...base,
        kind: "Feishu",
        target: requiredQueuedDelivery(delivery.feishuDelivery, contextType),
      };
    }
    case "teams": {
      return {
        ...base,
        kind: "Teams",
        agentId,
        target: requiredQueuedDelivery(delivery.teamsDelivery, contextType),
      };
    }
    case "discord": {
      return {
        ...base,
        kind: "Discord",
        target: requiredQueuedDelivery(delivery.discordDelivery, contextType),
      };
    }
    case "wechat": {
      return {
        ...base,
        kind: "Wechat",
        target: requiredQueuedDelivery(delivery.wechatDelivery, contextType),
      };
    }
    case "telegram": {
      return {
        ...base,
        kind: "Telegram",
        agentId,
        target: requiredQueuedDelivery(delivery.telegramDelivery, contextType),
      };
    }
    case "email": {
      return {
        ...base,
        kind: "Email",
        agentId,
        target: requiredQueuedDelivery(delivery.emailDelivery, contextType),
      };
    }
    case "agentphone": {
      return {
        ...base,
        kind: "AgentPhone",
        agentId,
        target: requiredQueuedDelivery(
          delivery.agentphoneDelivery,
          contextType,
        ),
      };
    }
    default: {
      return unreachableQueuedContextType(contextType);
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
      case "Email": {
        await set(
          deliverEmailChatAdmissionFailure$,
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

/** The committed run's title and typing observations need no read plan. */
export interface QueuedPromptLaunchContext {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly prompt: string;
  readonly triggerSource: QueuedUserMessageTriggerSource;
  readonly discordDelivery?: DiscordDeliveryTarget;
  readonly wechatDelivery?: WechatDeliveryTarget;
  readonly integrationContext?: string;
  /** The claimed thread snapshot already had a title or rename. */
  readonly titled: boolean;
}

export const recordQueuedPromptRunLaunch$ = command(
  (
    { set },
    args: QueuedPromptLaunchContext,
    runId: string,
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    set(writeDb$);
    const { threadId, userId } = args;
    waitUntil(
      set(
        generateAndPersistChatThreadTitle$,
        {
          threadId,
          userId,
          orgId: args.orgId,
          prompt: args.prompt,
          integrationContext: args.integrationContext,
          includePriorRounds: true,
          titled: args.titled,
        },
        signal,
      ),
    );
    if (args.discordDelivery) {
      set(scheduleDiscordRunTyping$, {
        runId,
        chatThreadId: threadId,
        target: args.discordDelivery,
      });
    }
    if (args.wechatDelivery) {
      waitUntil(
        set(
          reconcileWechatThreadTyping$,
          { chatThreadId: threadId, target: args.wechatDelivery },
          new AbortController().signal,
        ),
      );
    }
  },
);

const prepareCompletedTerminalChatCallbackWork$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly emailDelivery?: EmailDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackWork> => {
    const completed = await set(handleCompletedChatCallback$, args, signal);
    signal.throwIfAborted();
    if (completed.outcome === "duplicate") {
      return completed;
    }

    return {
      outcome: completed.outcome,
      deliveryReceipts: completed.deliveryReceipts,
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
      readonly slackDelivery?: SlackDeliveryTarget;
      readonly feishuDelivery?: FeishuDeliveryTarget;
      readonly teamsDelivery?: TeamsDeliveryTarget;
      readonly discordDelivery?: DiscordDeliveryTarget;
      readonly wechatDelivery?: WechatDeliveryTarget;
      readonly telegramDelivery?: TelegramDeliveryTarget;
      readonly emailDelivery?: EmailDeliveryTarget;
      readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackWork> => {
    const failed = await set(
      handleFailedChatCallback$,
      {
        ...args,
        lifecycleEvent:
          args.run.status === "cancelled" ? "cancelled" : "failed",
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
    signal.throwIfAborted();
    if (failed.outcome === "duplicate") {
      return failed;
    }

    const runStatus = args.run.status === "cancelled" ? "cancelled" : "failed";
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
      deliveryReceipts: failed.deliveryReceipts,
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

const dispatchCanonicalEmailDelivery$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly status: "completed" | "failed";
      readonly emailDeliveryCallbackId: string | undefined;
    },
    signal: AbortSignal,
  ) => {
    if (!args.emailDeliveryCallbackId) {
      return;
    }
    const delivery = await settle(
      set(
        dispatchEmailChatDeliveryOnce$,
        args.emailDeliveryCallbackId,
        args.status,
        signal,
      ),
      signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical Email delivery callback", {
        runId: args.runId,
        callbackId: args.emailDeliveryCallbackId,
        error: delivery.error,
      });
    }
  },
);

const dispatchCanonicalDeliveryCallbacks$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly status: "completed" | "failed";
      readonly deliveryReceipts: RunLifecycleDeliveryCallbacks;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { deliveryReceipts } = args;
    if (deliveryReceipts.slackDeliveryCallbackId) {
      const delivery = await settle(
        set(
          dispatchSlackChatDeliveryOnce$,
          deliveryReceipts.slackDeliveryCallbackId,
          signal,
        ),
        signal,
      );
      if (!delivery.ok) {
        log.error("Failed to finalize canonical Slack delivery callback", {
          runId: args.runId,
          callbackId: deliveryReceipts.slackDeliveryCallbackId,
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
        callbackId: deliveryReceipts.feishuDeliveryCallbackId,
      },
      {
        name: "Teams",
        callbackId: deliveryReceipts.teamsDeliveryCallbackId,
      },
      {
        name: "Telegram",
        callbackId: deliveryReceipts.telegramDeliveryCallbackId,
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
    await set(
      dispatchCanonicalEmailDelivery$,
      {
        runId: args.runId,
        status: args.status,
        emailDeliveryCallbackId: deliveryReceipts.emailDeliveryCallbackId,
      },
      signal,
    );
    if (deliveryReceipts.agentphoneDeliveryCallbackId) {
      const delivery = await settle(
        set(
          dispatchAgentPhoneChatDeliveryOnce$,
          deliveryReceipts.agentphoneDeliveryCallbackId,
          args.status,
          signal,
        ),
        signal,
      );
      if (!delivery.ok) {
        log.error("Failed to finalize canonical AgentPhone delivery callback", {
          runId: args.runId,
          callbackId: deliveryReceipts.agentphoneDeliveryCallbackId,
          error: delivery.error,
        });
      }
    }
    if (deliveryReceipts.wechatDeliveryCallbackId) {
      await set(
        dispatchWechatChatDelivery$,
        deliveryReceipts.wechatDeliveryCallbackId,
        signal,
      );
    }
    if (deliveryReceipts.discordReply) {
      await set(sendDiscordChatReply$, deliveryReceipts.discordReply, signal);
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
  | "emailDelivery"
  | "agentphoneDelivery"
> {
  return {
    slackDelivery: payload.slackDelivery,
    feishuDelivery: payload.feishuDelivery,
    teamsDelivery: payload.teamsDelivery,
    discordDelivery: payload.discordDelivery,
    wechatDelivery: payload.wechatDelivery,
    telegramDelivery: payload.telegramDelivery,
    emailDelivery: payload.emailDelivery,
    agentphoneDelivery: payload.agentphoneDelivery,
  };
}

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
        deliveryReceipts: args.work.deliveryReceipts,
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

    const { work } = args;
    if (work.outcome === "duplicate") {
      return;
    }

    // A committed marker must not acknowledge an unfinished automation. Throw
    // back to the existing callback owner so its failed/pending row can retry.
    await set(
      dispatchConfiguredChatRunFinishedEvent$,
      work.runFinishedEvent,
      signal,
    );
    signal.throwIfAborted();

    // Scheduling is the last step, so a replay after an earlier attempt threw
    // must schedule it. The source callback has no attempt claim: a replay can
    // also follow an attempt that reached this point but failed its final
    // acknowledgement, or overlap a concurrent redrive. That residual is
    // at-least-once for summary, follow-up generation and push.
    const { deferredSideEffects } = work;
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
                  displayErrorMessage: deferredSideEffects.displayErrorMessage,
                  sendClientPush,
                },
                backgroundSignal,
              ),
      }),
    );
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

    let persistedThreadId: string | undefined;
    const prepared = await settle(
      (async () => {
        const existing = await set(loadTerminalChatCallbackLocator$, runId);
        signal.throwIfAborted();
        if (!existing?.threadId || existing.triggerSource === null) {
          return null;
        }
        // Retain only a content-free persisted locator across capture failure.
        persistedThreadId = existing.threadId;
        const loaded = await set(
          loadTerminalChatCallback$,
          {
            runId,
            callbackStatus,
            payloadThreadId: args.payload.threadId,
          },
          signal,
        );
        if (!loaded) {
          return null;
        }
        const { run, chatThread } = loaded;
        const sourceCallbackId = await set(requireSourceChatCallback$, {
          runId,
          sourceCallbackId: args.callback.callbackId,
        });
        signal.throwIfAborted();
        const preparation = {
          runId,
          run,
          chatThread,
          ...terminalIntegrationDeliveries(args.payload),
          sourceCallbackId,
        };
        const work = await (run.status === "completed"
          ? set(prepareCompletedTerminalChatCallbackWork$, preparation, signal)
          : set(prepareFailedTerminalChatCallbackWork$, preparation, signal));
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
    { get, set },
    head: QueuedRejectionHead,
    signal: AbortSignal,
  ): Promise<QueuedAdmissionFailureChannel | undefined> => {
    const owner = {
      chatThreadId: head.chatThreadId,
      orgId: head.orgId,
      userId: head.userId,
    };
    const source = { ...owner, eventId: head.id };
    const delivery = { ...owner, agentId: head.agentId };
    signal.throwIfAborted();
    switch (head.contextType) {
      case "slack": {
        const target = await get(createSlackQueuedDelivery(source));
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "Slack", target } : undefined;
      }
      case "feishu": {
        const context = await get(createFeishuLaunchContext(source));
        signal.throwIfAborted();
        return context
          ? {
              ...delivery,
              kind: "Feishu",
              target: feishuDeliveryFromContext(context),
            }
          : undefined;
      }
      case "teams": {
        const target = await get(createTeamsQueuedDelivery(source));
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "Teams", target } : undefined;
      }
      case "discord": {
        const target = await set(loadDiscordQueuedDelivery$, source, signal);
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "Discord", target } : undefined;
      }
      case "wechat": {
        const target = await set(loadWechatQueuedDelivery$, source, signal);
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "Wechat", target } : undefined;
      }
      case "telegram": {
        const target = await get(createTelegramQueuedDelivery(source));
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "Telegram", target } : undefined;
      }
      case "email": {
        const featureSwitchContext = await set(
          loadUserFeatureSwitchContext$,
          head.orgId,
          head.userId,
          signal,
        );
        signal.throwIfAborted();
        const target = await get(
          createEmailQueuedDelivery({ ...source, featureSwitchContext }),
        );
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "Email", target } : undefined;
      }
      case "agentphone": {
        const target = await get(createAgentPhoneQueuedDelivery(source));
        signal.throwIfAborted();
        return target ? { ...delivery, kind: "AgentPhone", target } : undefined;
      }
      default: {
        return undefined;
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
