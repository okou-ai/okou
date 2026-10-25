import { Command } from "commander";

import { commerceCommand } from "../commerce";
import { createFinanceCommand } from "../finance";
import { mapsCommand } from "../maps";
import { createPeopleSearchCommand } from "../people-search";
import { scrapeCommand } from "../scrape";
import { seoCommand } from "../seo";
import { socialCommand } from "../social";
import { weatherCommand } from "../weather";
import { webSearchCommand } from "../web-search";
import { registerDataSearchCommands } from "./query";

import { isPaidToolEnabled } from "../../lib/command/paid-tools";

function createWebResearchCommand(
  searchEnabled: boolean,
  scrapeEnabled: boolean,
): Command {
  const webCommand = new Command("web").description(
    `${searchEnabled ? "Search" : ""}${searchEnabled && scrapeEnabled ? " and " : ""}${scrapeEnabled ? "extract" : ""} public web sources`,
  );
  if (searchEnabled) webCommand.addCommand(webSearchCommand);
  if (scrapeEnabled) webCommand.addCommand(scrapeCommand);
  return webCommand;
}

export function createDataCommand(): Command {
  const dataEnabled = isPaidToolEnabled("data-search");
  const searchEnabled = isPaidToolEnabled("web-search");
  const scrapeEnabled = isPaidToolEnabled("scrape");
  const peopleEnabled = isPaidToolEnabled("people-search");
  const webCommand = createWebResearchCommand(searchEnabled, scrapeEnabled);

  const peopleCommand = new Command("people").description(
    `${peopleEnabled ? "Research professionals" : ""}${peopleEnabled && dataEnabled ? " and " : ""}${dataEnabled ? "enrich business profiles" : ""}`,
  );
  if (peopleEnabled) peopleCommand.addCommand(createPeopleSearchCommand());

  const command = new Command("data").description(
    "Search and retrieve managed research data",
  );
  if (peopleCommand.commands.length > 0 || dataEnabled)
    command.addCommand(peopleCommand);
  if (webCommand.commands.length > 0) command.addCommand(webCommand);
  if (isPaidToolEnabled("social")) command.addCommand(socialCommand);
  if (isPaidToolEnabled("finance")) command.addCommand(createFinanceCommand());
  if (isPaidToolEnabled("maps")) command.addCommand(mapsCommand);
  command.addCommand(weatherCommand);
  if (isPaidToolEnabled("seo")) command.addCommand(seoCommand);
  command.addCommand(commerceCommand);
  const examples = [
    ...(searchEnabled
      ? [
          '  Search the web:       okou data web search "small business AI tools" --json',
        ]
      : []),
    ...(scrapeEnabled
      ? [
          "  Extract a page:       okou data web scrape https://example.com --json",
        ]
      : []),
    ...(peopleEnabled
      ? [
          '  Find professionals:   okou data people search "marketing leaders in London" --json',
        ]
      : []),
    ...(isPaidToolEnabled("social")
      ? ["  Research social:      okou data social --help"]
      : []),
    ...(dataEnabled
      ? ["  Discover operations:  okou data capabilities --json"]
      : []),
  ];
  command.addHelpText(
    "after",
    `\nExamples:\n${examples.join("\n")}

Managed requests can consume credits. Use each command's help for pricing, permissions, and source limitations.
Chat and session search remain under okou search. Web-chat file delivery remains under okou web upload-file and okou web download-file.`,
  );

  if (dataEnabled) registerDataSearchCommands(command);
  return command;
}
