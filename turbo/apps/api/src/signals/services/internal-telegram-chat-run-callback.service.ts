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
import { buildTelegramResponse, splitMessage } from "../../lib/telegram-format";
import type { Db } from "../external/db";
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
  persistTelegramReplyChainRoute,
  type TelegramOwnerLink,
} from "./telegram-chat-ingress.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { storeTelegramBotMessage } from "./telegram-callback-persistence.service";
import { resolveTelegramAgentReplyFooterText } from "./telegram-footer.service";

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

async function markDelivered(db: Db, callbackId: string): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "delivered", deliveredAt: nowDate() })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "failed", lastError: error.slice(0, 4000) })
    .where(eq(agentRunCallbacks.id, callbackId));
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

async function loadTelegramOwnerBinding(
  args: {
    readonly db: Db;
    readonly target: TelegramDeliveryTarget;
    readonly userId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<TelegramOwnerBinding | undefined> {
  // Self-hosted (custom) Telegram bots are retired; only the official shared
  // bot can deliver run callbacks.
  if (!isOfficialTelegramBotId(args.target.installationId)) {
    return undefined;
  }
  const [link] = await args.db
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
  return link && botToken
    ? {
        botToken,
        ownerLink: { kind: "official", id: link.id },
      }
    : undefined;
}

async function loadTelegramChatDeliveryContext(
  args: {
    readonly db: Db;
    readonly callback: ClaimedTelegramChatDelivery;
  },
  signal: AbortSignal,
) {
  const payload = telegramChatCallbackPayloadSchema.parse(
    args.callback.payload,
  );
  const [run] = await args.db
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

  const [event] = await args.db
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

  const binding = await loadTelegramOwnerBinding(
    {
      db: args.db,
      target: payload,
      userId: runContext.userId,
      orgId: runContext.orgId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (binding) {
    const routeDb = args.db;
    const routeTarget = payload;
    const routeOwnerLink = binding.ownerLink;
    const routeChatThreadId = runContext.chatThreadId;
    if (routeTarget.rootMessageId !== null) {
      const [route] = await routeDb
        .select({ id: telegramChatThreadRoutes.id })
        .from(telegramChatThreadRoutes)
        .where(
          and(
            telegramOwnerWhere(routeOwnerLink),
            eq(telegramChatThreadRoutes.chatId, routeTarget.chatId),
            eq(
              telegramChatThreadRoutes.rootMessageId,
              routeTarget.rootMessageId,
            ),
            eq(telegramChatThreadRoutes.chatThreadId, routeChatThreadId),
          ),
        )
        .limit(1);
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
}

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

async function persistTelegramChatDelivery(args: {
  readonly db: Db;
  readonly run: TelegramChatRunContext;
  readonly target: TelegramDeliveryTarget;
  readonly ownerLink: TelegramOwnerLink;
  readonly botReplyMessageIds: readonly number[];
  readonly responseText: string | undefined;
  readonly status: "completed" | "failed";
}): Promise<void> {
  const firstMessageId = args.botReplyMessageIds[0];
  if (firstMessageId === undefined) {
    return;
  }
  await storeTelegramBotMessage({
    db: args.db,
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
    await persistTelegramReplyChainRoute({
      db: args.db,
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
}

async function deliverClaimedTelegramChatCallback(
  args: {
    readonly db: Db;
    readonly callback: ClaimedTelegramChatDelivery;
    readonly status: "completed" | "failed";
  },
  signal: AbortSignal,
): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadTelegramChatDeliveryContext(args, signal);
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
  const footerText = await resolveTelegramAgentReplyFooterText({
    db: args.db,
    orgId: run.orgId,
    runId: args.callback.runId,
    installationId: payload.installationId,
    agentId: run.agentId,
  });
  signal.throwIfAborted();
  const responseText = args.status === "completed" ? messageContent : undefined;
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
  await persistTelegramChatDelivery({
    db: args.db,
    run,
    target: payload,
    ownerLink: binding.ownerLink,
    botReplyMessageIds: sent.messageIds,
    responseText,
    status: args.status,
  });
  return "delivered";
}

export async function dispatchTelegramChatDeliveryOnce(
  db: Db,
  callbackId: string,
  status: "completed" | "failed",
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const [callback] = await db
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
  if (!callback) {
    return;
  }
  const delivery = await settleIncludingAbort(
    deliverClaimedTelegramChatCallback(
      {
        db,
        callback,
        status,
      },
      signal,
    ),
  );
  if (!delivery.ok) {
    const message =
      delivery.error instanceof Error
        ? delivery.error.message
        : "Unknown error";
    await markFailed(db, callbackId, message);
    recordDelivery({
      runId: callback.runId,
      startedAt,
      success: false,
      outcome: "failed",
    });
    L.warn("Canonical Telegram delivery failed", {
      callbackId,
      runId: callback.runId,
      error: delivery.error,
    });
    return;
  }
  await markDelivered(db, callbackId);
  recordDelivery({
    runId: callback.runId,
    startedAt,
    success: true,
    outcome: delivery.value,
  });
}

interface TelegramChatAdmissionFailureArgs {
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly target: TelegramDeliveryTarget;
  readonly chatEventId: string;
}

export async function deliverTelegramChatAdmissionFailure(
  args: TelegramChatAdmissionFailureArgs,
  signal: AbortSignal,
): Promise<void> {
  const [event] = await args.db
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
  const binding = await loadTelegramOwnerBinding(
    {
      db: args.db,
      target: args.target,
      userId: args.userId,
      orgId: args.orgId,
    },
    signal,
  );
  if (!binding) {
    return;
  }
  const routeDb = args.db;
  const routeTarget = args.target;
  const routeOwnerLink = binding.ownerLink;
  const routeChatThreadId = args.chatThreadId;
  if (routeTarget.rootMessageId !== null) {
    const [route] = await routeDb
      .select({ id: telegramChatThreadRoutes.id })
      .from(telegramChatThreadRoutes)
      .where(
        and(
          telegramOwnerWhere(routeOwnerLink),
          eq(telegramChatThreadRoutes.chatId, routeTarget.chatId),
          eq(telegramChatThreadRoutes.rootMessageId, routeTarget.rootMessageId),
          eq(telegramChatThreadRoutes.chatThreadId, routeChatThreadId),
        ),
      )
      .limit(1);
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
  const firstMessageId = sent.messageIds[0];
  if (firstMessageId === undefined) {
    return;
  }
  await storeTelegramBotMessage({
    db: args.db,
    scope: {
      orgId: args.orgId,
      userLinkId: args.target.userLinkId,
    },
    chatId: args.target.chatId,
    messageId: firstMessageId,
    text: undefined,
  });
  const replyMessageIds = args.target.isDM ? sent.messageIds : [firstMessageId];
  for (const messageId of replyMessageIds) {
    await persistTelegramReplyChainRoute({
      db: args.db,
      ownerLink: binding.ownerLink,
      chatId: args.target.chatId,
      previousRootMessageId: args.target.rootMessageId,
      isDirectMessage: args.target.isDM,
      botReplyMessageId: String(messageId),
      chatThreadId: args.chatThreadId,
      runStatus: "failed",
      currentTime: nowDate(),
    });
  }
}
