import { Command } from "commander";

import { commerceCommand } from "../commerce";
import { financeCommand } from "../finance";
import { mapsCommand } from "../maps";
import { peopleSearchCommand } from "../people-search";
import { scrapeCommand } from "../scrape";
import { seoCommand } from "../seo";
import { socialCommand } from "../social";
import { weatherCommand } from "../weather";
import { webSearchCommand } from "../web-search";
import { registerDataSearchCommands } from "./query";

const webCommand = new Command("web")
  .description("Search and extract public web sources")
  .addCommand(webSearchCommand)
  .addCommand(scrapeCommand);

const peopleCommand = new Command("people")
  .description("Research professionals and enrich business profiles")
  .addCommand(peopleSearchCommand);

export const dataCommand = new Command("data")
  .description("Search and retrieve managed research data")
  .addCommand(peopleCommand)
  .addCommand(webCommand)
  .addCommand(socialCommand)
  .addCommand(financeCommand)
  .addCommand(mapsCommand)
  .addCommand(weatherCommand)
  .addCommand(seoCommand)
  .addCommand(commerceCommand)
  .addHelpText(
    "after",
    `
Examples:
  Search the web:       okou data web search "small business AI tools" --json
  Extract a page:       okou data web scrape https://example.com --json
  Find professionals:   okou data people search "marketing leaders in London" --json
  Research social:      okou data social --help
  Discover operations:  okou data capabilities --json

Managed requests can consume credits. Use each command's help for pricing, permissions, and source limitations.
Chat and session search remain under okou search. Web-chat file delivery remains under okou web upload-file and okou web download-file.`,
  );

registerDataSearchCommands(dataCommand);
