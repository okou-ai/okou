import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import {
  FINANCE_DEFAULT_INTERVAL,
  FINANCE_DEFAULT_RANGE,
  financeChartRequestSchema,
  financeIntervalSchema,
  financeProfileRequestSchema,
  financeQuoteRequestSchema,
  financeRangeSchema,
  financeSearchRequestSchema,
  type FinanceResponse,
  type FinanceInterval,
  type FinanceRange,
} from "@okouai/api-contracts/contracts/finance";

import {
  callFinanceChart,
  callFinanceProfile,
  callFinanceQuote,
  callFinanceSearch,
} from "../../lib/api/domains/finance";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface JsonOption {
  readonly json?: boolean;
}

interface ChartOptions extends JsonOption {
  readonly range: FinanceRange;
  readonly interval: FinanceInterval;
}

function firstIssueMessage(
  result:
    | ReturnType<typeof financeSearchRequestSchema.safeParse>
    | ReturnType<typeof financeProfileRequestSchema.safeParse>
    | ReturnType<typeof financeQuoteRequestSchema.safeParse>
    | ReturnType<typeof financeChartRequestSchema.safeParse>,
): string {
  return result.success
    ? "finance request is invalid"
    : (result.error.issues[0]?.message ?? "finance request is invalid");
}

function parseRange(value: string): FinanceRange {
  const result = financeRangeSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `range must be one of: ${financeRangeSchema.options.join(", ")}`,
  );
}

function parseInterval(value: string): FinanceInterval {
  const result = financeIntervalSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `interval must be one of: ${financeIntervalSchema.options.join(", ")}`,
  );
}

function renderResponse(response: FinanceResponse, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(response));
    return;
  }

  console.log(chalk.green(`✓ Finance ${response.operation} completed`));
  console.log(JSON.stringify(response.result, null, 2));
  console.log(chalk.dim(`Provider: ${response.provider}`));
  console.log(
    chalk.dim(
      `Credits charged: ${response.creditsCharged === null ? "pending" : response.creditsCharged}`,
    ),
  );
}

const searchCommand = new Command()
  .name("search")
  .description("Search for a financial instrument")
  .argument("<query>", "Company name, symbol, or instrument")
  .option("--json", "Print the raw Okou Finance response as JSON")
  .action(
    withErrorHandler(async (query: string, options: JsonOption) => {
      const request = financeSearchRequestSchema.safeParse({ query });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callFinanceSearch(request.data), options.json);
    }),
  );

const profileCommand = new Command()
  .name("profile")
  .description("Fetch a company profile")
  .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
  .option("--json", "Print the raw Okou Finance response as JSON")
  .action(
    withErrorHandler(async (symbol: string, options: JsonOption) => {
      const request = financeProfileRequestSchema.safeParse({ symbol });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callFinanceProfile(request.data), options.json);
    }),
  );

const quoteCommand = new Command()
  .name("quote")
  .description("Fetch the latest available market quote")
  .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
  .option("--json", "Print the raw Okou Finance response as JSON")
  .action(
    withErrorHandler(async (symbol: string, options: JsonOption) => {
      const request = financeQuoteRequestSchema.safeParse({ symbol });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callFinanceQuote(request.data), options.json);
    }),
  );

const chartCommand = new Command()
  .name("chart")
  .description("Fetch OHLCV chart data")
  .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
  .addOption(
    new Option("--range <range>", "Chart time range")
      .default(FINANCE_DEFAULT_RANGE)
      .argParser(parseRange),
  )
  .addOption(
    new Option("--interval <interval>", "Chart interval")
      .default(FINANCE_DEFAULT_INTERVAL)
      .argParser(parseInterval),
  )
  .option("--json", "Print the raw Okou Finance response as JSON")
  .action(
    withErrorHandler(async (symbol: string, options: ChartOptions) => {
      const request = financeChartRequestSchema.safeParse({
        symbol,
        range: options.range,
        interval: options.interval,
      });
      if (!request.success) {
        throw new InvalidArgumentError(firstIssueMessage(request));
      }
      renderResponse(await callFinanceChart(request.data), options.json);
    }),
  );

export const financeCommand = new Command()
  .name("finance")
  .description("Query financial instruments through managed Okou Finance")
  .addCommand(searchCommand)
  .addCommand(profileCommand)
  .addCommand(quoteCommand)
  .addCommand(chartCommand)
  .addHelpText(
    "after",
    `
Examples:
  Search instruments:  okou finance search "Tencent"
  Company profile:     okou finance profile AAPL
  Latest quote:        okou finance quote 0700.HK --json
  Historical chart:   okou finance chart AAPL --range 1y --interval 1d

Notes:
  - Authenticates via OKOU_TOKEN (requires finance:read capability) or a CLI token
  - Each successful command consumes 1 credit
  - Data is returned from APIDojo's Yahoo Finance API on RapidAPI without Okou-side caching`,
  );
