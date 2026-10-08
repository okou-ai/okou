import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import {
  scrapeFormatSchema,
  scrapeModeSchema,
  type ScrapeResponse,
  type ScrapeFormat,
  type ScrapeMode,
} from "@okouai/api-contracts/contracts/scrape";

import { callScrape } from "../../lib/api/domains/scrape";
import { withErrorHandler } from "../../lib/command/with-error-handler";

const SCRAPE_FORMATS = scrapeFormatSchema.options;
const SCRAPE_MODES = scrapeModeSchema.options;

interface ScrapeOptions {
  readonly format: ScrapeFormat;
  readonly mode: ScrapeMode;
  readonly json?: boolean;
}

function parseFormat(value: string): ScrapeFormat {
  const result = scrapeFormatSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `format must be one of: ${SCRAPE_FORMATS.join(", ")}`,
  );
}

function parseMode(value: string): ScrapeMode {
  const result = scrapeModeSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `mode must be one of: ${SCRAPE_MODES.join(", ")}`,
  );
}

function renderScrapeMetadata(response: ScrapeResponse): void {
  console.log(chalk.dim(`  Provider: ${response.provider}`));
  console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  console.log(
    chalk.dim(
      `  Credits charged: ${response.creditsCharged === null ? "pending" : response.creditsCharged}`,
    ),
  );
}

function renderScrapeResult(response: ScrapeResponse): void {
  if (response.format === "links") {
    for (const link of response.result.links) {
      console.log(link);
    }
    return;
  }

  const markdown = response.result.markdown;
  if (markdown) {
    console.log(markdown);
  }
}

export const scrapeCommand = new Command()
  .name("scrape")
  .description("Scrape a public web page through managed Okou scrape")
  .argument("<url>", "Public http or https URL to scrape")
  .addOption(
    new Option("--format <format>", "Output format")
      .default("markdown")
      .argParser(parseFormat),
  )
  .addOption(
    new Option("--mode <mode>", "Scrape mode")
      .default("standard")
      .argParser(parseMode),
  )
  .option("--json", "Print the raw scrape response as JSON")
  .action(
    withErrorHandler(async (url: string, options: ScrapeOptions) => {
      const response = await callScrape({
        url,
        format: options.format,
        mode: options.mode,
      });

      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }

      console.log(chalk.green("✓ Scrape completed"));
      renderScrapeMetadata(response);
      renderScrapeResult(response);
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Scrape markdown:  okou scrape https://example.com --format markdown
  Scrape links:     okou scrape https://example.com --format links
  Enhanced scrape:  okou scrape https://example.com --mode enhanced --json

Notes:
  - Authenticates via OKOU_TOKEN (requires scrape:read capability) or a CLI token
  - Firecrawl calls and credit billing happen on the Okou API server
  - Enhanced mode is explicit because it uses a higher billing category`,
  );
