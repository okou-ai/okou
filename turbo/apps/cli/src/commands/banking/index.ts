import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import {
  callBanking,
  type BankingResponse,
} from "../../lib/api/domains/banking";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../lib/okou-env";
import {
  finalizeActionUrl,
  printCallbackTurnInstruction,
} from "../connector/action-url";
import { getPlatformOrigin } from "../../lib/platform-url";

interface JsonOption {
  readonly json?: boolean;
}

interface BalancesOptions extends JsonOption {
  readonly accountId: string;
}

interface TransactionsOptions extends JsonOption {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

interface AccessRequestOptions {
  readonly reason: string;
  readonly callbackPrompt: string;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new InvalidArgumentError("limit must be between 1 and 1000");
  }
  return parsed;
}

function parseDateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidArgumentError("date must be formatted as YYYY-MM-DD");
  }
  return value;
}

function renderBankingResponse(label: string, response: BankingResponse): void {
  console.log(chalk.green(`✓ ${label}`));
  console.log(chalk.dim(`  Provider: ${response.provider}`));

  if (response.accounts) {
    console.log(JSON.stringify(response.accounts, null, 2));
    return;
  }
  if (response.balance) {
    console.log(JSON.stringify(response.balance, null, 2));
    return;
  }
  console.log(JSON.stringify(response.transactions ?? [], null, 2));
}

async function runBankingRequest(
  label: string,
  operation: "accounts" | "balances" | "transactions",
  payload: Record<string, unknown>,
  options: JsonOption,
): Promise<void> {
  const response = await callBanking(operation, payload);
  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }
  renderBankingResponse(label, response);
}

const accessRequestCommand = new Command()
  .name("access-request")
  .description("Ask the current web chat user to grant banking access")
  .requiredOption("--reason <purpose>", "Why banking data is needed")
  .requiredOption(
    "--callback-prompt <prompt>",
    "Start the next chat round with this prompt after the user continues",
  )
  .action(
    withErrorHandler(async (options: AccessRequestOptions) => {
      const agentId = getOkouAgentId()?.trim();
      if (!agentId) {
        throw new Error(
          "banking access-request is only available to the current web chat agent",
        );
      }
      const reason = options.reason.trim();
      if (!reason) {
        throw new Error("--reason cannot be empty");
      }
      if (reason.length > 500) {
        throw new Error("--reason cannot exceed 500 characters");
      }

      const origin = await getPlatformOrigin();
      const actionUrl = new URL(
        `/agents/${encodeURIComponent(agentId)}/banking`,
        origin,
      );
      actionUrl.searchParams.set("reason", reason);
      const url = finalizeActionUrl(actionUrl, options.callbackPrompt, agentId);

      console.log("Banking access requires user approval:");
      console.log(url);
      printCallbackTurnInstruction();
    }),
  );

const accountsCommand = new Command()
  .name("accounts")
  .description("List enabled banking accounts")
  .option("--json", "Print the raw banking response as JSON")
  .action(
    withErrorHandler(async (options: JsonOption) => {
      await runBankingRequest(
        "Banking accounts loaded",
        "accounts",
        {},
        options,
      );
    }),
  );

const balancesCommand = new Command()
  .name("balances")
  .description("Read an enabled account balance")
  .requiredOption("--account-id <id>", "Enabled provider account ID")
  .option("--json", "Print the raw banking response as JSON")
  .action(
    withErrorHandler(async (options: BalancesOptions) => {
      await runBankingRequest(
        "Banking balance loaded",
        "balances",
        { accountId: options.accountId },
        options,
      );
    }),
  );

const transactionsCommand = new Command()
  .name("transactions")
  .description("Read transactions for an enabled account")
  .requiredOption("--account-id <id>", "Enabled provider account ID")
  .requiredOption(
    "--from <date>",
    "Start date, formatted as YYYY-MM-DD",
    parseDateOnly,
  )
  .requiredOption(
    "--to <date>",
    "End date, formatted as YYYY-MM-DD",
    parseDateOnly,
  )
  .option("--limit <n>", "Maximum transactions to return", parseLimit, 100)
  .option("--json", "Print the raw banking response as JSON")
  .action(
    withErrorHandler(async (options: TransactionsOptions) => {
      await runBankingRequest(
        "Banking transactions loaded",
        "transactions",
        {
          accountId: options.accountId,
          from: options.from,
          to: options.to,
          limit: options.limit,
        },
        options,
      );
    }),
  );

export const bankingCommand = new Command()
  .name("banking")
  .description("Use managed Okou banking services")
  .addCommand(accessRequestCommand)
  .addCommand(accountsCommand)
  .addCommand(balancesCommand)
  .addCommand(transactionsCommand)
  .addHelpText(
    "after",
    `
Examples:
  Request access:     okou banking access-request --reason "Review recent expenses" --callback-prompt "Banking access is ready; continue the expense review"
  List accounts:      okou banking accounts --json
  Get balance:        okou banking balances --account-id <id> --json
  Get transactions:   okou banking transactions --account-id <id> --from 2026-01-01 --to 2026-01-31 --json

Notes:
  - access-request only works for the current agent in the current web chat
  - The user selects accounts and an expiration before access is granted
  - Banking grants never apply to automation runs
  - Authenticates via OKOU_TOKEN (requires banking:read capability)
  - Finicity credentials and app tokens stay on the Okou API server
  - Access is limited to accounts enabled for the current agent`,
  );
