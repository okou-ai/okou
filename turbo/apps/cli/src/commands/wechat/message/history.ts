import { Command } from "commander";
import { wechatHistoryQuerySchema } from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import { readWechatHistory } from "../../../lib/api/domains/integrations-wechat";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
export const historyCommand = new Command()
  .name("history")
  .description("Read one page of WeChat messages recorded by Okou")
  .requiredOption("--channel-id <id>", "Conversation ID from channel list")
  .option("--before <id>", "Continue with nextBefore from the previous page")
  .option(
    "--oldest <timestamp>",
    "Include messages at or after this ISO 8601 time (with timezone)",
  )
  .option(
    "--latest <timestamp>",
    "Include messages before this ISO 8601 time (with timezone)",
  )
  .option("--limit <count>", "Messages per page (1-100)", "50")
  .option("--json", "Print messages, delivery states and pagination as JSON")
  .addHelpText(
    "after",
    "\nResults are newest first. History contains only messages received or sent by this Okou connection; it cannot retrieve earlier personal WeChat chats, contacts, groups, or other conversations. Unknown delivery does not mean sent. Attachment metadata is not file content. Continue with nextBefore and the same time filters; unread pages are not empty history.",
  )
  .action(
    withErrorHandler(
      async (options: {
        channelId: string;
        before?: string;
        oldest?: string;
        latest?: string;
        limit: string;
        json?: boolean;
      }) => {
        const result = await readWechatHistory(
          wechatHistoryQuerySchema.parse(options),
        );
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          "History scope: messages recorded by this Okou connection only.",
        );
        for (const message of result.messages) {
          console.log(
            `${message.timestamp}  ${message.direction}  ${message.status}  ${message.id}`,
          );
          console.log(message.content);
          if (message.quotedText)
            console.log(`Quoted (untrusted): ${message.quotedText}`);
          for (const file of message.attachments)
            console.log(
              `Attachment: ${file.id}  ${file.filename} (${file.kind})`,
            );
        }
        if (!result.messages.length)
          console.log("No messages returned on this page.");
        if (result.nextBefore)
          console.log(
            `Next before: ${result.nextBefore}. Continue with --before ${result.nextBefore}.`,
          );
      },
    ),
  );
