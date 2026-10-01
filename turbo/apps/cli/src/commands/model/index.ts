import { Command } from "commander";
import chalk from "chalk";
import { getModelCatalog } from "../../lib/api/domains/model-catalog";
import { listModelPolicies } from "../../lib/api/domains/model-policies";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatModelPolicyStatus,
  formatModelProviderRoute,
  getModelProviderRouteKind,
} from "../../lib/domain/model-policy-display";
import {
  getCatalogModelDisplayName,
  getCatalogModelPriceTier,
  isCatalogModelActive,
  isCatalogSystemDefaultModel,
  sortByCatalogOrder,
} from "../../lib/domain/model-catalog-display";

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List models allowed by the current organization")
  .action(
    withErrorHandler(async () => {
      const [result, catalog] = await Promise.all([
        listModelPolicies(),
        getModelCatalog(),
      ]);
      const policies = sortByCatalogOrder(
        catalog,
        result.policies.filter((policy) => {
          return isCatalogModelActive(catalog, policy.model);
        }),
      );

      if (policies.length === 0) {
        console.log(chalk.dim("No models are allowed for this organization"));
        return;
      }

      console.log(chalk.bold("Allowed Models:"));
      console.log();

      for (const policy of policies) {
        const defaultMarker = isCatalogSystemDefaultModel(catalog, policy.model)
          ? chalk.dim(" (default)")
          : "";
        const name = getCatalogModelDisplayName(catalog, policy.model);
        console.log(
          `  - ${name} ${chalk.dim(`(${policy.model})`)}${defaultMarker}`,
        );
        console.log(`    provider: ${formatModelProviderRoute(policy)}`);

        if (getModelProviderRouteKind(policy) === "built-in") {
          console.log(
            `    price tier: ${getCatalogModelPriceTier(catalog, policy.model) ?? "unknown"}`,
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
