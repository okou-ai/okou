import { printDataRouterTool } from "../data/print-result";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  scrapeFormatSchema,
  scrapeModeSchema,
  type ScrapeFormat,
  type ScrapeMode,
} from "@okouai/api-contracts/contracts/scrape";
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
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (url: string, options: ScrapeOptions) => {
      await printDataRouterTool(
        "web_scrape",
        {
          url,
          format: options.format,
          mode: options.mode,
        },
        options.json,
      );
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Scrape markdown:  okou data web scrape https://example.com --format markdown
  Scrape links:     okou data web scrape https://example.com --format links
  Enhanced scrape:  okou data web scrape https://example.com --mode enhanced --json

Notes:
  - Authenticates via OKOU_TOKEN (requires scrape:read capability) or a CLI token
  - Data Router calls Firecrawl and determines final credits; Okou settles the charge
  - Enhanced mode is explicit because it uses a higher billing category`,
  );
