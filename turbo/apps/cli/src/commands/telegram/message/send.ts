import { Command } from "commander";
import chalk from "chalk";
import { sendTelegramMessage } from "../../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  readMessageText,
  toOptionDescription,
} from "../../../lib/command/message-target";
import { parsePositiveInteger, resolveTelegramChatId } from "./target";

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Telegram chat as the bot")
  .requiredOption("--as <bot-id>", "Telegram bot ID to send as")
  .requiredOption(TO_OPTION_FLAGS, toOptionDescription("chat ID or @channel"))
  .option("-t, --text <message>", "Message text (or pipe it on stdin)")
  .option("--reply-to <message-id>", "Message ID to reply to")
  .option("--topic <id>", "Forum topic (message thread) ID")
  .addHelpText(
    "after",
    `
Examples:
  Simple message:      okou telegram message send --as 123456789 --to -1001234567890 -t "Hello!"
  Reply to message:    okou telegram message send --as 123456789 --to -1001234567890 --reply-to 42 -t "reply"
  Forum topic message: okou telegram message send --as 123456789 --to -1001234567890 --topic 7 -t "topic update"

Notes:
  - Message text can be provided with --text or piped on stdin
  - Choose an explicit --as bot. Run "okou telegram bot list" to inspect available bots.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        as: string;
        to: string;
        text?: string;
        replyTo?: string;
        topic?: string;
      }) => {
        const chatId = resolveTelegramChatId(options.to);
        const text = readMessageText(options.text);
        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error(
              'Usage: okou telegram message send --as BOT_ID --to CHAT_ID -t "your message"',
            ),
          });
        }

        const result = await sendTelegramMessage({
          botId: options.as,
          chatId,
          text,
          replyToMessageId: options.replyTo
            ? parsePositiveInteger(options.replyTo, "--reply-to")
            : undefined,
          messageThreadId: options.topic
            ? parsePositiveInteger(options.topic, "--topic")
            : undefined,
        });

        console.log(
          chalk.green(`✓ Message sent (message_id: ${result.messageId})`),
        );
      },
    ),
  );
