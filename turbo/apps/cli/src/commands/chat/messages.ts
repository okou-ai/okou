import { Command } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveChatThreadId } from "./shared";
import { syncRawChatHistory } from "./chat-event-history";

interface MessagesOptions {
  readonly threadId?: string;
  readonly json?: boolean;
  readonly outputDir?: string;
}

export const messagesCommand = new Command()
  .name("messages")
  .description("Synchronize raw history for a web chat thread")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)",
  )
  .option("--json", "Print machine-readable JSON")
  .option(
    "--output-dir <directory>",
    "Synchronize raw snapshot and hot event files into this directory",
  )
  .addHelpText(
    "after",
    `
Examples:
  Sync this chat:     okou chat messages --output-dir threads
  Sync another chat:  okou chat messages --thread-id <thread-id> --output-dir threads
  Print JSON:         okou chat messages --thread-id <thread-id> --output-dir threads --json

Notes:
  - --output-dir is required and receives grep-friendly raw history files
  - Repeated synchronization resumes from the latest local sequence ID
  - Reads a thread the current user owns, including one another agent run wrote into
  - This is a point-in-time read/sync. Repeated calls are polling; they do not wait for a run or emit terminal completion
  - For event-driven completion, add an enabled chat-run-finished workflow automation. It watches one user-owned thread (not one run ID), can filter completed/failed/cancelled and case-insensitive * wildcard final output, and remains enabled until disabled or removed
  - A matching completion starts a new run in the workflow's automation thread; it never resumes the caller's run
  - Authenticates via OKOU_TOKEN (requires chat-event:read capability)`,
  )
  .action(
    withErrorHandler(async (options: MessagesOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      if (!options.outputDir) {
        throw new Error("--output-dir is required to synchronize chat history");
      }
      const result = await syncRawChatHistory({
        threadId,
        outputDirectory: options.outputDir,
      });
      if (options.json) {
        console.log(
          JSON.stringify({
            threadId,
            directory: result.directory,
            files: result.files,
          }),
        );
        return;
      }
      console.log(`Synchronized chat history to ${result.directory}`);
      for (const file of result.files) {
        console.log(file);
      }
    }),
  );
