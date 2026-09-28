import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendTelegramMessage } from "../../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message through the official Okou Telegram bot")
  .requiredOption("-c, --chat-id <id>", "Telegram chat ID")
  .option("-t, --text <message>", "Message text")
  .option("--reply-to-message-id <id>", "Message ID to reply to")
  .option("--message-thread-id <id>", "Telegram forum topic thread ID")
  .addHelpText(
    "after",
    `
Examples:
  Simple message:      okou telegram message send -c -1001234567890 -t "Hello!"
  Reply to message:    okou telegram message send -c -1001234567890 --reply-to-message-id 42 -t "reply"
  Forum topic message: okou telegram message send -c -1001234567890 --message-thread-id 7 -t "topic update"

Notes:
  - Message text can be provided with --text or piped on stdin
  - Sends through the official Okou Telegram bot.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        chatId: string;
        text?: string;
        replyToMessageId?: string;
        messageThreadId?: string;
      }) => {
        let text = options.text;
        if (!text && !process.stdin.isTTY) {
          try {
            text = readFileSync("/dev/stdin", "utf8").trim();
          } catch {
            // stdin not readable (e.g. test runner with no piped input);
            // fall through to the missing-text validation below.
          }
        }

        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error(
              'Usage: okou telegram message send -c CHAT_ID -t "your message"',
            ),
          });
        }

        const result = await sendTelegramMessage({
          chatId: options.chatId,
          text,
          replyToMessageId: options.replyToMessageId
            ? parsePositiveInteger(
                options.replyToMessageId,
                "reply-to-message-id",
              )
            : undefined,
          messageThreadId: options.messageThreadId
            ? parsePositiveInteger(options.messageThreadId, "message-thread-id")
            : undefined,
        });

        console.log(
          chalk.green(`✓ Message sent (message_id: ${result.messageId})`),
        );
      },
    ),
  );
