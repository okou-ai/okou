import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";
import { Command } from "commander";
import chalk from "chalk";
import { getModelCatalog } from "../../lib/api/domains/model-catalog";
import { listModelPolicies } from "../../lib/api/domains/model-policies";
import {
  getCatalogModelDisplayName,
  isCatalogModelActive,
  isCatalogSystemDefaultModel,
  sortByCatalogOrder,
} from "../../lib/domain/model-catalog-display";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatModelPolicyStatus,
  getModelProviderRouteKind,
  getModelProviderTypeLabel,
} from "../../lib/domain/model-policy-display";

export const MODEL_PROVIDER_SET_GUIDANCE = [
  "Model provider routing is configured in the web app.",
  "",
  "Organization admins: open https://app.okou.ai, use the top-left organization menu, choose Manage, then add, delete, or adjust model providers.",
  "",
  "Members: use the bottom-left user menu, choose Preferences / Personal Models, and connect or reconnect your personal subscription. `okou model-provider ls` shows your effective provider for each model.",
].join("\n");

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description(
    "List provider routing for each model allowed by the organization",
  )
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
        console.log(
          chalk.dim(
            "No model provider routes are allowed for this organization",
          ),
        );
        return;
      }

      console.log(chalk.bold("Model Provider Routes:"));
      console.log();

      for (const policy of policies) {
        const defaultMarker = isCatalogSystemDefaultModel(catalog, policy.model)
          ? chalk.dim(" (default)")
          : "";
        const name = getCatalogModelDisplayName(catalog, policy.model);
        console.log(
          `  - ${name} ${chalk.dim(`(${policy.model})`)}${defaultMarker}`,
        );
        const route = getMemberModelPolicyRoute(policy);
        console.log(`    provider: ${getModelProviderRouteKind(policy)}`);
        console.log(
          `    provider type: ${route.providerType} (${getModelProviderTypeLabel(route.providerType)})`,
        );

        const status = formatModelPolicyStatus(policy);
        if (status) {
          console.log(chalk.yellow(`    status: ${status}`));
        }
      }
    }),
  );

export const setCommand = new Command()
  .name("set")
  .description("Show where to adjust model provider routing")
  .addHelpText("after", `\n${MODEL_PROVIDER_SET_GUIDANCE}`)
  .action(() => {
    console.log(MODEL_PROVIDER_SET_GUIDANCE);
  });

export const modelProviderCommand = new Command()
  .name("model-provider")
  .description("Inspect model provider routing")
  .addCommand(listCommand)
  .addCommand(setCommand);
