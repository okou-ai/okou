import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { and, eq, isNotNull } from "drizzle-orm";
import { delay } from "signal-timers";
import { logger } from "../../lib/log";
import {
  buildTelegramResponse,
  escapeHtml,
  splitMessage,
} from "../../lib/telegram-format";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  deleteMessage,
  sendChatAction,
  sendMessage,
  type SendTelegramMessageResult,
} from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { now, nowDate } from "../../lib/time";
import { bestEffort, settleIncludingAbort } from "../utils";
import {
  telegramChatCallbackPayloadSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import {
  persistTelegramReplyChainRoute$,
  type TelegramOwnerLink,
} from "./telegram-chat-ingress.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { storeTelegramBotMessage$ } from "./telegram-callback-persistence.service";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";

const L = logger("InternalCallbacksTelegramChat");
const TELEGRAM_COMPLETION_CHUNK_THROTTLE_MS = 1100;

interface ClaimedTelegramChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

interface TelegramChatRunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly agentId: string;
}

interface TelegramOwnerBinding {
  readonly botToken: string;
  readonly ownerLink: TelegramOwnerLink;
}

function recordDelivery(args: {
  readonly runId: string;
  readonly startedAt: number;
  readonly success: boolean;
  readonly outcome: "delivered" | "failed" | "skipped_revoked";
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "telegram_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

function telegramOwnerWhere(ownerLink: TelegramOwnerLink) {
  return eq(telegramChatThreadRoutes.telegramOfficialUserLinkId, ownerLink.id);
}

/** Preserve the route read outcome; the existing delivery checks own cancellation. */
const loadTelegramDeliveryRoute$ = command(
  async (
    { get },
    args: {
      readonly ownerLink: TelegramOwnerLink;
      readonly chatId: string;
      readonly rootMessageId: string;
      readonly chatThreadId: string;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const db = get(db$);
    return await db
      .select({ id: telegramChatThreadRoutes.id })
      .from(telegramChatThreadRoutes)
      .where(
        and(
          telegramOwnerWhere(args.ownerLink),
          eq(telegramChatThreadRoutes.chatId, args.chatId),
          eq(telegramChatThreadRoutes.rootMessageId, args.rootMessageId),
          eq(telegramChatThreadRoutes.chatThreadId, args.chatThreadId),
        ),
      )
      .limit(1);
  },
);

const loadTelegramChatDeliveryContext$ = command(
  async (
    { get, set },
    args: {
      readonly callback: ClaimedTelegramChatDelivery;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const payload = telegramChatCallbackPayloadSchema.parse(
      args.callback.payload,
    );
    const [run] = await db
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
        agentId: agents.id,
      })
      .from(agentRuns)
      .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(agentRuns.id, args.callback.runId),
          eq(agentRuns.triggerSource, "telegram"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      throw new Error("Telegram chat delivery run context is unavailable");
    }
    const runContext: TelegramChatRunContext = {
      userId: run.userId,
      orgId: run.orgId,
      chatThreadId: run.chatThreadId,
      agentId: run.agentId,
    };

    const [event] = await db
      .select({ content: canonicalChatEventContent() })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, payload.chatEventId),
          eq(chatEvents.runId, args.callback.runId),
          eq(chatEvents.chatThreadId, run.chatThreadId),
          chatEventTypeIn([
            "output.message",
            "output.error",
            "run.failed",
            "run.cancelled",
          ]),
          isNotNull(canonicalChatEventContent()),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!event?.content) {
      throw new Error("Telegram chat delivery message is unavailable");
    }

    let binding: TelegramOwnerBinding | undefined;
    // Only the official shared bot can deliver run callbacks.
    if (isOfficialTelegramBotId(payload.installationId)) {
      const [link] = await db
        .select({ id: telegramOfficialUserLinks.id })
        .from(telegramOfficialUserLinks)
        .where(
          and(
            eq(telegramOfficialUserLinks.id, payload.userLinkId),
            eq(telegramOfficialUserLinks.userId, runContext.userId),
            eq(telegramOfficialUserLinks.orgId, runContext.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      const botToken = getOfficialTelegramBotConfig().botToken;
      binding =
        link && botToken
          ? {
              botToken,
              ownerLink: { kind: "official", id: link.id },
            }
          : undefined;
    }
    signal.throwIfAborted();
    if (binding) {
      if (payload.rootMessageId !== null) {
        const [route] = await set(
          loadTelegramDeliveryRoute$,
          {
            ownerLink: binding.ownerLink,
            chatId: payload.chatId,
            rootMessageId: payload.rootMessageId,
            chatThreadId: runContext.chatThreadId,
          },
          signal,
        );
        const routeBindsRun = route !== undefined;
        if (!routeBindsRun) {
          return { payload, run: runContext, messageContent: event.content };
        }
      }
    }
    return {
      payload,
      run: runContext,
      messageContent: event.content,
      binding,
    };
  },
);

async function waitForTelegramSendDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (delayMs > 0) {
    await delay(delayMs, { signal });
  }
  signal.throwIfAborted();
}

function telegramSendRetryDelayMs(attempt: number): number | undefined {
  switch (attempt) {
    case 0:
    case 1: {
      return 1000;
    }
    case 2: {
      return 2000;
    }
    case 3: {
      return 3000;
    }
    case 4: {
      return 5000;
    }
    default: {
      return undefined;
    }
  }
}

async function sendMessageWithTelegramRateLimitRetry(
  args: {
    readonly botToken: string;
    readonly chatId: string;
    readonly text: string;
    readonly replyToMessageId: number | undefined;
    readonly messageThreadId: number | undefined;
  },
  signal: AbortSignal,
): Promise<SendTelegramMessageResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await sendMessage(args.botToken, args.chatId, args.text, {
      ...(args.replyToMessageId !== undefined
        ? { replyToMessageId: args.replyToMessageId }
        : {}),
      ...(args.messageThreadId !== undefined
        ? { messageThreadId: args.messageThreadId }
        : {}),
    });
    signal.throwIfAborted();
    if (result.kind !== "telegram-error" || result.status !== 429) {
      return result;
    }
    const retryDelayMs = telegramSendRetryDelayMs(attempt);
    if (retryDelayMs === undefined) {
      return result;
    }
    L.warn("Canonical Telegram sendMessage rate limited; retrying", {
      attempt: attempt + 1,
      retryDelayMs,
    });
    await waitForTelegramSendDelay(retryDelayMs, signal);
  }
}

