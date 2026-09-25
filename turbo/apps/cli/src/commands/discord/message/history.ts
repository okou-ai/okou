import { Command } from "commander";
import { discordHistoryQuerySchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { readDiscordHistory } from "../../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { printDiscordMessages } from "./format";

export const historyCommand = new Command()
  .name("history")
  .description(
    "Read one page of Discord channel, thread, or your bot DM history",
  )
  .requiredOption("--channel-id <id>", "Channel, native thread, or bot DM ID")
  .option(
    "--guild-id <id>",
    "Optional; must match your organization's bound guild",
  )
  .option(
    "--before <id>",
    "Read messages before this ID; use nextBefore to continue",
  )
  .option("--limit <count>", "Maximum messages in one page (1-100)", "50")
  .option("--json", "Print the response as JSON, including attachment metadata")
  .addHelpText(
    "after",
    `
Examples:
  okou discord message history --channel-id <id> --json
  okou discord message history --channel-id <id> --before <next-before> --limit 50

Notes:
  - Requires discord:read and access for both your verified Discord user and Okou.
  - Bot DM reads are limited to your own one-to-one conversation with Okou.
  - --guild-id is optional; when given, it must match your organization's bound guild.
  - Results are newest first. Each call reads one page; native threads are not expanded.
  - To read a message's native thread, use message replies --channel-id <parent-channel-id> --message-id <root-message-id>.
  - A Discord reply reference is not a native thread.
  - Message text availability depends on Discord's Message Content intent.
  - On rate limits, wait for the returned retry duration before retrying.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channelId: string;
        guildId?: string;
        before?: string;
        limit: string;
        json?: boolean;
      }) => {
        const parsed = discordHistoryQuerySchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await readDiscordHistory(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printDiscordMessages(result);
      },
    ),
  );
