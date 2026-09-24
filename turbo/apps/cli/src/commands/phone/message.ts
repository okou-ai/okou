import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendPhoneMessage } from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const messageCommand = new Command()
  .name("message")
  .description("Send a phone text message")
  .requiredOption("--to <phone>", "Connected phone handle to message")
  .option("--agent-id <id>", "Phone agent ID (inferred when omitted)")
  .option("-t, --text <message>", "Message text")
  .addHelpText(
    "after",
    `
Examples:
  Send a message: okou phone message --to +15551234567 -t "Hello!"
  From stdin:     printf "Hello!" | okou phone message --to +15551234567

Notes:
  - The phone handle must already be connected to the authenticated Okou user
  - Phone agent ID is inferred from the conversation when omitted`,
  )
  .action(
    withErrorHandler(
      async (options: { to: string; agentId?: string; text?: string }) => {
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
            cause: new Error(
              'Usage: okou phone message --to +15551234567 -t "your message"',
            ),
          });
        }

        const result = await sendPhoneMessage({
          toNumber: options.to,
          text,
          agentphoneAgentId: options.agentId,
        });

        console.log(
          chalk.green(`✓ Message sent (message_id: ${result.messageId})`),
        );
      },
    ),
  );
