import { Command, InvalidArgumentError } from "commander";
import {
  walletCreateSpendSchema,
  type WalletSpend,
} from "@okouai/api-contracts/contracts/wallet";
import { LINK_WALLET_GUIDE } from "@okouai/core/link-wallet-guide";

import {
  walletCancelSpend,
  walletConnect,
  walletCreateSpend,
  walletDisconnect,
  walletGetSpend,
  walletStatus,
} from "../../lib/api/domains/wallet";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface JsonOptions {
  readonly json?: boolean;
}
interface SpendOptions extends JsonOptions {
  readonly intentId: string;
  readonly amount: number;
  readonly currency: string;
  readonly merchantName: string;
  readonly merchantUrl: string;
  readonly context: string;
  readonly test?: boolean;
}
function amount(value: string): number {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > 2_147_483_647
  ) {
    throw new InvalidArgumentError(
      "Amount must be positive integer cents, not a decimal dollar value",
    );
  }
  return Number(value);
}
function renderSpend(value: WalletSpend, options: JsonOptions): void {
  if (options.json) {
    console.log(JSON.stringify(value));
    return;
  }
  console.log(`Spend request: ${value.id}`);
  console.log(`Status: ${value.status}`);
  console.log(`Merchant: ${value.merchantName}`);
  console.log(`Total: ${value.amount} ${value.currency.toUpperCase()} cents`);
  console.log(`Next action: ${value.nextAction}`);
  if (value.approvalUrl) {
    console.log(value.approvalUrl);
    console.log(
      "Share this exact URL and end the turn. The user must approve personally on Link.",
    );
  }
  if (value.action?.url) {
    console.log(value.action.url);
  }
  if (value.status === "approved") {
    console.log(
      "Approved is not paid. Managed checkout and credential retrieval are not available.",
    );
  }
}

const spend = new Command("spend")
  .description("Create and inspect a per-purchase Link approval request")
  .addCommand(
    new Command("create")
      .requiredOption(
        "--intent-id <uuid>",
        "Stable UUID for this purchase intent; preserve it across retries",
      )
      .requiredOption(
        "--amount <cents>",
        "Final total in integer USD cents",
        amount,
      )
      .option("--currency <code>", "Currency (first version: usd)", "usd")
      .requiredOption(
        "--merchant-name <name>",
        "Merchant shown on Link's approval screen",
      )
      .requiredOption("--merchant-url <url>", "HTTPS merchant or product URL")
      .requiredOption(
        "--context <description>",
        "Purchase and purpose shown to the user (100-2000 characters)",
      )
      .option("--test", "Create a no-funds test request")
      .option("--json", "Print only the redacted JSON response")
      .action(
        withErrorHandler(async (options: SpendOptions) => {
          const input = walletCreateSpendSchema.parse({
            ...options,
            test: options.test ?? false,
          });
          renderSpend(await walletCreateSpend(input), options);
        }),
      ),
  )
  .addCommand(
    new Command("get")
      .argument("<id>", "Okou spend request ID")
      .option("--json", "Print only the redacted JSON response")
      .action(
        withErrorHandler(async (id: string, options: JsonOptions) => {
          renderSpend(await walletGetSpend(id), options);
        }),
      ),
  )
  .addCommand(
    new Command("cancel")
      .argument("<id>", "Okou spend request ID")
      .option("--json", "Print only the redacted JSON response")
      .action(
        withErrorHandler(async (id: string, options: JsonOptions) => {
          renderSpend(await walletCancelSpend(id), options);
        }),
      ),
  );

export const walletCommand = new Command("wallet")
  .description(
    "Connect Link and request purchase approval (checkout is not yet available)",
  )
  .addCommand(
    new Command("status")
      .option("--json", "Print wallet status as JSON")
      .action(
        withErrorHandler(async (options: JsonOptions) => {
          const value = await walletStatus();
          console.log(
            options.json
              ? JSON.stringify(value)
              : `Link wallet: ${value.connected ? "connected" : "not connected"}. Next: ${value.nextAction}. Checkout unavailable.`,
          );
        }),
      ),
  )
  .addCommand(
    new Command("connect")
      .option("--json", "Print the hosted consent URL as JSON")
      .action(
        withErrorHandler(async (options: JsonOptions) => {
          const value = await walletConnect();
          if (options.json) {
            console.log(JSON.stringify(value));
            return;
          }
          console.log("Connect your Link wallet:");
          console.log(value.url);
          console.log(
            "Share this exact URL and end the turn. OAuth consent does not approve any purchase.",
          );
        }),
      ),
  )
  .addCommand(
    new Command("disconnect")
      .option("--json", "Print revocation confirmation as JSON")
      .action(
        withErrorHandler(async (options: JsonOptions) => {
          const value = await walletDisconnect();
          console.log(
            options.json
              ? JSON.stringify(value)
              : "Link wallet disconnected and grant revoked.",
          );
        }),
      ),
  )
  .addCommand(
    new Command("guide")
      .description("Read the consent and approval safety workflow")
      .action(() => {
        console.log(LINK_WALLET_GUIDE);
      }),
  )
  .addCommand(spend)
  .addHelpText(
    "after",
    "\nClient credentials and user tokens stay on the backend. No card/token retrieval or checkout commands are provided. Requires wallet:write and the default-off linkWallet feature switch.",
  );
