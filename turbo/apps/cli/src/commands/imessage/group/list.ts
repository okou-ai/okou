import { Command } from "commander";
import { agentPhoneGroupListQuerySchema } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { listAgentPhoneGroups } from "../../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const groupListCommand = new Command()
  .name("list")
  .alias("ls")
  .description(
    "List known groups shared by your connected iMessage account and Okou",
  )
  .option(
    "--limit <count>",
    "Maximum candidate groups in one page (1-100)",
    "25",
  )
  .option("--cursor <cursor>", "Continue from a previous page's nextCursor")
  .option("--json", "Print the response as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou imessage group list
  okou imessage group list --limit 25 --json
  okou imessage group list --cursor <next-cursor>

Notes:
  - Lists groups with archived messages visible to your account, after checking current membership.
  - Connect your phone in Works and add Okou to the group; a group message must have reached Okou.
  - This cannot enumerate all groups on your phone. DMs and departed groups are excluded.
  - Last message time is the latest archived message visible to your account.
  - Use groupId (grp_...), not conversationId, for sending and history.
  - Use agentphoneAgentId with message send --as when choosing between phone agents.
  - Requires phone:read. Each call checks one bounded page of candidates.
  - Continue with --cursor whenever nextCursor is present, even if this page is empty.`,
  )
  .action(
    withErrorHandler(
      async (options: { limit: string; cursor?: string; json?: boolean }) => {
        const parsed = agentPhoneGroupListQuerySchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await listAgentPhoneGroups(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.groups.length === 0) {
          console.log(
            "No shared iMessage groups on this page. Connect your phone in Works and make sure a message from the group has reached Okou.",
          );
        }
        for (const group of result.groups) {
          console.log(
            `${group.groupId}  ${group.groupName ?? "[Unnamed group]"}  ${group.lastMessageAt}`,
          );
          console.log(
            `Conversation: ${group.conversationId}  Phone agent: ${group.agentphoneAgentId}`,
          );
        }
        if (result.nextCursor) {
          console.log(`Next cursor: ${result.nextCursor}`);
          console.log("Continue with --cursor, including after an empty page.");
        }
        console.log(
          "Read history: okou imessage group history --group <groupId>",
        );
        console.log(
          'Send: okou imessage message send --to <groupId> --text "message"',
        );
      },
    ),
  );
