import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import chalk from "chalk";
import { Command } from "commander";
import {
  getUserModelPreference,
  listRunModels,
  selectRunModel,
} from "../../lib/api/domains/run-models";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatModelProviderRoute,
  formatRunModelStatus,
} from "../../lib/domain/run-model-display";

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List Auto and your connected personal subscription models")
  .action(
    withErrorHandler(async () => {
      const { models, defaultModel } = await listRunModels();
      console.log(chalk.bold("Available Models:"));
      for (const model of models) {
        console.log(
          `  - ${model.modelLabel} (${model.model})${model.model === defaultModel ? " (default)" : ""}`,
        );
        console.log(`    provider: ${formatModelProviderRoute(model)}`);
        const status = formatRunModelStatus(model);
        if (status) console.log(chalk.yellow(`    status: ${status}`));
      }
      console.log(
        chalk.dim(
          "Select your default: okou model select <model>. For one chat: okou chat model <model>.",
        ),
      );
    }),
  );

interface SelectOptions {
  readonly priority?: boolean;
}

/**
 * Without an explicit flag, keep the saved tier when it still applies: the
 * same model echoes it unchanged, and another subscription model keeps
 * priority only when its subscription offers it.
 */
async function resolveServiceTier(
  selected: AvailableRunModel,
  priority: boolean | undefined,
): Promise<ChatThreadServiceTier | null> {
  if (priority !== undefined) {
    return priority ? "priority" : null;
  }
  const stored = await getUserModelPreference();
  if (stored.serviceTier === null || stored.selectedModel === selected.model) {
    return stored.serviceTier;
  }
  return stored.serviceTier === "priority" &&
    selected.subscriptionOptions?.serviceTier === "priority"
    ? "priority"
    : null;
}

const selectCommand = new Command()
  .name("select")
  .argument(
    "<model>",
    "Auto model id or a connected personal subscription model",
  )
  .description("Select your default model for new chats")
  .option("--priority", "Enable priority (Fast) for new chats on this model")
  .option(
    "--no-priority",
    "Use standard priority instead of your saved preference",
  )
  .action(
    withErrorHandler(async (model: string, options: SelectOptions) => {
      const available = await listRunModels();
      const selected = available.models.find((candidate) => {
        return candidate.model === model;
      });
      if (!selected || !isMemberRunModelConfigurable(selected)) {
        throw new Error(
          `Model is unavailable: ${model}. Run okou model ls and connect or reconnect your subscription in Settings > Models.`,
        );
      }
      const serviceTier = await resolveServiceTier(selected, options.priority);
      const result = await selectRunModel(model, serviceTier);
      console.log(
        chalk.green(`✓ Default model selected: ${result.selectedModel}`),
      );
      if (result.serviceTier !== null) {
        console.log(chalk.dim(`  Service tier: ${result.serviceTier}`));
      }
    }),
  );

export const switchCommand = new Command()
  .name("switch")
  .description("Show how to switch models in the current environment")
  .action(() => {
    console.log(
      "Use okou model select <model> for new chats, or okou chat model <model> for the current chat. You can also use the model selector next to the input box at https://app.okou.ai.",
    );
  });

export const modelCommand = new Command()
  .name("model")
  .description("List and select Auto or personal subscription models")
  .addCommand(listCommand)
  .addCommand(selectCommand)
  .addCommand(switchCommand);
