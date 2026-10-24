import { printDataRouterTool } from "../data/print-result";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  FINANCE_DEFAULT_INTERVAL,
  FINANCE_DEFAULT_RANGE,
  financeChartRequestSchema,
  financeIntervalSchema,
  financeProfileRequestSchema,
  financeQuoteRequestSchema,
  financeRangeSchema,
  financeSearchRequestSchema,
  type FinanceInterval,
  type FinanceRange,
} from "@okouai/api-contracts/contracts/finance";
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

export function createFinanceCommand(): Command {
  const searchCommand = new Command()
    .name("search")
    .description("Search for a financial instrument")
    .argument("<query>", "Company name, symbol, or instrument")
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(async (query: string, options: JsonOption) => {
        const request = financeSearchRequestSchema.safeParse({ query });
        if (!request.success) {
          throw new InvalidArgumentError(firstIssueMessage(request));
        }
        await printDataRouterTool("finance_search", request.data, options.json);
      }),
    );

  const profileCommand = new Command()
    .name("profile")
    .description("Fetch a company profile")
    .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(async (symbol: string, options: JsonOption) => {
        const request = financeProfileRequestSchema.safeParse({ symbol });
        if (!request.success) {
          throw new InvalidArgumentError(firstIssueMessage(request));
        }
        await printDataRouterTool(
          "finance_profile",
          request.data,
          options.json,
        );
      }),
    );

  const quoteCommand = new Command()
    .name("quote")
    .description("Fetch the latest available market quote")
    .argument("<symbol>", "Yahoo Finance symbol, such as AAPL or 0700.HK")
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(async (symbol: string, options: JsonOption) => {
        const request = financeQuoteRequestSchema.safeParse({ symbol });
        if (!request.success) {
          throw new InvalidArgumentError(firstIssueMessage(request));
        }
        await printDataRouterTool("finance_quote", request.data, options.json);
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
    .option("--json", "Print compact JSON")
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
        await printDataRouterTool("finance_chart", request.data, options.json);
      }),
    );

  const financeCommand = new Command()
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
  Search instruments:  okou data finance search "Tencent"
  Company profile:     okou data finance profile AAPL
  Latest quote:        okou data finance quote 0700.HK --json
  Historical chart:   okou data finance chart AAPL --range 1y --interval 1d

Notes:
  - Authenticates via OKOU_TOKEN (requires finance:read capability) or a CLI token
  - Data Router determines final credits using its current pricing
  - Source freshness and coverage depend on the provider selected by Data Router`,
    );
  return financeCommand;
}
