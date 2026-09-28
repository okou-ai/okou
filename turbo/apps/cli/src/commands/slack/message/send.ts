import { Command } from "commander";
import { sendSlackMessage } from "../../../lib/api/domains/integrations-slack";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  missingTargetError,
  parseMessageTarget,
  parseRichJson,
  readMessageText,
  toOptionDescription,
} from "../../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../../lib/command/message-output";

type SlackBlock = { type: string; [key: string]: unknown };

export function isSlackUserId(id: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(id);
}

function parseBlocks(value: string): SlackBlock[] {
  const parsed = parseRichJson(value, "a JSON array of Block Kit blocks");
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid --rich payload", {
      cause: new Error("Provide a JSON array of Block Kit blocks"),
    });
  }
  return parsed as SlackBlock[];
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Slack channel or DM a user")
  .option(TO_OPTION_FLAGS, toOptionDescription("C… channel, D… DM, U…/W… user"))
  .option("-t, --text <message>", "Message text (or pipe it on stdin)")
  .option("--reply-to <ts>", "Parent message timestamp to reply in thread")
  .option("--rich <json>", "Block Kit blocks JSON array")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  Simple message:        okou slack message send --to C01234 -t "Hello!"
  DM a user:             okou slack message send --to U0A8V9X98QJ -t "Hello!"
  DM yourself:           okou slack message send --to me -t "Hello!"
  Reply in thread:       okou slack message send --to C01234 --reply-to 1234567890.123456 -t "reply"
  Rich blocks:           okou slack message send --to C01234 --rich '[{"type":"section","text":{"type":"mrkdwn","text":"*Bold*"}}]'

Notes:
  - --to is required; U…/W… IDs open a DM, other IDs are channels
  - Either --text or --rich is required; both can be used together`,
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
          throw missingTargetError("Slack", "me or a channel/user ID");
        }
        const target = parseMessageTarget(options.to, isSlackUserId);
        const text = readMessageText(options.text);
        const blocks = options.rich ? parseBlocks(options.rich) : undefined;

        if (!text && !blocks) {
          throw new Error("Either --text or --rich must be provided", {
            cause: new Error(
              'Usage: okou slack message send --to CHANNEL_ID -t "your message"',
            ),
          });
        }

        const result = await sendSlackMessage({
          ...(target.kind === "chat"
            ? { channel: target.id }
            : { user: target.kind === "me" ? "me" : target.id }),
          text: text || undefined,
          threadTs: options.replyTo,
          blocks,
        });

        printMessageOutput(
          {
            integration: "slack",
            chatId: result.channel ?? null,
            messages: result.ts ? [{ id: result.ts, url: null }] : [],
          },
          options,
        );
      },
    ),
  );
