import chalk from "chalk";
import { Command } from "commander";

import { setChatThreadArchived } from "../../lib/api/domains/chat";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveChatThreadId } from "./shared";

interface ArchiveOptions {
  readonly threadId?: string;
  readonly json?: boolean;
}

function createArchiveCommand(archived: boolean): Command {
  const name = archived ? "archive" : "unarchive";
  return new Command()
    .name(name)
    .description(
      archived
        ? "Archive a web chat thread"
        : "Move an archived web chat thread back to the chat list",
    )
    .option(
      "--thread-id <id>",
      "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)",
    )
    .option("--json", "Print machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  ${archived ? "Archive this chat:  " : "Unarchive this chat:"} okou chat ${name}
  ${archived ? "Archive another:    " : "Unarchive another:  "} okou chat ${name} --thread-id <thread-id>

Notes:
  - Defaults --thread-id to OKOU_CHAT_THREAD_ID
  - Does not change the chat title
  - List archived chats with okou chat list --archived
  - Authenticates via OKOU_TOKEN (requires chat-thread:write capability)`,
    )
    .action(
      withErrorHandler(async (options: ArchiveOptions) => {
        const threadId = resolveChatThreadId(options.threadId);
        const result = await setChatThreadArchived({ threadId, archived });
        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(
          chalk.green(
            archived ? "✓ Chat thread archived" : "✓ Chat thread unarchived",
          ),
        );
        console.log(chalk.dim(`  Thread: ${result.threadId}`));
      }),
    );
}

export const archiveCommand = createArchiveCommand(true);
export const unarchiveCommand = createArchiveCommand(false);
