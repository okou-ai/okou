import chalk from "chalk";
import { Command } from "commander";

import { getChatThread } from "../../lib/api/domains/chat";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { formatChatEffort, resolveChatThreadId } from "./shared";

interface GetOptions {
  readonly threadId?: string;
  readonly json?: boolean;
}

export const getCommand = new Command()
  .name("get")
  .description("Show a web chat thread")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)",
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Show this chat:    okou chat get
  Show another chat: okou chat get --thread-id <thread-id>
  Print JSON:        okou chat get --json

Notes:
  - Defaults --thread-id to OKOU_CHAT_THREAD_ID from the current web chat thread
  - Prints thread metadata; okou chat messages prints the messages
  - Authenticates via OKOU_TOKEN (requires chat-thread:read capability)`,
  )
  .action(
    withErrorHandler(async (options: GetOptions) => {
      const threadId = resolveChatThreadId(options.threadId);

      const thread = await getChatThread({ threadId });
      if (options.json) {
        console.log(JSON.stringify(thread));
        return;
      }

      console.log(chalk.green("✓ Chat thread loaded"));
      console.log(chalk.dim(`  Thread: ${thread.id}`));
      if (thread.agentId) {
        console.log(chalk.dim(`  Agent:  ${thread.agentId}`));
      }
      console.log(chalk.dim(`  Title:  ${thread.title ?? "(untitled)"}`));
      console.log(
        chalk.dim(
          `  Model:  ${thread.selectedModel ?? "(default)"}${formatChatEffort(thread.selectedModel, thread.modelSettings)}`,
        ),
      );
    }),
  );
