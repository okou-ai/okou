import { Command } from "commander";
import { sendDiscordMessageBodySchema } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { sendDiscordMessage } from "../../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const sendCommand = new Command()
  .name("send")
  .description(
    "Send text to an authorized Discord channel, native thread, or your bot DM",
  )
  .requiredOption("--channel-id <id>", "Channel, native thread, or bot DM ID")
  .requiredOption("-t, --text <message>", "Message text (1-20000 characters)")
  .option("--guild-id <id>", "Select one of your verified guild bindings")
  .option("--json", "Print all delivered message IDs and URLs as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou discord message send --channel-id <id> --text "Hello!"
  okou discord message send --guild-id <guild-id> --channel-id <thread-id> --text "Update" --json

Notes:
  - Requires discord:write and access for both your verified Discord user and Okou.
  - Pass --guild-id when multiple guild bindings are available, including for DMs.
  - To send in a native thread, use its channel ID. This command does not create threads.
  - Bot DMs are limited to your own existing one-to-one conversation with Okou.
  - Long text is split into Discord-sized messages without truncation; every delivered URL is returned.
  - Mention notifications are suppressed, including @everyone, roles, and users.
  - If a send partially fails, inspect already delivered URLs before retrying to avoid duplicates.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channelId: string;
        text: string;
        guildId?: string;
        json?: boolean;
      }) => {
        const parsed = sendDiscordMessageBodySchema.safeParse(options);
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
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Message sent (${result.messages.length} Discord messages).`,
        );
        for (const message of result.messages) {
          console.log(`${message.id}  ${message.url}`);
        }
      },
    ),
  );
