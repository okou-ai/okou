import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { withErrorHandler } from "../lib/command/with-error-handler";
import { getPlatformOrigin } from "../lib/platform-url";
import { planUpgradeUrl } from "./shared/billing-links";

type UpgradePlan = "pro";

function parseUpgradePlan(value: string): UpgradePlan {
  if (value !== "pro") {
    throw new InvalidArgumentError("plan must be pro");
  }
  return value;
}

export const upgradeCommand = new Command()
  .name("upgrade")
  .description("Create a link to compare and upgrade workspace plans")
  .argument("[plan]", "Plan to upgrade to: pro", parseUpgradePlan, "pro")
  .addHelpText(
    "after",
    `
Examples:
  Upgrade to Pro:  okou upgrade pro

Output:
  Prints a platform link that chat can render as an upgrade card`,
  )
  .action(
    withErrorHandler(async (plan: UpgradePlan) => {
      const platformOrigin = await getPlatformOrigin();
      console.log(chalk.bold(`Upgrade to ${plan === "pro" ? "Pro" : plan}:`));
      console.log(planUpgradeUrl(platformOrigin));
    }),
  );
