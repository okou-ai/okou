import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { Command } from "commander";

import { sendFeishuMessage } from "../../../lib/api/domains/integrations-feishu";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  isJsonObject,
  parseRichJson,
  readMessageText,
  toOptionDescription,
} from "../../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../../lib/command/message-output";
import {
  type FeishuDestinationOptions,
  replyModeOption,
  resolveFeishuDestination,
} from "./target";

interface SendFeishuOptions extends FeishuDestinationOptions {
  readonly as?: string;
  readonly text?: string;
  readonly rich?: string;
  readonly json?: boolean;
}

function parseCard(
  input: string | undefined,
  providerName: string,
): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }
  const parsed = parseRichJson(input, `a ${providerName} card JSON object`);
  if (!isJsonObject(parsed)) {
    throw new Error("Invalid --rich payload", {
      cause: new Error(`Provide a ${providerName} card JSON object`),
    });
  }
  return parsed;
}

export function createFeishuSendCommand(platform: FeishuPlatform) {
  const providerName = FEISHU_PLATFORMS[platform].name;
  return new Command()
    .name("send")
    .description(`Send a message to a ${providerName} chat or user`)
    .option(
      TO_OPTION_FLAGS,
      toOptionDescription("oc_… chat, ou_… user open ID"),
    )
    .option("--reply-to <message-id>", "Message ID to reply to (om_…)")
    .addOption(replyModeOption())
    .option("--as <installation-id>", `${providerName} installation to send as`)
    .option("-t, --text <message>", "Message text (or pipe it on stdin)")
    .option("--rich <json>", `${providerName} interactive card JSON`)
    .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      `
Examples:
  Chat message:          okou ${platform} message send --to oc_xxx -t "Hello!"
  Direct message:        okou ${platform} message send --to ou_xxx -t "Hello!"
  DM yourself:           okou ${platform} message send --to me -t "Hello!"
  Thread reply:          okou ${platform} message send --reply-to om_xxx --reply-mode thread -t "Reply"
  Interactive card:      okou ${platform} message send --to oc_xxx --rich '{"schema":"2.0","body":{"elements":[]}}'
  Select a custom app:   okou ${platform} message send --as <installation-id> --to oc_xxx -t "Hello!"

Notes:
  - Exactly one of --to or --reply-to is required; replies go to the replied-to message's chat
  - Exactly one of --text or --rich is required
  - --as is required when the organization has multiple ${providerName} bots`,
    )
    .action(
      withErrorHandler(async (options: SendFeishuOptions) => {
        const destination = resolveFeishuDestination(providerName, options);
        const card = parseCard(options.rich, providerName);
        const text = card ? options.text : readMessageText(options.text);
        if (Boolean(text) === Boolean(card)) {
          throw new Error("Exactly one of --text or --rich must be provided");
        }

        const result = await sendFeishuMessage({
          ...(platform === "lark" ? { platform } : {}),
          installationId: options.as,
          ...destination,
          text,
          card,
        });
        printMessageOutput(
          {
            integration: platform,
            chatId: result.chatId,
            messages: [{ id: result.messageId, url: null }],
          },
          options,
        );
      }),
    );
}
