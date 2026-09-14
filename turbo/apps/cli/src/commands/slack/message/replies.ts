import { Command } from "commander";
import { slackRepliesQuerySchema } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { readSlackReplies } from "../../../lib/api/domains/integrations-slack";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const repliesCommand = new Command()
  .name("replies")
  .description("Read one thread page from a shared channel or your bot DM")
  .requiredOption(
    "-c, --channel <id>",
    "Channel ID or bot DM conversation ID (D...)",
  )
  .requiredOption("--thread <ts>", "Parent message's Slack timestamp")
  .option(
    "--limit <count>",
    "Maximum messages in one page, including the parent (1-200; Slack may return fewer)",
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
  okou slack message history --channel C012345 --json
  okou slack message replies --channel C012345 --thread 1750000000.000001 --json
  okou slack message replies --channel D012345 --thread 1750000000.000001 --limit 15
  okou slack message replies --channel C012345 --thread 1750000000.000001 --cursor <next-cursor> --json

Notes:
  - Requires slack:read and uses the organization's Slack bot.
  - Both your connected Slack account and Okou must belong to the conversation.
  - DMs are limited to your existing one-to-one bot DM; other users' DMs and group DMs are excluded.
  - Use the parent's ts from history, or a reply's thread_ts, for --thread.
  - Slack returns messages oldest first, including the parent on the initial unfiltered page. A thread with no replies returns only the parent.
  - Cursor and time-filtered pages may omit the parent. Use --json to retain text, blocks, files and thread metadata.
  - Each call reads one page, not necessarily the entire thread. Keep the channel, thread and time filters when continuing with --cursor.
  - On rate limits, wait for the returned Retry-After duration before retrying.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        channel: string;
        thread: string;
        limit: string;
        cursor?: string;
        oldest?: string;
        latest?: string;
        json?: boolean;
      }) => {
        const parsed = slackRepliesQuerySchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await readSlackReplies(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(result.channelUrl);
        console.log(`Thread: ${result.thread} (one page)`);
        if (result.messages.length === 0) {
          console.log("No messages on this page in the requested time range.");
        }
        for (const message of result.messages) {
          const sender =
            message.user ?? message.bot_id ?? message.subtype ?? message.type;
          const parentLabel = message.ts === result.thread ? " [parent]" : "";
          console.log(
            `${message.ts}  ${sender}${parentLabel}\n${message.text || "[Message has no text; use --json to inspect its content]"}`,
          );
        }
        if (result.nextCursor) {
          console.log(`Next cursor: ${result.nextCursor}`);
          console.log(
            "Continue with --cursor and the same channel, thread and time filters.",
          );
        } else if (result.hasMore) {
          console.log(
            "Slack reports more replies but returned no cursor; this page is incomplete.",
          );
          if (result.messages.length > 0) {
            console.log(
              "Continue with --oldest set to the newest returned timestamp, keeping the channel, thread and --latest bound.",
            );
          }
        }
      },
    ),
  );
