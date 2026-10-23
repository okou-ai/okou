import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import * as z from "zod";
import { db$ } from "../external/db";
import { getOfficialTelegramBotConfig } from "../external/telegram-official";
import {
  checkTelegramConversationAccess,
  isTelegramApiError,
} from "../external/telegram-client";
import { telegramAccountNotLinked } from "./telegram-data.service";
import { settle } from "../utils";
import { notFound } from "../../lib/error";

const unavailable = () => {
  return notFound(
    "This Telegram conversation is unavailable to your connected account and Okou.",
  );
};

export const requireTelegramConversationAccess$ = command(
  async (
    { get },
    args: {
      orgId: string;
      userId: string;
      chatId: string;
      mode: "read" | "message" | "document";
    },
    signal: AbortSignal,
  ) => {
    const [link] = await get(db$)
      .select({ telegramUserId: telegramOfficialUserLinks.telegramUserId })
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.orgId, args.orgId),
          eq(telegramOfficialUserLinks.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!link) {
      return { kind: "denied" as const, response: telegramAccountNotLinked };
    }
    const config = getOfficialTelegramBotConfig();
    if (!config.botToken || !config.botId) {
      return { kind: "denied" as const, response: unavailable() };
    }
    if (args.chatId === "me" || args.chatId === link.telegramUserId) {
      return { kind: "allowed" as const, chatId: link.telegramUserId };
    }
    const access = await settle(
      checkTelegramConversationAccess(
        {
          token: config.botToken,
          botId: config.botId,
          chatId: args.chatId,
          userId: link.telegramUserId,
          mode: args.mode,
        },
        signal,
      ),
      signal,
    );
    if (!access.ok) {
      const error = access.error;
      if (
        isTelegramApiError(error) &&
        (error.status === 403 ||
          error.status === 404 ||
          (error.status === 400 &&
            /chat not found|user not found|member.*not found|not a member|participant/i.test(
              error.description ?? "",
            )))
      ) {
        return { kind: "denied" as const, response: unavailable() };
      }
      return {
        kind: "denied" as const,
        response: {
          status:
            isTelegramApiError(error) && error.status < 500
              ? (400 as const)
              : (502 as const),
          body: {
            error: {
              code: "TELEGRAM_ERROR",
              message:
                "Telegram could not verify conversation access. Check the bot's membership permissions and retry.",
            },
          },
        },
      };
    }
    return access.value
      ? { kind: "allowed" as const, chatId: access.value }
      : { kind: "denied" as const, response: unavailable() };
  },
);

/** A bot-global file ID grants no authority without an owned source conversation. */
export const requireTelegramFileAccess$ = command(
  async (
    { get, set },
    args: { orgId: string; userId: string; fileId: string },
    signal: AbortSignal,
  ) => {
    const [messages, uploads] = await Promise.all([
      get(db$)
        .selectDistinct({ chatId: telegramMessages.chatId })
        .from(telegramMessages)
        .where(
          and(
            eq(telegramMessages.officialOrgId, args.orgId),
            eq(telegramMessages.fileId, args.fileId),
          ),
        )
        .limit(100),
      get(db$)
        .select({ metadata: runUploadedFiles.metadata })
        .from(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.orgId, args.orgId),
            eq(runUploadedFiles.userId, args.userId),
            eq(runUploadedFiles.externalId, args.fileId),
            eq(runUploadedFiles.source, "telegram"),
          ),
        )
        .limit(100),
    ]);
    signal.throwIfAborted();
    const chats = new Set(
      messages.map((message) => {
        return message.chatId;
      }),
    );
    for (const upload of uploads) {
      const metadata = z
        .object({ chatId: z.string() })
        .safeParse(upload.metadata);
      if (metadata.success) {
        chats.add(metadata.data.chatId);
      }
    }
    for (const chatId of chats) {
      const access = await set(
        requireTelegramConversationAccess$,
        { ...args, chatId, mode: "read" },
        signal,
      );
      if (access.kind === "allowed") {
        return access;
      }
      if (access.response.status !== 404) {
        return access;
      }
    }
    return { kind: "denied" as const, response: unavailable() };
  },
);
