import { Command } from "commander";
import {
  walletSpendListQuerySchema,
  walletTransactionsQuerySchema,
} from "@okouai/api-contracts/contracts/wallet";

import {
  walletListSpends,
  walletTransactions,
  walletPaymentMethods,
  walletPaymentMethod,
  walletUserInfo,
} from "../../lib/api/domains/wallet";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface ReadOptions {
  readonly json?: boolean;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly startingAfter?: string;
  readonly limit?: string;
  readonly status?: string;
  readonly mode?: string;
  readonly category?: string;
  readonly origin?: string;
}

function printRead(value: unknown, options: ReadOptions, guidance: string) {
  console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  if (!options.json) console.log(guidance);
}

function pageOptions(command: Command) {
  return command
    .option(
      "--start-date <YYYY-MM-DD>",
      "Inclusive start date (spend history uses UTC)",
    )
    .option(
      "--end-date <YYYY-MM-DD>",
      "Inclusive end date (spend history uses UTC)",
    )
    .option("--limit <count>", "Page size, 1-100 (default: 20)")
    .option(
      "--starting-after <id>",
      "Continue with the previous page's nextCursor",
    )
    .option("--json", "Print only the structured JSON response");
}

export const walletSpendListCommand = pageOptions(new Command("list"))
  .description(
    "List this user's purchase requests for the current Agent, including recorded history",
  )
  .option("--status <status>", "Filter by recorded request status")
  .option("--mode <mode>", "Filter all, live, or test requests (default: all)")
  .action(
    withErrorHandler(async (options: ReadOptions) => {
      const query = walletSpendListQuerySchema.parse({
        startDate: options.startDate,
        endDate: options.endDate,
        startingAfter: options.startingAfter,
        limit: options.limit,
        status: options.status,
        mode: options.mode,
      });
      printRead(
        await walletListSpends(query),
        options,
        "These are recorded requests, not settled spending. Use spend get <id> to refresh an eligible request; use transactions list for actual Link activity. Continue with --starting-after <nextCursor> when hasMore is true.",
      );
    }),
  );

export const walletTransactionsCommand = new Command("transactions")
  .description("Read authorized Link transaction history")
  .addCommand(
    pageOptions(new Command("list"))
      .option("--origin <origin>", "Transaction source (currently link only)")
      .option("--category <category>", "Filter by Link transaction category")
      .action(
        withErrorHandler(async (options: ReadOptions) => {
          const query = walletTransactionsQuerySchema.parse({
            startDate: options.startDate,
            endDate: options.endDate,
            startingAfter: options.startingAfter,
            limit: options.limit,
            category: options.category,
            origin: options.origin,
          });
          printRead(
            await walletTransactions(query),
            options,
            "Amounts are in each currency's minor unit. Results contain Link activity only. Follow nextCursor with --starting-after. A null hasMore means Link did not report completeness; an empty page is not proof of zero activity outside these filters or permissions.",
          );
        }),
      ),
  );

export const walletPaymentMethodsCommand = new Command("payment-methods")
  .description(
    "Inspect saved payment methods without retrieving payment credentials",
  )
  .addCommand(
    new Command("list")
      .option("--json", "Print only redacted payment-method JSON")
      .action(
        withErrorHandler(async (options: ReadOptions) => {
          printRead(
            await walletPaymentMethods(),
            options,
            "Use payment-methods get <id> for one method. Add or manage saved cards in Link.",
          );
        }),
      ),
  )
  .addCommand(
    new Command("get")
      .argument("<id>", "Link payment method ID")
      .option("--json", "Print only redacted payment-method JSON")
      .action(
        withErrorHandler(async (id: string, options: ReadOptions) => {
          printRead(
            await walletPaymentMethod(id),
            options,
            "Saved-method metadata does not authorize a purchase.",
          );
        }),
      ),
  );

export const walletUserInfoCommand = new Command("user-info")
  .description(
    "Read Link profile, spending limits and verification requirements",
  )
  .addCommand(
    new Command("get")
      .option("--json", "Print only authorized user-information JSON")
      .action(
        withErrorHandler(async (options: ReadOptions) => {
          const value = await walletUserInfo();
          printRead(
            value,
            options,
            "Spending limits are reported in cents without an explicit currency; null means unlimited. The user must complete any verification action personally.",
          );
          if (!options.json && value.verification?.actionUrl)
            console.log(value.verification.actionUrl);
        }),
      ),
  );
