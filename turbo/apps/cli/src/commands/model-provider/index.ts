import chalk from "chalk";
import { Command } from "commander";
import { listRunModels } from "../../lib/api/domains/run-models";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatModelProviderRoute,
  formatRunModelStatus,
} from "../../lib/domain/run-model-display";

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List Auto and your connected personal subscription routes")
  .action(
    withErrorHandler(async () => {
      const { models, defaultModel } = await listRunModels();
      console.log(chalk.bold("Model Routes:"));
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
          "Connect or reconnect personal ChatGPT or Claude subscriptions in Settings / Models.",
        ),
      );
    }),
  );

export const modelProviderCommand = new Command()
  .name("model-provider")
  .description("Inspect Auto and personal subscription routes")
  .addCommand(listCommand);
