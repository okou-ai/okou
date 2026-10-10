import { Command } from "commander";
import { sendDiscordMessageBodySchema } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { sendDiscordMessage } from "../../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  readMessageText,
} from "../../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../../lib/command/message-output";
import { resolveDiscordChannelId } from "../target";

export const sendCommand = new Command()
  .name("send")
  .description(
    "Send text to an authorized Discord channel, native thread, or your bot DM",
  )
  .requiredOption(
    TO_OPTION_FLAGS,
    "Destination: chat:<id> or a channel, native thread, or bot DM ID",
  )
  .option(
    "-t, --text <message>",
    "Message text (1-20000 characters, or pipe it on stdin)",
  )
  .option(
    "--reply-to <id>",
    "Message ID to reference in the same destination channel",
  )
  .option(
    "--guild-id <id>",
    "Optional; must match your organization's bound guild",
  )
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  okou discord message send --to <channel-id> --text "Hello!"
  okou discord message send --guild-id <guild-id> --to <thread-id> --text "Update" --json
  okou discord message send --to <channel-id> --reply-to <message-id> --text "Reply"
  printf 'Release update' | okou discord message send --to <channel-id>

Notes:
  - Requires discord:write and access for both your verified Discord user and Okou.
  - --guild-id is optional; when given, it must match your organization's bound guild.
  - To send in a native thread, pass its channel ID to --to. This command does not create threads.
  - --reply-to references a message in that destination; it does not create or enter a thread.
  - Run-triggered sends include agent, sender, and model attribution once, after the text.
  - Bot DMs are limited to your own existing one-to-one conversation with Okou.
  - Long text is split into Discord-sized messages without truncation; every delivered URL is returned.
  - Mention notifications are suppressed, including @everyone, roles, and users.
  - If a send partially fails, inspect already delivered URLs before retrying to avoid duplicates.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        to: string;
        text?: string;
        replyTo?: string;
        guildId?: string;
        json?: boolean;
      }) => {
        const text = readMessageText(options.text);
        if (text === undefined) {
          throw new Error("Provide --text or pipe message text on stdin");
        }
        const parsed = sendDiscordMessageBodySchema.safeParse({
          channelId: resolveDiscordChannelId(options.to),
          text,
          replyToMessageId: options.replyTo,
          guildId: options.guildId,
        });
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await sendDiscordMessage(parsed.data);
        printMessageOutput(
          {
            integration: "discord",
            chatId: result.messages[0]?.channelId ?? null,
            messages: result.messages.map((message) => {
              return { id: message.id, url: message.url };
            }),
          },
          options,
        );
      },
    ),
  );
