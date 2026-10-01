import { Command } from "commander";
import { agentPhoneGroupHistoryQuerySchema } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { readAgentPhoneGroupHistory } from "../../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const groupHistoryCommand = new Command()
  .name("history")
  .description("Read archived messages from a group")
  .requiredOption("--group <group-id>", "Group ID")
  .option("--after <datetime>", "Only messages at or after this ISO timestamp")
  .option("--before <datetime>", "Only messages before this ISO timestamp")
  .option("--query <text>", "Filter messages by text")
  .option("--limit <count>", "Maximum messages in one page (1-200)", "100")
  .option("--cursor <cursor>", "Continue from the previous page")
  .option("--json", "Print the response as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou imessage group history --group grp_abc123
  okou imessage group history --group grp_abc123 --after 2026-10-01T00:00:00Z
  okou imessage group history --group grp_abc123 --query "launch plan" --json
  okou imessage group history --group grp_abc123 --cursor <next-cursor>

Notes:
  - Results are chronological and limited to messages visible to your account.
  - Use the same group and filters when continuing with --cursor.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        group: string;
        after?: string;
        before?: string;
        query?: string;
        limit: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const parsed = agentPhoneGroupHistoryQuerySchema.safeParse({
          groupId: options.group,
          after: options.after,
          before: options.before,
          query: options.query,
          limit: options.limit,
          cursor: options.cursor,
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

        const result = await readAgentPhoneGroupHistory(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.messages.length === 0) {
          console.log("No visible archived messages in this group.");
        }
        for (const message of result.messages) {
          const sender =
            message.direction === "outbound" ? "Okou" : message.fromNumber;
          console.log(
            `${message.receivedAt}  ${sender}\n${message.body ?? "[Message has no text]"}`,
          );
          if (message.mediaUrl) {
            console.log(`Media: ${message.mediaUrl}`);
          }
        }
        if (result.nextCursor) {
          console.log(`Next cursor: ${result.nextCursor}`);
          console.log("Continue with --cursor and the same group and filters.");
        }
      },
    ),
  );
