import { Command } from "commander";
import { sendTelegramMessage } from "../../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  readMessageText,
  toOptionDescription,
} from "../../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../../lib/command/message-output";
import { parsePositiveInteger, resolveTelegramChatId } from "./target";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message through the official Okou Telegram bot")
  .requiredOption(TO_OPTION_FLAGS, toOptionDescription("chat ID or @channel"))
  .option("-t, --text <message>", "Message text (or pipe it on stdin)")
  .option("--reply-to <message-id>", "Message ID to reply to")
  .option("--topic <id>", "Forum topic (message thread) ID")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  Simple message:      okou telegram message send --to -1001234567890 -t "Hello!"
  Reply to message:    okou telegram message send --to -1001234567890 --reply-to 42 -t "reply"
  Forum topic message: okou telegram message send --to -1001234567890 --topic 7 -t "topic update"
  DM yourself:         okou telegram message send --to me -t "Hello!"

Notes:
  - Message text can be provided with --text or piped on stdin
  - Sends through the official Okou Telegram bot
  - --to me requires your Telegram account to be linked to the official Okou bot`,
  )
  .action(
    withErrorHandler(
      async (options: {
        to: string;
        text?: string;
        replyTo?: string;
        topic?: string;
        json?: boolean;
      }) => {
        const chatId = resolveTelegramChatId(options.to);
        const text = readMessageText(options.text);
        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error(
              'Usage: okou telegram message send --to CHAT_ID -t "your message"',
            ),
          });
        }

        const result = await sendTelegramMessage({
          chatId,
          text,
          replyToMessageId: options.replyTo
            ? parsePositiveInteger(options.replyTo, "--reply-to")
            : undefined,
          messageThreadId: options.topic
            ? parsePositiveInteger(options.topic, "--topic")
            : undefined,
        });

        printMessageOutput(
          {
            integration: "telegram",
            chatId: result.chatId,
            messages: [{ id: String(result.messageId), url: null }],
          },
          options,
        );
      },
    ),
  );
