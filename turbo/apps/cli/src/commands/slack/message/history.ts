import { Command } from "commander";
import { slackHistoryQuerySchema } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { readSlackHistory } from "../../../lib/api/domains/integrations-slack";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const historyCommand = new Command()
  .name("history")
  .description("Read shared channel or bot direct-message history")
  .requiredOption(
    "-c, --channel <id>",
    "Channel ID or bot DM conversation ID (D...)",
  )
  .option(
    "--limit <count>",
    "Maximum messages in one page (1-200; Slack may return fewer)",
    "15",
  )
  .option("--cursor <cursor>", "Continue from a previous page's nextCursor")
  .option(
    "--oldest <ts>",
    "Only messages after this Slack Unix timestamp (exclusive)",
  )
  .option(
    "--latest <ts>",
    "Only messages before this Slack Unix timestamp (exclusive)",
  )
  .option("--json", "Print the response as JSON, including message metadata")
  .addHelpText(
    "after",
    `
Examples:
  okou slack channel list
  okou slack message history --channel C012345 --limit 15
  okou slack message history --channel D012345 --json
  okou slack message history --channel C012345 --oldest 1750000000.000001 --latest 1750100000.000001
  okou slack message history --channel C012345 --cursor <next-cursor>

Notes:
  - Requires slack:read and uses the organization's Slack bot.
  - Both your connected Slack account and Okou must belong to the conversation.
  - IM history is limited to your single-user conversation with the bot, identified by a D-prefixed ID, not a user ID.
  - To find a bot DM's ID, open its details in Slack and copy the conversation ID or link.
  - Channel history contains conversation messages; thread replies are not expanded. Use --json to retain blocks, files and thread metadata.
  - To read a thread, use okou slack message replies --channel <id> --thread <parent-ts> --json.
  - Results are newest first. Each call reads one page. Keep the channel and time filters when continuing with --cursor.
  - If Slack rate limits a request, wait for the returned Retry-After duration before retrying.
  - To make a channel readable, join it in Slack and add Okou via the channel name > Agents & apps.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channel: string;
        limit: string;
        cursor?: string;
        oldest?: string;
        latest?: string;
        json?: boolean;
      }) => {
        const parsed = slackHistoryQuerySchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await readSlackHistory(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.channelUrl);
        if (result.messages.length === 0)
          console.log("No messages on this page in the requested time range.");
        for (const message of result.messages) {
          const sender =
            message.user ?? message.bot_id ?? message.subtype ?? message.type;
          console.log(
            `${message.ts}  ${sender}\n${message.text || "[Message has no text; use --json to inspect its content]"}`,
          );
          if (message.reply_count)
            console.log(
              `Thread: ${message.thread_ts ?? message.ts} (${message.reply_count} replies; not expanded)\nRead with: okou slack message replies --channel ${result.channel} --thread ${message.thread_ts ?? message.ts} --json`,
            );
        }
        if (result.nextCursor) {
          console.log(`Next cursor: ${result.nextCursor}`);
          console.log(
            "Continue with --cursor and the same channel and time filters.",
          );
        } else if (result.hasMore) {
          console.log(
            "Slack reports more history. Use --latest with the oldest returned timestamp to continue.",
          );
        }
      },
    ),
  );
