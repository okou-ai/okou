import { Command } from "commander";
import type { SendTeamsMessageBody } from "@okouai/api-contracts/contracts/integrations";
import chalk from "chalk";
import { sendTeamsMessage } from "../../../lib/api/domains/integrations-teams";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  isJsonObject,
  missingTargetError,
  parseMessageTarget,
  parseRichJson,
  readMessageText,
  toOptionDescription,
} from "../../../lib/command/message-target";

type TeamsCardInput = NonNullable<SendTeamsMessageBody["card"]>;

export function isTeamsUserId(id: string): boolean {
  return id.startsWith("29:");
}

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
      }) => {
        if (!options.to) {
          throw missingTargetError(
            "Teams",
            "me, a conversation ID (19:…), or a user ID (29:…)",
          );
        }
        const target = parseMessageTarget(options.to, isTeamsUserId);
        const activityId = options.replyTo;
        if (target.kind !== "chat" && activityId) {
          throw new Error("--reply-to requires a conversation --to target", {
            cause: new Error(
              "Thread replies require an existing Teams conversation",
            ),
          });
        }

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
          ...(target.kind === "chat"
            ? { conversationId: target.id }
            : { user: target.kind === "me" ? "me" : target.id }),
          ...(activityId ? { activityId } : {}),
          ...(text ? { text } : {}),
          ...(card ? { card } : {}),
        };
        const result = await sendTeamsMessage({
          ...body,
        });

        const activityInfo = result.activityId
          ? ` (activity_id: ${result.activityId})`
          : "";
        console.log(chalk.green(`✓ Message sent${activityInfo}`));
      },
    ),
  );
