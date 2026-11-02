import chalk from "chalk";
import { Command } from "commander";
import { sendPhoneReaction } from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export function createPhoneReactionCommand(
  integration: "phone" | "imessage" = "phone",
): Command {
  const usage =
    integration === "phone"
      ? "okou phone reaction"
      : "okou imessage message react";
  return new Command()
    .name(integration === "phone" ? "reaction" : "react")
    .description("Add an emoji reaction to an iMessage in your DM or group")
    .argument(
      "<message-id>",
      "Message ID from the integration context or group history",
    )
    .requiredOption(
      "-e, --emoji <emoji>",
      "Emoji or tapback name (e.g. 👍, like, love)",
    )
    .option("--json", "Output the provider acceptance receipt as JSON")
    .addHelpText(
      "after",
      `
Examples:
  Thumbs up: ${usage} <message-id> --emoji like
  Emoji:     ${usage} <message-id> --emoji "🔥" --json

Notes:
  - Requires your connected phone and a message visible to your account
  - Group reactions also require current membership in that group
  - SMS and MMS do not support reactions
  - Standard tapbacks: love, like, dislike, laugh, emphasize, question
  - Custom emoji require a supported iMessage line; provider errors are returned without fallback
  - Acceptance does not confirm recipient delivery; never automatically repeat an uncertain request`,
    )
    .action(
      withErrorHandler(
        async (
          messageId: string,
          options: { emoji: string; json?: boolean },
        ) => {
          const result = await sendPhoneReaction({
            messageId,
            reaction: options.emoji,
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(
            chalk.green(
              `✓ Reaction accepted: ${result.reaction} on ${result.messageId}`,
            ),
          );
        },
      ),
    );
}