async function sendTelegramCompletionMessages(
  args: {
    readonly botToken: string;
    readonly target: TelegramDeliveryTarget;
    readonly htmlOutput: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "ok"; readonly messageIds: readonly number[] }
  | Extract<SendTelegramMessageResult, { kind: "telegram-error" }>
> {
  const messageIds: number[] = [];
  const chunks = splitMessage(args.htmlOutput);
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) {
      await waitForTelegramSendDelay(
        TELEGRAM_COMPLETION_CHUNK_THROTTLE_MS,
        signal,
      );
    }
    const sent = await sendMessageWithTelegramRateLimitRetry(
      {
        botToken: args.botToken,
        chatId: args.target.chatId,
        text: chunk,
        replyToMessageId: Number(args.target.messageId),
        messageThreadId: args.target.messageThreadId,
      },
      signal,
    );
    if (sent.kind === "telegram-error") {
      return sent;
    }
    messageIds.push(sent.messageId);
  }
  return { kind: "ok", messageIds };
}

async function deleteThinkingMessageIfPresent(args: {
  readonly botToken: string;
  readonly target: TelegramDeliveryTarget;
}): Promise<void> {
  if (!args.target.thinkingMessageId) {
    return;
  }
  await bestEffort(
    deleteMessage(
      args.botToken,
      args.target.chatId,
      Number(args.target.thinkingMessageId),
    ),
  );
}

