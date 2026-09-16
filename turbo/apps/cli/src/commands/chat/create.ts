import chalk from "chalk";
import { Command } from "commander";

import {
  createChatThread,
  getChatThreadAgentId,
} from "../../lib/api/domains/chat";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { isUuid } from "../../lib/utils/uuid";
import { getOkouChatThreadId } from "../../lib/okou-env";
import { printChatUsageError } from "./shared";

interface CreateOptions {
  readonly agent?: string;
  readonly json?: boolean;
  readonly model?: string;
  readonly priority?: boolean;
}

/**
 * Agent that owns the new thread: an explicit `--agent`, otherwise the agent of
 * the chat the command runs in.
 */
async function resolveAgentId(
  flagAgentId: string | undefined,
): Promise<string> {
  const agentId = flagAgentId?.trim();
  if (agentId) {
    return agentId;
  }

  const currentThreadId = getOkouChatThreadId()?.trim();
  if (!currentThreadId) {
    printChatUsageError(
      "OKOU_CHAT_THREAD_ID is not set",
      "Pass --agent <agent-id> or run inside a web chat thread.",
    );
  }
  if (!isUuid(currentThreadId)) {
    printChatUsageError(
      `Invalid thread ID "${currentThreadId}" — expected a UUID`,
      "Pass --agent <agent-id> to choose the agent explicitly.",
    );
  }

  return await getChatThreadAgentId({ threadId: currentThreadId });
}

export const createCommand = new Command()
  .name("create")
  .description("Create a new web chat thread")
  .argument("<title...>", "Chat title")
  .option(
    "--agent <id>",
    "Agent ID that owns the thread (defaults to this chat's agent)",
  )
  .option(
    "--model <id>",
    "Model for the thread (defaults to the current run's model)",
  )
  .option(
    "--priority",
    "Enable priority for the thread (defaults to the current chat thread)",
  )
  .option(
    "--no-priority",
    "Use standard priority instead of inheriting the current chat thread",
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Create a chat:     okou chat create "Launch plan"
  Pick the model:    okou chat create "Launch plan" --model claude-sonnet-5
  Enable priority:   okou chat create "Launch plan" --priority
  Use standard:      okou chat create "Launch plan" --no-priority
  Pick the agent:    okou chat create "Launch plan" --agent <agent-id>
  Print JSON:        okou chat create "Launch plan" --json

Notes:
  - Creates an empty thread and does not start a run; send its first self-contained message with okou chat send
  - Defaults --agent to the agent of OKOU_CHAT_THREAD_ID
  - Defaults --model to the model of the run that owns OKOU_TOKEN
  - Defaults priority to the priority of the current chat thread
  - The new thread never inherits this chat's history, so the first message must be self-contained
  - Authenticates via OKOU_TOKEN (requires chat-thread:write, and chat-thread:read to default --agent)`,
  )
  .action(
    withErrorHandler(async (titleParts: string[], options: CreateOptions) => {
      const title = titleParts.join(" ").trim();
      if (!title) {
        printChatUsageError(
          "Chat title is required",
          'Run: okou chat create "New title"',
        );
      }

      const agentId = await resolveAgentId(options.agent);
      const thread = await createChatThread({
        agentId,
        title,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.priority === undefined
          ? {}
          : { serviceTier: options.priority ? "priority" : null }),
      });

      if (options.json) {
        console.log(
          JSON.stringify({
            threadId: thread.threadId,
            title: thread.title,
            selectedModel: thread.selectedModel,
            serviceTier: thread.serviceTier,
            agentId,
          }),
        );
        return;
      }

      console.log(chalk.green("✓ Chat thread created"));
      console.log(chalk.dim(`  Thread: ${thread.threadId}`));
      console.log(chalk.dim(`  Title:  ${title}`));
      console.log(
        chalk.dim(`  Model:  ${thread.selectedModel ?? "(default)"}`),
      );
      const priority =
        thread.serviceTier === "priority" ? "enabled" : "disabled";
      console.log(chalk.dim(`  Priority: ${priority}`));
      console.log(chalk.dim(`  Agent:  ${agentId}`));
      console.log();
      console.log("Send the first message:");
      console.log(
        chalk.cyan(
          `  okou chat send --thread-id ${thread.threadId} --text "<message>"`,
        ),
      );
    }),
  );
