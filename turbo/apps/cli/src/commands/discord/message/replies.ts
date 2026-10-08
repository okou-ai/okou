import { Command } from "commander";
import { discordRepliesQuerySchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { readDiscordReplies } from "../../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { printDiscordMessages } from "./format";

export const repliesCommand = new Command()
  .name("replies")
  .description("Read one page from a Discord message's native thread")
  .requiredOption(
    "--channel-id <id>",
    "Parent channel containing the root message",
  )
  .requiredOption(
    "--message-id <id>",
    "Root message with an existing native thread",
  )
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
  okou discord message replies --channel-id <parent-channel-id> --message-id <root-message-id> --json
  okou discord message replies --channel-id <parent-channel-id> --message-id <root-message-id> --before <next-before>

Notes:
  - Requires discord:read and access to the thread for both your verified Discord user and Okou.
  - A Discord reply reference is not a native thread. This command never creates a thread.
  - Results are newest first. Each call reads one page and does not include the parent channel's root message.
  - If you already know the native thread ID, use message history --channel-id <thread-id>.
  - --guild-id is optional; when given, it must match your organization's bound guild.
  - On rate limits, wait for the returned retry duration before retrying.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channelId: string;
        messageId: string;
        guildId?: string;
        before?: string;
        limit: string;
        json?: boolean;
      }) => {
        const parsed = discordRepliesQuerySchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await readDiscordReplies(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Thread: ${result.threadId} (one page)`);
        printDiscordMessages(result);
      },
    ),
  );
