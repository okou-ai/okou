import { Command } from "commander";
import chalk from "chalk";
import {
  getBuiltInModelPriceTier,
  ORG_DEFAULT_RUN_MODEL,
} from "@okouai/api-contracts/contracts/model-providers";
import { listModelPolicies } from "../../lib/api/domains/model-policies";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatModelPolicyStatus,
  formatModelProviderRoute,
  getModelProviderRouteKind,
} from "../../lib/domain/model-policy-display";

function formatPriceTier(tier: string | undefined): string {
  return tier ?? "unknown";
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List models allowed by the current organization")
  .action(
    withErrorHandler(async () => {
      const result = await listModelPolicies();

      if (result.policies.length === 0) {
        console.log(chalk.dim("No models are allowed for this organization"));
        return;
      }

      console.log(chalk.bold("Allowed Models:"));
      console.log();

      for (const policy of result.policies) {
        const defaultMarker =
          policy.model === ORG_DEFAULT_RUN_MODEL ? chalk.dim(" (default)") : "";
        console.log(
          `  - ${policy.modelLabel} ${chalk.dim(`(${policy.model})`)}${defaultMarker}`,
        );
        console.log(`    provider: ${formatModelProviderRoute(policy)}`);

        if (getModelProviderRouteKind(policy) === "built-in") {
          console.log(
            `    price tier: ${formatPriceTier(getBuiltInModelPriceTier(policy.model))}`,
          );
        }

        const status = formatModelPolicyStatus(policy);
        if (status) {
          console.log(chalk.yellow(`    status: ${status}`));
        }
      }

      console.log();
      console.log(
        chalk.dim(
          "Use `okou model-provider set --help` to see how to switch each model between built-in and BYOK.",
        ),
      );
    }),
  );

export const switchCommand = new Command()
  .name("switch")
  .description("Show how to switch models in the current environment")
  .action(() => {
    console.log(
      "Open https://app.okou.ai and switch models from the model selector next to the input box.",
    );
  });

export const modelCommand = new Command()
  .name("model")
  .description("List available models and model-switching guidance")
  .addCommand(listCommand)
  .addCommand(switchCommand);