const persistTelegramChatDelivery$ = command(
  async (
    { set },
    args: {
      readonly run: Pick<TelegramChatRunContext, "orgId" | "chatThreadId">;
      readonly target: TelegramDeliveryTarget;
      readonly ownerLink: TelegramOwnerLink;
      readonly botReplyMessageIds: readonly number[];
      readonly responseText: string | undefined;
      readonly status: "completed" | "failed";
    },
  ): Promise<"delivered"> => {
    const firstMessageId = args.botReplyMessageIds[0];
    if (firstMessageId === undefined) {
      return "delivered";
    }
    await set(storeTelegramBotMessage$, {
      scope: {
        orgId: args.run.orgId,
        userLinkId: args.target.userLinkId,
      },
      chatId: args.target.chatId,
      messageId: firstMessageId,
      text: args.responseText,
    });
    const replyMessageIds = args.target.isDM
      ? args.botReplyMessageIds
      : [firstMessageId];
    for (const messageId of replyMessageIds) {
      await set(persistTelegramReplyChainRoute$, {
        ownerLink: args.ownerLink,
        chatId: args.target.chatId,
        previousRootMessageId: args.target.rootMessageId,
        isDirectMessage: args.target.isDM,
        botReplyMessageId: String(messageId),
        chatThreadId: args.run.chatThreadId,
        runStatus: args.status,
        currentTime: nowDate(),
      });
    }
    return "delivered";
  },
);

const deliverClaimedTelegramChatCallback$ = command(
  async (
    { get, set },
    args: {
      readonly callback: ClaimedTelegramChatDelivery;
      readonly status: "completed" | "failed";
    },
    signal: AbortSignal,
  ): Promise<"delivered" | "skipped_revoked"> => {
    const db = get(db$);
    const { payload, run, messageContent, binding } = await set(
      loadTelegramChatDeliveryContext$,
      args,
      signal,
    );
    if (!binding) {
      return "skipped_revoked";
    }

    await deleteThinkingMessageIfPresent({
      botToken: binding.botToken,
      target: payload,
    });
    signal.throwIfAborted();
    await bestEffort(
      sendChatAction(binding.botToken, payload.chatId, "typing"),
      signal,
    );
    const footerText = await (async (): Promise<string | undefined> => {
      // The official shared bot has no per-bot default agent, so replies never
      // carry a "Responded by" label; only the model label is shown.
      const runId = args.callback.runId;
      const runModel = await (async () => {
        const [row] = await db
          .select(runModelSelectionColumns())
          .from(agentRuns)
          .where(runModelSelectionCondition(runId))
          .limit(1);
        return runModelSelectionFromRow(row);
      })();
      const model = runModel?.selectedModel;
      const modelLabel = model
        ? getRunModelDisplayName(model, runModel?.codexServiceTier)
        : undefined;

      return modelLabel ? escapeHtml(modelLabel) : undefined;
    })();
    signal.throwIfAborted();
    const responseText =
      args.status === "completed" ? messageContent : undefined;
    const sent = await sendTelegramCompletionMessages(
      {
        botToken: binding.botToken,
        target: payload,
        htmlOutput: buildTelegramResponse(messageContent, footerText),
      },
      signal,
    );
    if (sent.kind === "telegram-error") {
      throw new Error(
        `Telegram API error: ${sent.description ?? `HTTP ${sent.status}`}`,
      );
    }
    return await set(persistTelegramChatDelivery$, {
      run,
      target: payload,
      ownerLink: binding.ownerLink,
      botReplyMessageIds: sent.messageIds,
      responseText,
      status: args.status,
    });
  },
);

/** Preserve the claimed outcome even if cancellation arrives during the write. */
const claimTelegramChatDelivery$ = command(
  async (
    { set },
    callbackId: string,
    signal: AbortSignal,
  ): Promise<readonly ClaimedTelegramChatDelivery[]> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    return await db
      .update(agentRunCallbacks)
      .set({ attempts: 1, lastAttemptAt: nowDate() })
      .where(
        and(
          eq(agentRunCallbacks.id, callbackId),
          eq(agentRunCallbacks.internalKind, "telegram:chat"),
          eq(agentRunCallbacks.status, "pending"),
          eq(agentRunCallbacks.attempts, 0),
        ),
      )
      .returning({
        runId: agentRunCallbacks.runId,
        payload: agentRunCallbacks.payload,
      });
  },
);

