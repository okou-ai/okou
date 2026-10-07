import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import chalk from "chalk";
import { Command } from "commander";
import {
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

const selectCommand = new Command()
  .name("select")
  .argument(
    "<model>",
    "Auto model id or a connected personal subscription model",
  )
  .description("Select your default model for new chats")
  .action(
    withErrorHandler(async (model: string) => {
      const available = await listRunModels();
      const selected = available.models.find((candidate) => {
        return candidate.model === model;
      });
      if (!selected || !isMemberRunModelConfigurable(selected)) {
        throw new Error(
          `Model is unavailable: ${model}. Run okou model ls and connect or reconnect your subscription in Preferences / Personal Models.`,
        );
      }
      const result = await selectRunModel(model);
      console.log(
        chalk.green(`✓ Default model selected: ${result.selectedModel}`),
      );
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
