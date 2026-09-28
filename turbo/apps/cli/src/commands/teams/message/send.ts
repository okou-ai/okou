import { Command } from "commander";
import type { SendTeamsMessageBody } from "@okouai/api-contracts/contracts/integrations";
import { sendTeamsMessage } from "../../../lib/api/domains/integrations-teams";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  isJsonObject,
  missingTargetError,
  parseRichJson,
  readMessageText,
  toOptionDescription,
} from "../../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../../lib/command/message-output";
import { resolveTeamsDestination } from "./target";

type TeamsCardInput = NonNullable<SendTeamsMessageBody["card"]>;

function parseTeamsCard(value: string): TeamsCardInput {
  const parsed = parseRichJson(value, "a valid Adaptive Card JSON object");
  if (
    !isJsonObject(parsed) ||
    parsed.type !== "AdaptiveCard" ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("Invalid Adaptive Card for --rich", {
      cause: new Error(
        'Provide a JSON object with "type": "AdaptiveCard" and a version',
      ),
    });
  }

  return parsed as TeamsCardInput;
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Microsoft Teams conversation or DM a user")
  .option(TO_OPTION_FLAGS, toOptionDescription("19:… conversation, 29:… user"))
  .option("-t, --text <message>", "Message text (or pipe it on stdin)")
  .option("--reply-to <activity-id>", "Activity ID to reply to in thread")
  .option("--rich <json>", "Adaptive Card JSON string")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  Simple message:        okou teams message send --to 19:thread@thread.tacv2 -t "Hello!"
  DM a user:             okou teams message send --to 29:user-id -t "Hello!"
  DM yourself:           okou teams message send --to me -t "Hello!"
  Thread reply:          okou teams message send --to 19:thread@thread.tacv2 --reply-to root-activity -t "reply"
  Adaptive Card:         okou teams message send --to 19:thread@thread.tacv2 --rich '{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"Hello","wrap":true}]}'

Notes:
  - --to is required; 29:… IDs open a DM, other IDs are conversations
  - Either --text or --rich is required; text can be provided with --text or piped on stdin
  - Use the Conversation ID and Activity ID from the current Teams run prompt`,
  )
  .action(
    withErrorHandler(
      async (options: {
        to?: string;
        text?: string;
        replyTo?: string;
        rich?: string;
        json?: boolean;
      }) => {
        if (!options.to) {
          throw missingTargetError(
            "Teams",
            "me, a conversation ID (19:…), or a user ID (29:…)",
          );
        }
        const destination = resolveTeamsDestination(
          options.to,
          options.replyTo,
        );

        const text = readMessageText(options.text);
        const card = options.rich ? parseTeamsCard(options.rich) : undefined;

        if (!text && !card) {
          throw new Error(
            "Either --text, --rich, or piped stdin must be provided",
            {
              cause: new Error(
                'Usage: okou teams message send --to CONVERSATION_ID -t "your message"',
              ),
            },
          );
        }

        const body: SendTeamsMessageBody = {
          ...destination,
          ...(text ? { text } : {}),
          ...(card ? { card } : {}),
        };
        const result = await sendTeamsMessage({
          ...body,
        });

        printMessageOutput(
          {
            integration: "teams",
            chatId: result.conversationId,
            messages: result.activityId
              ? [{ id: result.activityId, url: null }]
              : [],
          },
          options,
        );
      },
    ),
  );
