import { Command, Option } from "commander";
import {
  sendAgentPhoneGroupMessage,
  sendPhoneMessage,
} from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  parseMessageTarget,
  readMessageText,
  unsupportedTargetError,
} from "../../lib/command/message-target";
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
    .description(
      integration === "imessage"
        ? "Send text to your connected phone or an existing iMessage group"
        : "Send a text message to your connected phone",
    )
    .addOption(
      integration === "imessage"
        ? new Option(
            "--to <target>",
            "Destination: me, chat:<group-id>, or a group ID (grp_...)",
          ).default("me")
        : phoneToOption(),
    )
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
  From stdin:     printf "Hello!" | ${usage}${
    integration === "imessage"
      ? `\n  To a group:    ${usage} --to grp_abc123 -t "Team update"`
      : ""
  }

Notes:
  - The default destination is the phone connected to your Okou account; connect one first
  - --as selects the official bot or an agent already used in your linked conversation
  - --as is inferred from the conversation when omitted${
    integration === "imessage"
      ? "\n  - Group sends require a group already visible to your account and current membership\n  - Use the Group ID in the current integration context; group sends never fall back to a DM"
      : ""
  }`,
    )
    .action(
      withErrorHandler(
        async (options: {
          to: string;
          as?: string;
          text?: string;
          json?: boolean;
        }) => {
          let groupId: string | undefined;
          if (integration === "imessage") {
            const target = parseMessageTarget(options.to, () => {
              return false;
            });
            if (target.kind !== "me") {
              if (target.kind !== "chat" || !target.id.startsWith("grp_")) {
                throw unsupportedTargetError(
                  "iMessage",
                  target,
                  "Use --to me or --to grp_<group-id> for an existing group",
                );
              }
              groupId = target.id;
            }
          } else {
            assertPhoneTarget(options.to);
          }
          const text = readMessageText(options.text);
          if (!text) {
            throw new Error("Either --text or piped stdin must be provided", {
              cause: new Error(`Usage: ${usage} -t "your message"`),
            });
          }

          const result = groupId
            ? await sendAgentPhoneGroupMessage({
                groupId,
                text,
                agentphoneAgentId: options.as,
              })
            : await sendPhoneMessage({
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
