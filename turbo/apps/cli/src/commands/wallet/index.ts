import { Command, InvalidArgumentError } from "commander";
import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
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
  walletSpendCredentials,
} from "../../lib/api/domains/wallet";
import { withErrorHandler } from "../../lib/command/with-error-handler";

import {
  walletSpendListCommand,
  walletTransactionsCommand,
  walletPaymentMethodsCommand,
  walletUserInfoCommand,
} from "./reads";

interface JsonOptions {
  readonly json?: boolean;
}
interface CredentialsOptions extends JsonOptions {
  readonly outputFile: string;
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
  console.log(`Requested at: ${value.createdAt}`);
  if (value.payment)
    console.log(`Latest payment: ${JSON.stringify(value.payment)}`);
  if (value.paymentHistory)
    console.log(`Payment history: ${JSON.stringify(value.paymentHistory)}`);
  if (value.approvalUrl) {
    console.log(value.approvalUrl);
    console.log(
      "Share this exact URL and end the turn. The user must approve personally on Link.",
    );
    if (value.autoContinue) {
      console.log(
        `Okou will continue this chat after approval until ${value.expiresAt}. You can also continue manually. Approved is not paid.`,
      );
    }
  }
  if (value.action?.url) {
    console.log(value.action.url);
  }
  if (value.status === "approved") {
    console.log(
      `Approved is not paid. Retrieve the one-time card with: okou wallet spend credentials ${value.id} --output-file <private-json-path>`,
    );
  }
}

async function saveCredentials(id: string, outputFile: string) {
  const path = resolve(outputFile);
  const file = await open(path, "wx", 0o600);
  let completed = false;
  try {
    const credentials = await walletSpendCredentials(id);
    await file.writeFile(`${JSON.stringify(credentials)}\n`, "utf8");
    completed = true;
    const { card } = credentials;
    return {
      spend: credentials.spend,
      credentialsFile: path,
      card: {
        brand: card.brand,
        last4: card.number.slice(-4),
        expMonth: card.expMonth,
        expYear: card.expYear,
        validUntil: card.validUntil,
      },
    };
  } finally {
    try {
      await file.close();
    } finally {
      if (!completed) {
        await unlink(path);
      }
    }
  }
}

const spend = new Command("spend")
  .description("Create and inspect a per-purchase Link approval request")
  .addCommand(walletSpendListCommand)
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
    new Command("credentials")
      .description(
        "Retrieve an approved purchase's one-time card into a private JSON file",
      )
      .argument("<id>", "Okou spend request ID")
      .requiredOption(
        "--output-file <path>",
        "New credential file (mode 0600); existing files are never overwritten",
      )
      .option(
        "--json",
        "Print only the file path, spend details and redacted card summary",
      )
      .action(
        withErrorHandler(async (id: string, options: CredentialsOptions) => {
          const result = await saveCredentials(id, options.outputFile);
          if (options.json) {
            console.log(JSON.stringify(result));
            return;
          }
          console.log(
            `Payment credentials saved to: ${result.credentialsFile}`,
          );
          console.log(
            `Card: ${result.card.brand} ending in ${result.card.last4}`,
          );
          console.log(
            "Approved is not paid. Pass the file to the payment tool without printing its contents; delete it after use.",
          );
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
    "Connect Link, read authorized activity and request purchase approval",
  )
  .addCommand(
    new Command("status")
      .option("--json", "Print wallet status as JSON")
      .action(
        withErrorHandler(async (options: JsonOptions) => {
          const value = await walletStatus();
          const nextAction =
            value.connected && !value.authorization.capabilities.payments
              ? "read_wallet"
              : value.nextAction;
          console.log(
            options.json
              ? JSON.stringify(value)
              : `Link wallet: ${value.connected ? "connected" : "not connected"}. Next: ${nextAction}. Checkout unavailable.`,
          );
          if (!options.json) {
            console.log(
              `Granted scopes: ${value.authorization.scopes.join(", ") || "not recorded; reconnect or refresh to inspect"}`,
            );
            console.log(
              `Source actions: ${value.authorization.sourceActions.join(", ") || "none"}`,
            );
            console.log(
              `Available reads: ${JSON.stringify(value.authorization.capabilities)}`,
            );
            console.log(
              `Missing permissions: ${value.authorization.missingPermissions.join(", ") || "none"}`,
            );
          }
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
  .addCommand(walletTransactionsCommand)
  .addCommand(walletPaymentMethodsCommand)
  .addCommand(walletUserInfoCommand)
  .addHelpText(
    "after",
    "\nOAuth credentials stay on the backend. Payment credentials are written only to a new private file. When a spend response has autoContinue=true, the backend watches approval for at most 30 minutes and continues the original chat. Otherwise ask the user to return after approval. No agent-side polling or checkout commands are provided. Reads require wallet:read (existing wallet:write tokens are also accepted). Spending requires wallet:write and Link payment consent. All operations require the linkWallet feature switch. Connect requests payment, profile and Link transaction access together. Each purchase still requires separate approval.",
  );
