import chalk from "chalk";
import { Command } from "commander";

import {
  createChatThread,
  getChatThread,
  getChatThreadAgentId,
} from "../../lib/api/domains/chat";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { isUuid } from "../../lib/utils/uuid";
import { getOkouChatThreadId } from "../../lib/okou-env";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import {
  formatChatEffort,
  parseChatEffort,
  printChatUsageError,
} from "./shared";

interface CreateOptions {
  readonly agent?: string;
  readonly json?: boolean;
  readonly model?: string;
  readonly effort?: string;
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
  .option("--effort <level>", "Set reasoning effort for the selected model")
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
  Set effort:       okou chat create "Launch plan" --model claude-opus-5-5 --effort extra
  Enable priority:   okou chat create "Launch plan" --priority
  Use standard:      okou chat create "Launch plan" --no-priority
  Pick the agent:    okou chat create "Launch plan" --agent <agent-id>
  Print JSON:        okou chat create "Launch plan" --json

Notes:
  - Creates an empty thread and does not start a run; send its first self-contained message with okou chat send
  - Defaults --agent to the agent of OKOU_CHAT_THREAD_ID
  - Defaults --model to the model of the run that owns OKOU_TOKEN
  - Effort levels depend on the model; Claude uses extra where Codex uses xhigh
  - GPT 6 Sol: low, medium, high, xhigh, max, ultra
  - Claude Opus 5.5: low, medium, high, extra, max, ultracode
  - See okou chat model --help for the effort levels supported by each model
  - Pass --model when the calling run's model is unknown or unavailable
  - Defaults priority to the priority of the current chat thread
  - The new thread never inherits this chat's history, so the first message must be self-contained
  - Authenticates via OKOU_TOKEN (requires chat-thread:write, and chat-thread:read to default --agent or show effective effort)`,
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

      const reasoningEffort =
        options.effort === undefined
          ? undefined
          : parseChatEffort(options.effort, options.model);
      const agentId = await resolveAgentId(options.agent);
      let thread;
      try {
        thread = await createChatThread({
          agentId,
          title,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(options.priority === undefined
            ? {}
            : { serviceTier: options.priority ? "priority" : null }),
        });
      } catch (error) {
        if (
          reasoningEffort !== undefined &&
          options.model === undefined &&
          error instanceof ApiRequestError &&
          error.status === 400
        ) {
          throw new Error(
            `${error.message}. Pass --model <id> with an effort supported by that model.`,
          );
        }
        throw error;
      }

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
      const metadata = await getChatThread({ threadId: thread.threadId });
      console.log(
        chalk.dim(
          `  Model:  ${metadata.selectedModel ?? "(default)"}${formatChatEffort(metadata.selectedModel, metadata.modelSettings)}`,
        ),
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
