import { Command } from "commander";
import { sendPhoneMessage } from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { readMessageText } from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
  type MessageIntegration,
} from "../../lib/command/message-output";
import { assertPhoneTarget, phoneToOption } from "./target";

type PhoneMessageIntegration = Extract<
  MessageIntegration,
  "phone" | "imessage" | "sms"
>;

export function createPhoneMessageCommand(
  integration: PhoneMessageIntegration = "phone",
): Command {
  const usage =
    integration === "phone"
      ? "okou phone message"
      : `okou ${integration} message send`;
  return new Command()
    .name(integration === "phone" ? "message" : "send")
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
  Send a message: ${usage} -t "Hello!"
  From stdin:     printf "Hello!" | ${usage}

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
              cause: new Error(`Usage: ${usage} -t "your message"`),
            });
          }

          const result = await sendPhoneMessage({
            text,
            agentphoneAgentId: options.as,
          });

          printMessageOutput(
            {
              integration,
              chatId: result.toNumber,
              messages: [{ id: result.messageId, url: null }],
            },
            options,
          );
        },
      ),
    );
}

export const messageCommand = createPhoneMessageCommand();
