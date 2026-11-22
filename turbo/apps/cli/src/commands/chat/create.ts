import chalk from "chalk";
import { Command } from "commander";

import { createChatThread, getChatThread } from "../../lib/api/domains/chat";
import { getModelCatalog } from "../../lib/api/domains/model-catalog";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatCatalogThreadModel,
  parseModelSelectionArgument,
} from "../../lib/domain/model-catalog-display";
import { isUuid } from "../../lib/utils/uuid";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { parseChatEffort, printChatUsageError } from "./shared";

interface CreateOptions {
  readonly projectId?: string;
  readonly json?: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly priority?: boolean;
}

export const createCommand = new Command()
  .name("create")
  .description("Create a new web chat thread")
  .argument("<title...>", "Chat title")

  .option(
    "--model <id>",
    "Model id for the thread, or auto for Auto (defaults to your model preference, then Auto)",
  )
  .option("--effort <level>", "Set reasoning effort for the selected model")
  .option(
    "--priority",
    "Enable priority for the thread (defaults to your initial model preference)",
  )
  .option(
    "--no-priority",
    "Use standard priority instead of your initial model preference",
  )
  .option("--project-id <id>", "Create inside this Project")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou chat create "Launch plan"
  okou chat create "Launch plan" --project-id <id> --model auto --json

Creating a chat does not start a run or copy this conversation. The first message must be self-contained.
Send it with okou chat send.
Model, effort and priority use your existing preferences unless specified.
`,
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

      if (options.projectId && !isUuid(options.projectId)) {
        throw new Error("Expected a Project UUID");
      }
      const model =
        options.model === undefined
          ? undefined
          : parseModelSelectionArgument(options.model);
      const reasoningEffort =
        options.effort === undefined
          ? undefined
          : parseChatEffort(
              options.effort,
              model === undefined
                ? undefined
                : { catalog: await getModelCatalog(), model },
            );
      let thread;
      try {
        thread = await createChatThread({
          title,
          projectId: options.projectId,
          ...(model === undefined ? {} : { model }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(options.priority === undefined
            ? {}
            : { serviceTier: options.priority ? "priority" : null }),
        });
      } catch (error) {
        if (
          reasoningEffort !== undefined &&
          model === undefined &&
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
          }),
        );
        return;
      }

      console.log(chalk.green("✓ Chat thread created"));
      console.log(chalk.dim(`  Thread: ${thread.threadId}`));
      console.log(chalk.dim(`  Title:  ${title}`));
      const [metadata, catalog] = await Promise.all([
        getChatThread({ threadId: thread.threadId }),
        getModelCatalog(),
      ]);
      console.log(
        chalk.dim(
          `  Model:  ${formatCatalogThreadModel(catalog, metadata.selectedModel, metadata.modelSettings)}`,
        ),
      );
      const priority =
        thread.serviceTier === "priority" ? "enabled" : "disabled";
      console.log(chalk.dim(`  Priority: ${priority}`));
      console.log();
      console.log("Send the first message:");
      console.log(
        chalk.cyan(
          `  okou chat send --thread-id ${thread.threadId} --text "<message>"`,
        ),
      );
    }),
  );
