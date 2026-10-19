import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { wechatSendBodySchema } from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import { sendWechatMessage } from "../../../lib/api/domains/integrations-wechat";
import {
  readMessageText,
  TO_OPTION_FLAGS,
} from "../../../lib/command/message-target";
import { printMessageOutput } from "../../../lib/command/message-output";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { wechatChannelId } from "../target";
export const sendCommand = new Command()
  .name("send")
  .description("Send text to your verified WeChat conversation")
  .requiredOption(
    TO_OPTION_FLAGS,
    "Destination: me, conversation ID or chat:<id> from channel list",
  )
  .option(
    "-t, --text <message>",
    "Text, or pipe it on stdin (up to 20000 characters)",
  )
  .option(
    "--operation-id <uuid>",
    "Reuse a previous operation to avoid duplicate sends",
  )
  .option("--json", "Print every delivered message receipt as JSON")
  .addHelpText(
    "after",
    "\nRequires wechat:write and a message from the connected WeChat user first. Using --to me also requires wechat:read for conversation discovery. Long text is split without truncation. Run-triggered messages include agent/model attribution. On partial or unknown delivery, inspect history and reuse the same operation ID; confirmed chunks are not resent and unknown chunks are never automatically retried. The final response of a WeChat run is already delivered automatically.",
  )
  .action(
    withErrorHandler(
      async (options: {
        to: string;
        text?: string;
        operationId?: string;
        json?: boolean;
      }) => {
        const text = readMessageText(options.text);
        if (text === undefined)
          throw new Error("Provide --text or pipe message text on stdin");
        const body = wechatSendBodySchema.parse({
          channelId: await wechatChannelId(options.to),
          text,
          operationId: options.operationId ?? randomUUID(),
        });
        console.warn(`Send operation: ${body.operationId}`);
        const result = await sendWechatMessage(body);
        printMessageOutput(
          {
            integration: "wechat",
            chatId: body.channelId,
            messages: result.messages.map((message) => {
              return {
                id: message.id,
                url: message.url,
              };
            }),
          },
          options,
        );
      },
    ),
  );
