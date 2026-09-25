import { readFileSync } from "fs";
import { Command, Option } from "commander";
import chalk from "chalk";
import { sendPhoneMessage } from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const messageCommand = new Command()
  .name("message")
  .description("Send a text message to your connected phone")
  // Deprecated: messages always go to the phone linked to your Okou account.
  // Kept hidden so existing scripts passing --to keep working.
  .addOption(new Option("--to <phone>").hideHelp())
  .option("--agent-id <id>", "Phone agent ID (inferred when omitted)")
  .option("-t, --text <message>", "Message text")
  .addHelpText(
    "after",
    `
Examples:
  Send a message: okou phone message -t "Hello!"
  From stdin:     printf "Hello!" | okou phone message

Notes:
  - Sends to the phone connected to your Okou account; connect one first
  - Phone agent ID is inferred from the conversation when omitted`,
  )
  .action(
    withErrorHandler(async (options: { agentId?: string; text?: string }) => {
      let text = options.text;
      if (!text && !process.stdin.isTTY) {
        try {
          text = readFileSync("/dev/stdin", "utf8").trim();
        } catch {
          // stdin not readable (e.g. test runner with no piped input);
          // fall through to the missing-text validation below.
        }
      }

      if (!text) {
        throw new Error("Either --text or piped stdin must be provided", {
          cause: new Error('Usage: okou phone message -t "your message"'),
        });
      }

      const result = await sendPhoneMessage({
        text,
        agentphoneAgentId: options.agentId,
      });

      console.log(
        chalk.green(`✓ Message sent (message_id: ${result.messageId})`),
      );
    }),
  );
