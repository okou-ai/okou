import { Command, Option } from "commander";
import chalk from "chalk";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";

import {
  createCreditCheckout,
  getBillingStatus,
} from "../lib/api/domains/billing";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { decodeSandboxTokenPayload } from "../lib/api/sandbox-token";
import { getPlatformOrigin } from "../lib/platform-url";
import {
  currentPlanAllowsVideo,
  currentPlanCanBuyCredits,
  currentTokenCanReadBilling,
} from "./shared/billing-capabilities";
import { planUpgradeUrl } from "./shared/billing-links";

function parseCredits(value: string): number {
  const credits = Number(value.replaceAll(",", ""));
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error("credits must be a positive integer");
  }
  return credits;
}

function requireCapabilityForCreditAction(
  capability: Capability,
  message: string,
): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes(capability)) {
    throw new Error(message);
  }
}

interface CreditOptions {
  readonly autoRecharge?: boolean;
  readonly autoRechargeThreshold?: number;
  readonly autoRechargeAmount?: number;
}

function autoRechargeConfiguration(options: CreditOptions):
  | {
      readonly enabled: true;
      readonly threshold: number;
      readonly amount: number;
    }
  | undefined {
  if (
    options.autoRecharge !== true &&
    (options.autoRechargeThreshold !== undefined ||
      options.autoRechargeAmount !== undefined)
  ) {
    throw new Error(
      "--auto-recharge-threshold and --auto-recharge-amount require --auto-recharge",
    );
  }

  if (options.autoRecharge !== true) {
    return undefined;
  }
  if (
    options.autoRechargeThreshold === undefined ||
    options.autoRechargeAmount === undefined
  ) {
    throw new Error(
      "--auto-recharge requires --auto-recharge-threshold and --auto-recharge-amount",
    );
  }
  return {
    enabled: true,
    threshold: options.autoRechargeThreshold,
    amount: options.autoRechargeAmount,
  };
}

function printCreditStatus(billing: BillingStatusResponse): void {
  console.log(chalk.bold("Credit status:"));
  console.log(`  Tier: ${chalk.cyan(billing.tier)}`);
  console.log(
    `  Available credits: ${chalk.cyan(billing.credits.toLocaleString())}`,
  );
  console.log(
    `  Can purchase credits: ${
      currentPlanCanBuyCredits(billing)
        ? chalk.green("yes")
        : chalk.yellow("no")
    }`,
  );
  console.log(
    `  Built-in video generation: ${
      currentPlanAllowsVideo(billing)
        ? chalk.green("available")
        : chalk.yellow("unavailable")
    }`,
  );
  console.log(
    `  Auto-recharge: ${
      billing.autoRecharge.enabled ? chalk.green("enabled") : "disabled"
    }`,
  );
  if (billing.autoRecharge.enabled) {
    console.log(
      `    Threshold: ${billing.autoRecharge.threshold?.toLocaleString() ?? "not set"}`,
    );
    console.log(
      `    Amount: ${billing.autoRecharge.amount?.toLocaleString() ?? "not set"}`,
    );
  }
}

async function showCreditStatus(options: CreditOptions): Promise<void> {
  requireCapabilityForCreditAction(
    "billing:read",
    "checking credit status requires billing:read capability",
  );
  if (
    options.autoRecharge === true ||
    options.autoRechargeThreshold !== undefined ||
    options.autoRechargeAmount !== undefined
  ) {
    throw new Error("auto-recharge options require a credit amount");
  }
  printCreditStatus(await getBillingStatus());
}

async function buyCredits(
  credits: number,
  options: CreditOptions,
): Promise<void> {
  requireCapabilityForCreditAction(
    "billing:write",
    "buying credits requires billing:write capability",
  );
  const autoRecharge = autoRechargeConfiguration(options);
  // Only workspace admins can buy credits; the checkout route enforces it.
  const billing = currentTokenCanReadBilling()
    ? await getBillingStatus()
    : null;
  const origin = await getPlatformOrigin();
  if (billing && !currentPlanCanBuyCredits(billing)) {
    console.log(
      chalk.yellow(
        "Credit purchases are not available for this workspace plan.",
      ),
    );
    console.log(chalk.bold("Plan upgrade link:"));
    console.log(planUpgradeUrl(origin));
    return;
  }

  const result = await createCreditCheckout({
    credits,
    successUrl: `${origin}/?settings=usage&credit=success`,
    cancelUrl: `${origin}/?settings=usage&credit=canceled`,
    ...(autoRecharge ? { autoRecharge } : {}),
  });
  console.log(chalk.bold("Credit checkout link:"));
  console.log(result.url);
}

export const creditCommand = new Command()
  .name("credit")
  .description("View credit balance or create a checkout link to buy credits")
  .argument("[credits]", "Number of credits to buy", parseCredits)
  .addOption(
    new Option("--auto-recharge", "Enable auto-recharge after checkout"),
  )
  .option(
    "--auto-recharge-threshold <credits>",
    "Recharge when balance is at or below this number of credits",
    parseCredits,
  )
  .option(
    "--auto-recharge-amount <credits>",
    "Credits to buy for each auto-recharge",
    parseCredits,
  )
  .action(
    withErrorHandler(
      async (credits: number | undefined, options: CreditOptions) => {
        if (credits === undefined) {
          await showCreditStatus(options);
          return;
        }
        await buyCredits(credits, options);
      },
    ),
  );
