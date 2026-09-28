import { Command } from "commander";
import { sendPhoneMessage } from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { readMessageText } from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../lib/command/message-output";
import { assertPhoneTarget, phoneToOption } from "./target";

export const messageCommand = new Command()
  .name("message")
  .description("Send a text message to your connected phone")
  .addOption(phoneToOption())
  .option(
    "--as <agent-id>",
    "Phone agent ID to send as (inferred when omitted)",
  )
  .option("-t, --text <message>", "Message text (or pipe it on stdin)")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  Send a message: okou phone message -t "Hello!"
  From stdin:     printf "Hello!" | okou phone message

Notes:
  - Sends to the phone connected to your Okou account; connect one first
  - --as is inferred from the conversation when omitted`,
  )
  .action(
    withErrorHandler(
      async (options: {
        to: string;
        as?: string;
        text?: string;
        json?: boolean;
      }) => {
        assertPhoneTarget(options.to);
        const text = readMessageText(options.text);
        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error('Usage: okou phone message -t "your message"'),
          });
        }

        const result = await sendPhoneMessage({
          text,
          agentphoneAgentId: options.as,
        });

        printMessageOutput(
          {
            integration: "phone",
            chatId: result.toNumber,
            messages: [{ id: result.messageId, url: null }],
          },
          options,
        );
      },
    ),
  );
