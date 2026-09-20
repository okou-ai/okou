import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import { buildTelegramPrompt } from "./telegram-prompt";

export interface TelegramQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly publicBrand: PublicBrand;
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
  | "publicBrand"
  | "userLinkId"
  | "userLinkKind"
  | "chatType"
  | "senderUserId"
  | "senderDisplayName"
  | "senderUsername"
  | "senderLanguage"
> & {
  readonly agentId: string;
  readonly customUserLinkId: string | null;
  readonly customInstallationId: string | null;
  readonly customBotUsername: string | null;
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
  if (
    row.userLinkKind === "custom" &&
    (row.customUserLinkId === null || row.customInstallationId === null)
  ) {
    return null;
  }
  if (row.userLinkKind === "official" && row.officialUserLinkId === null) {
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

async function loadTelegramLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      chatId: chatTelegramContext.chatId,
      messageId: chatTelegramContext.messageId,
      messageThreadId: chatTelegramContext.messageThreadId,
      messageText: chatTelegramContext.messageText,
      threadContext: chatTelegramContext.threadContext,
      rootMessageId: chatTelegramContext.rootMessageId,
      thinkingMessageId: chatTelegramContext.thinkingMessageId,
      publicBrand: chatTelegramContext.publicBrand,
      userLinkId: chatTelegramContext.userLinkId,
      userLinkKind: chatTelegramContext.userLinkKind,
      chatType: chatTelegramContext.chatType,
      senderUserId: chatTelegramContext.senderUserId,
      senderDisplayName: chatTelegramContext.senderDisplayName,
      senderUsername: chatTelegramContext.senderUsername,
      senderLanguage: chatTelegramContext.senderLanguage,
      agentId: agents.id,
      customUserLinkId: telegramUserLinks.id,
      customInstallationId: telegramInstallations.telegramBotId,
      customBotUsername: telegramInstallations.botUsername,
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
      ),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .leftJoin(
      telegramUserLinks,
      and(
        eq(chatTelegramContext.userLinkKind, "custom"),
        eq(telegramUserLinks.id, chatTelegramContext.userLinkId),
        eq(telegramUserLinks.userId, args.userId),
      ),
    )
    .leftJoin(
      telegramInstallations,
      and(
        eq(
          telegramInstallations.telegramBotId,
          telegramUserLinks.installationId,
        ),
        eq(telegramInstallations.orgId, args.orgId),
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
      ),
    )
    .limit(1);
  return requiredTelegramLaunchContext(row);
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

export async function loadTelegramQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<TelegramQueuedLaunchMaterial | null> {
  const context = await loadTelegramLaunchContext(db, args);
  if (!context) {
    return null;
  }
  const officialBotConfig = getOfficialTelegramBotConfig();
  const deliveryInstallationId =
    context.userLinkKind === "custom"
      ? context.customInstallationId
      : OFFICIAL_TELEGRAM_BOT_ID;
  if (deliveryInstallationId === null) {
    return null;
  }
  const providerBotId =
    context.userLinkKind === "custom"
      ? context.customInstallationId
      : officialBotConfig.botId;
  if (providerBotId === null) {
    return null;
  }
  const botUsername =
    context.userLinkKind === "custom"
      ? context.customBotUsername
      : officialBotConfig.botUsername;
  const publicBrand = context.publicBrand;
  if (!publicBrand) {
    return null;
  }
  return {
    prompt: context.messageText,
    appendSystemPrompt: buildTelegramPrompt(
      {
        botId: providerBotId,
        botUsername,
        chatId: context.chatId,
        chatType: context.chatType,
        messageId: context.messageId,
        rootMessageId: context.rootMessageId,
        messageThreadId: context.messageThreadId,
      },
      context.threadContext,
    ),
    publicBrand,
    telegramDelivery: telegramDeliveryTargetSchema.parse({
      installationId: deliveryInstallationId,
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
    }),
    userInfoExtras: telegramUserInfoExtras(context),
  };
}
