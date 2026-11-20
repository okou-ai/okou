import { command, computed } from "ccstate";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { and, eq } from "drizzle-orm";

import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import { buildTelegramPrompt } from "./telegram-prompt";

export interface TelegramQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly telegramDelivery: TelegramDeliveryTarget;
  readonly userInfoExtras: {
    readonly telegramDisplayName?: string;
    readonly telegramUsername?: string;
    readonly telegramUserId?: string;
    readonly telegramLanguage?: string;
  };
}

type TelegramLaunchContextRow = Pick<
  typeof chatTelegramContext.$inferSelect,
  | "chatId"
  | "messageId"
  | "messageThreadId"
  | "messageText"
  | "threadContext"
  | "rootMessageId"
  | "thinkingMessageId"
  | "userLinkId"
  | "userLinkKind"
  | "chatType"
  | "senderUserId"
  | "senderDisplayName"
  | "senderUsername"
  | "senderLanguage"
> & {
  readonly officialUserLinkId: string | null;
};

function requiredTelegramLaunchContext(
  row: TelegramLaunchContextRow | undefined,
) {
  if (
    !row ||
    row.messageText === null ||
    row.threadContext === null ||
    row.userLinkId === null ||
    row.userLinkKind === null ||
    row.chatType === null
  ) {
    return null;
  }
  // Self-hosted (custom) Telegram bots are retired; only the official shared
  // bot can deliver queued launches.
  if (row.userLinkKind !== "official" || row.officialUserLinkId === null) {
    return null;
  }
  return {
    ...row,
    messageText: row.messageText,
    threadContext: row.threadContext,
    userLinkId: row.userLinkId,
    userLinkKind: row.userLinkKind,
    chatType: row.chatType,
  };
}

interface TelegramLaunchSource {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly contextId?: string;
}

export type TelegramThreadContext = ReturnType<
  typeof requiredTelegramLaunchContext
>;

export function createTelegramLaunchContext(args: TelegramLaunchSource) {
  return computed(async (get): Promise<TelegramThreadContext> => {
    const db = get(db$);
    const [row] = await db
      .select({
        chatId: chatTelegramContext.chatId,
        messageId: chatTelegramContext.messageId,
        messageThreadId: chatTelegramContext.messageThreadId,
        messageText: chatTelegramContext.messageText,
        threadContext: chatTelegramContext.threadContext,
        rootMessageId: chatTelegramContext.rootMessageId,
        thinkingMessageId: chatTelegramContext.thinkingMessageId,
        userLinkId: chatTelegramContext.userLinkId,
        userLinkKind: chatTelegramContext.userLinkKind,
        chatType: chatTelegramContext.chatType,
        senderUserId: chatTelegramContext.senderUserId,
        senderDisplayName: chatTelegramContext.senderDisplayName,
        senderUsername: chatTelegramContext.senderUsername,
        senderLanguage: chatTelegramContext.senderLanguage,
        officialUserLinkId: telegramOfficialUserLinks.id,
      })
      .from(chatEvents)
      .innerJoin(
        chatTelegramContext,
        and(
          eq(chatTelegramContext.id, chatEvents.contextId),
          eq(chatTelegramContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatEvents.chatThreadId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.orgId, args.orgId),
        ),
      )
      .leftJoin(
        telegramOfficialUserLinks,
        and(
          eq(chatTelegramContext.userLinkKind, "official"),
          eq(telegramOfficialUserLinks.id, chatTelegramContext.userLinkId),
          eq(telegramOfficialUserLinks.userId, args.userId),
          eq(telegramOfficialUserLinks.orgId, args.orgId),
        ),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          eq(chatEvents.contextType, "telegram"),
          args.contextId === undefined
            ? undefined
            : eq(chatTelegramContext.id, args.contextId),
        ),
      )
      .limit(1);
    return requiredTelegramLaunchContext(row);
  });
}

function telegramUserInfoExtras(
  context: NonNullable<ReturnType<typeof requiredTelegramLaunchContext>>,
): TelegramQueuedLaunchMaterial["userInfoExtras"] {
  return {
    ...(context.senderDisplayName !== null
      ? { telegramDisplayName: context.senderDisplayName }
      : {}),
    ...(context.senderUsername !== null
      ? { telegramUsername: context.senderUsername }
      : {}),
    ...(context.senderUserId !== null
      ? { telegramUserId: context.senderUserId }
      : {}),
    ...(context.senderLanguage !== null
      ? { telegramLanguage: context.senderLanguage }
      : {}),
  };
}

function telegramDeliveryFromContext(
  context: NonNullable<TelegramThreadContext>,
) {
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

export function createTelegramQueuedDelivery(args: TelegramLaunchSource) {
  const context$ = createTelegramLaunchContext(args);
  return computed(async (get) => {
    const context = await get(context$);
    return context && getOfficialTelegramBotConfig().botId !== null
      ? telegramDeliveryFromContext(context)
      : null;
  });
}

export const loadTelegramQueuedLaunchMaterial$ = command(
  async (
    { get },
    args: TelegramLaunchSource & {
      readonly featureSwitchContext: FeatureSwitchContext;
    },
  ): Promise<TelegramQueuedLaunchMaterial | null> => {
    const context = await get(createTelegramLaunchContext(args));
    if (!context) {
      return null;
    }
    const officialBotConfig = getOfficialTelegramBotConfig();
    const providerBotId = officialBotConfig.botId;
    if (providerBotId === null) {
      return null;
    }
    const botUsername = officialBotConfig.botUsername;
    return {
      ...telegramPromptFromContext(
        context,
        { botId: providerBotId, botUsername },
        args.featureSwitchContext,
      ),
      telegramDelivery: telegramDeliveryFromContext(context),
      userInfoExtras: telegramUserInfoExtras(context),
    };
  },
);

export function telegramPromptFromContext(
  context: NonNullable<TelegramThreadContext>,
  bot: { readonly botId: string; readonly botUsername: string | null },
  featureSwitchContext: FeatureSwitchContext,
) {
  return {
    prompt: context.messageText,
    appendSystemPrompt: buildTelegramPrompt(
      {
        ...bot,
        chatId: context.chatId,
        chatType: context.chatType,
        messageId: context.messageId,
        rootMessageId: context.rootMessageId,
        messageThreadId: context.messageThreadId,
      },
      resolveIntegrationNotePrompt({
        triggerSource: "telegram",
        featureSwitchContext,
      }),
      context.threadContext,
    ),
  };
}
