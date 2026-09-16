import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { and, eq, isNotNull } from "drizzle-orm";
import { delay } from "signal-timers";
import { env } from "../../lib/env";
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
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
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
import { snapshotIntegrationReply } from "./integration-artifact-reply.service";

const L = logger("InternalCallbacksTelegramChat");
const TELEGRAM_COMPLETION_CHUNK_THROTTLE_MS = 1100;

interface ClaimedTelegramChatDelivery {
  readonly id: string;
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

async function claimTelegramChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedTelegramChatDelivery | undefined> {
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
      id: agentRunCallbacks.id,
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

function telegramOwnerWhere(ownerLink: TelegramOwnerLink) {
  return ownerLink.kind === "custom"
    ? eq(telegramChatThreadRoutes.telegramUserLinkId, ownerLink.id)
    : eq(telegramChatThreadRoutes.telegramOfficialUserLinkId, ownerLink.id);
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
  if (args.target.userLinkKind === "official") {
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

  if (isOfficialTelegramBotId(args.target.installationId)) {
    return undefined;
  }
  const [binding] = await args.db
    .select({
      id: telegramUserLinks.id,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
      ownerUserId: telegramInstallations.ownerUserId,
    })
    .from(telegramUserLinks)
    .innerJoin(
      telegramInstallations,
      eq(telegramInstallations.telegramBotId, telegramUserLinks.installationId),
    )
    .where(
      and(
        eq(telegramUserLinks.id, args.target.userLinkId),
        eq(telegramUserLinks.userId, args.userId),
        eq(telegramUserLinks.installationId, args.target.installationId),
        eq(telegramInstallations.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!binding) {
    return undefined;
  }
  return {
    botToken: await decryptPersistentSecretValue(
      binding.encryptedBotToken,
      await loadUserFeatureSwitchContext(
        args.db,
        args.orgId,
        binding.ownerUserId,
      ),
    ),
    ownerLink: { kind: "custom", id: binding.id },
  };
}

async function routeStillBindsRun(args: {
  readonly db: Db;
  readonly target: TelegramDeliveryTarget;
  readonly ownerLink: TelegramOwnerLink;
  readonly chatThreadId: string;
}): Promise<boolean> {
  if (args.target.rootMessageId === null) {
    return true;
  }
  const [route] = await args.db
    .select({ id: telegramChatThreadRoutes.id })
    .from(telegramChatThreadRoutes)
    .where(
      and(
        telegramOwnerWhere(args.ownerLink),
        eq(telegramChatThreadRoutes.chatId, args.target.chatId),
        eq(telegramChatThreadRoutes.rootMessageId, args.target.rootMessageId),
        eq(telegramChatThreadRoutes.chatThreadId, args.chatThreadId),
      ),
    )
    .limit(1);
  return route !== undefined;
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
  if (
    binding &&
    !(await routeStillBindsRun({
      db: args.db,
      target: payload,
      ownerLink: binding.ownerLink,
      chatThreadId: runContext.chatThreadId,
    }))
  ) {
    return { payload, run: runContext, messageContent: event.content };
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

async function resolveTelegramPresentation(
  args: {
    readonly db: Db;
    readonly run: TelegramChatRunContext;
    readonly runId: string;
    readonly installationId: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}> {
  const [featureContext, footerText] = await Promise.all([
    loadUserFeatureSwitchContext(args.db, args.run.orgId, args.run.userId),
    resolveTelegramAgentReplyFooterText({
      db: args.db,
      orgId: args.run.orgId,
      runId: args.runId,
      installationId: args.installationId,
      agentId: args.run.agentId,
    }),
  ]);
  signal.throwIfAborted();
  return {
    logsUrl: isFeatureEnabled(FeatureSwitchKey.OkouDebug, featureContext)
      ? `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`
      : undefined,
    footerText,
  };
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
    scope:
      args.target.userLinkKind === "official"
        ? {
            kind: "official",
            orgId: args.run.orgId,
            userLinkId: args.target.userLinkId,
          }
        : {
            kind: "custom",
            installationId: args.target.installationId,
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
  const {
    payload,
    run,
    messageContent: sourceContent,
    binding,
  } = await loadTelegramChatDeliveryContext(args, signal);
  if (!binding) {
    return "skipped_revoked";
  }
  const messageContent = await snapshotIntegrationReply(
    {
      db: args.db,
      runId: args.callback.runId,
      deliveryKey: `callback:${args.callback.id}`,
      publicBrand: payload.publicBrand,
      content: sourceContent,
    },
    signal,
  );

  await deleteThinkingMessageIfPresent({
    botToken: binding.botToken,
    target: payload,
  });
  signal.throwIfAborted();
  await bestEffort(
    sendChatAction(binding.botToken, payload.chatId, "typing"),
    signal,
  );
  const presentation = await resolveTelegramPresentation(
    {
      db: args.db,
      run,
      runId: args.callback.runId,
      installationId: payload.installationId,
    },
    signal,
  );
  const responseText = args.status === "completed" ? messageContent : undefined;
  const sent = await sendTelegramCompletionMessages(
    {
      botToken: binding.botToken,
      target: payload,
      htmlOutput: buildTelegramResponse(
        messageContent,
        presentation.logsUrl,
        presentation.footerText,
      ),
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
  const callback = await claimTelegramChatDelivery(db, callbackId);
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
  if (
    !(await routeStillBindsRun({
      db: args.db,
      target: args.target,
      ownerLink: binding.ownerLink,
      chatThreadId: args.chatThreadId,
    }))
  ) {
    return;
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
    scope:
      args.target.userLinkKind === "official"
        ? {
            kind: "official",
            orgId: args.orgId,
            userLinkId: args.target.userLinkId,
          }
        : {
            kind: "custom",
            installationId: args.target.installationId,
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