const tryTelegramChatDelivery$ = command(
  (
    { set },
    callback: ClaimedTelegramChatDelivery,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => {
    return settleIncludingAbort(
      set(deliverClaimedTelegramChatCallback$, { callback, status }, signal),
    );
  },
);

/** The existing terminal write remains awaited after delivery, including abort. */
const completeTelegramChatDelivery$ = command(
  async (
    { set },
    args: {
      readonly callbackId: string;
      readonly runId: string;
      readonly startedAt: number;
    },
    delivery: Awaited<ReturnType<typeof tryTelegramChatDelivery$.write>>,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (!delivery.ok) {
      const message =
        delivery.error instanceof Error
          ? delivery.error.message
          : "Unknown error";
      await db
        .update(agentRunCallbacks)
        .set({ status: "failed", lastError: message.slice(0, 4000) })
        .where(eq(agentRunCallbacks.id, args.callbackId));
      recordDelivery({
        runId: args.runId,
        startedAt: args.startedAt,
        success: false,
        outcome: "failed",
      });
      L.warn("Canonical Telegram delivery failed", {
        callbackId: args.callbackId,
        runId: args.runId,
        error: delivery.error,
      });
      return;
    }
    await db
      .update(agentRunCallbacks)
      .set({ status: "delivered", deliveredAt: nowDate() })
      .where(eq(agentRunCallbacks.id, args.callbackId));
    recordDelivery({
      runId: args.runId,
      startedAt: args.startedAt,
      success: true,
      outcome: delivery.value,
    });
  },
);

export const dispatchTelegramChatDeliveryOnce$ = command(
  async (
    { set },
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = now();
    const [callback] = await set(
      claimTelegramChatDelivery$,
      callbackId,
      signal,
    );
    if (!callback) {
      return;
    }
    const delivery = await set(
      tryTelegramChatDelivery$,
      callback,
      status,
      signal,
    );
    return await set(
      completeTelegramChatDelivery$,
      { callbackId, runId: callback.runId, startedAt },
      delivery,
    );
  },
);

interface TelegramChatAdmissionFailureArgs {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly target: TelegramDeliveryTarget;
  readonly chatEventId: string;
}

export const deliverTelegramChatAdmissionFailure$ = command(
  async (
    { get, set },
    args: TelegramChatAdmissionFailureArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const [event] = await db
      .select({ content: canonicalChatEventContent() })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.chatEventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          chatEventTypeIn(["output.error"]),
          isNotNull(canonicalChatEventContent()),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!event?.content) {
      return;
    }
    let binding: TelegramOwnerBinding | undefined;
    // Only the official shared bot can deliver run callbacks.
    if (isOfficialTelegramBotId(args.target.installationId)) {
      const [link] = await db
        .select({ id: telegramOfficialUserLinks.id })
        .from(telegramOfficialUserLinks)
        .where(
          and(
            eq(telegramOfficialUserLinks.id, args.target.userLinkId),
            eq(telegramOfficialUserLinks.userId, args.userId),
            eq(telegramOfficialUserLinks.orgId, args.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      const botToken = getOfficialTelegramBotConfig().botToken;
      binding =
        link && botToken
          ? {
              botToken,
              ownerLink: { kind: "official", id: link.id },
            }
          : undefined;
    }
    if (!binding) {
      return;
    }
    if (args.target.rootMessageId !== null) {
      const [route] = await set(
        loadTelegramDeliveryRoute$,
        {
          ownerLink: binding.ownerLink,
          chatId: args.target.chatId,
          rootMessageId: args.target.rootMessageId,
          chatThreadId: args.chatThreadId,
        },
        signal,
      );
      const routeBindsRun = route !== undefined;
      if (!routeBindsRun) {
        return;
      }
    }
    const sent = await sendTelegramCompletionMessages(
      {
        botToken: binding.botToken,
        target: args.target,
        htmlOutput: buildTelegramResponse(event.content),
      },
      signal,
    );
    if (sent.kind === "telegram-error") {
      throw new Error(
        `Telegram API error: ${sent.description ?? `HTTP ${sent.status}`}`,
      );
    }
    await set(persistTelegramChatDelivery$, {
      run: { orgId: args.orgId, chatThreadId: args.chatThreadId },
      target: args.target,
      ownerLink: binding.ownerLink,
      botReplyMessageIds: sent.messageIds,
      responseText: undefined,
      status: "failed",
    });
  },
);
