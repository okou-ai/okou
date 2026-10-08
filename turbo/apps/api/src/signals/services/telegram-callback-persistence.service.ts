import { telegramMessages } from "@okouai/db/schema/telegram-message";

import type { Db } from "../external/db";

// Only the official shared bot persists bot messages; self-hosted bots are
// retired.
interface TelegramMessageScope {
  readonly orgId: string;
  readonly userLinkId: string | null;
}

export async function storeTelegramBotMessage(args: {
  readonly db: Db;
  readonly scope: TelegramMessageScope;
  readonly chatId: string;
  readonly messageId: number;
  readonly text: string | undefined;
}): Promise<void> {
  await args.db
    .insert(telegramMessages)
    .values({
      officialOrgId: args.scope.orgId,
      officialUserLinkId: args.scope.userLinkId,
      chatId: args.chatId,
      messageId: String(args.messageId),
      fromUserId: "0",
      fromUsername: null,
      fromDisplayName: null,
      text: args.text ?? null,
      fileId: null,
      fileType: null,
      fileName: null,
      fileMimeType: null,
      fileSize: null,
      fileWidth: null,
      fileHeight: null,
      fileDuration: null,
      entities: null,
      isBot: true,
    })
    .onConflictDoNothing();
}
