import {
  DATA_ROUTER_TOOLS,
  type DataRouterToolName,
} from "@okouai/api-contracts/contracts/data-router-tools";
import { Command, Help, InvalidArgumentError } from "commander";
import { z } from "zod";

import { printDataRouterTool } from "./print-result";
import { isDataRouterToolEnabled } from "../../lib/command/paid-tools";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function toolName(value: string): DataRouterToolName {
  const tool = DATA_ROUTER_TOOLS.find((entry) => {
    return entry.name === value;
  });
  if (!tool) {
    throw new InvalidArgumentError(
      `Unknown Data tool: ${value}. Use okou data tools --json to inspect the local catalog.`,
    );
  }
  return tool.name;
}

function inputObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError("--input must contain a JSON object");
  }
  const result = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!result.success)
    throw new InvalidArgumentError("--input must contain a JSON object");
  return result.data;
}

export function registerRouterCommands(parent: Command): void {
  parent
    .command("tools")
    .description("List enabled Data Router tools from the local catalog")
    .option("--json", "Print compact JSON")
    .action((options: { json?: boolean }) => {
      console.log(
        JSON.stringify(
          {
            tools: DATA_ROUTER_TOOLS.filter((tool) => {
              return isDataRouterToolEnabled(tool.name);
            }),
          },
          null,
          options.json ? undefined : 2,
        ),
      );
    });
  parent
    .command("call")
    .description("Call a known Data Router tool directly")
    .argument("<tool>", "Static Data Router tool name", toolName)
    .requiredOption(
      "--input <json>",
      "Tool input as a JSON object",
      inputObject,
    )
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(
        async (
          name: DataRouterToolName,
          options: { input: Record<string, unknown>; json?: boolean },
        ) => {
          // Settings filter discovery; an explicit known-tool call is allowed.
          await printDataRouterTool(name, options.input, options.json);
        },
      ),
    );
}

const commandTools: Readonly<Record<string, readonly DataRouterToolName[]>> = {
  "web search": ["web_search"],
  "web scrape": ["web_scrape"],
  "people search": ["people_search"],
  "finance search": ["finance_search"],
  "finance profile": ["finance_profile"],
  "finance quote": ["finance_quote"],
  "finance chart": ["finance_chart"],
  "maps search": ["maps_search"],
  "weather current": ["weather_current"],
  "weather forecast hourly": ["weather_forecast_hourly"],
  "weather forecast daily": ["weather_forecast_daily"],
  "weather history hourly": ["weather_history_hourly"],
  "weather air-quality current": ["weather_air_quality_current"],
  "seo serp": ["seo_serp"],
  "seo keyword-ideas": ["seo_keyword_ideas"],
  "seo ranked-keywords": ["seo_ranked_keywords"],
  "seo backlinks-summary": ["seo_backlinks_summary"],
  "commerce search": ["commerce_search"],
  "commerce inspect": ["commerce_inspect"],
  "commerce job": ["commerce_get"],
  capabilities: ["data_capabilities"],
  discover: ["data_capabilities"],
  "jobs list": ["data_list"],
  "jobs get": ["data_get"],
  "jobs cancel": ["data_cancel"],
  "social status": ["social_status"],
  "social jobs list": ["social_data_list"],
  "social jobs get": ["social_data_get"],
  "social jobs cancel": ["social_data_cancel"],
  "social jobs continue": ["social_data_continue"],
  "social downloads": ["social_download_list"],
  "social download": ["social_download_create", "social_download_get"],
  "social replies": ["social_data_create"],
  "social followers": ["social_data_create"],
  "social following": ["social_data_create"],
};

const dataJobCommands = new Set([
  "people enrich",
  "company search",
  "company inspect",
  "traffic overview",
  "ads search",
  "trends related",
  "creators search",
  "web history",
  "affiliate search",
  "apps profile",
  "podcasts search",
  "finance company-profile",
]);

const socialOperations: Readonly<Record<string, readonly string[]>> = {
  inspect: ["_profile", "_company", "_post", "_stats", "_tweet", "_thread"],
  posts: ["_posts", "_reels", "_videos", "_tweets"],
  search: ["_search"],
  comments: ["_comments"],
  transcript: ["_transcript"],
  summarize: ["_summarize"],
};

function visible(path: readonly string[], command: Command): boolean {
  if (command.commands.length > 0) {
    return command.commands.some((child) => {
      return visible([...path, child.name()], child);
    });
  }
  const key = path.join(" ");
  const names = commandTools[key];
  if (names) return names.some(isDataRouterToolEnabled);
  if (dataJobCommands.has(key)) return isDataRouterToolEnabled("data_create");
  if (path[0] === "social") {
    const suffixes = socialOperations[path[1] ?? ""];
    const tools = DATA_ROUTER_TOOLS.filter((tool) => {
      if (tool.family !== "social") return false;
      return (
        !suffixes ||
        tool.name === "social_data_create" ||
        suffixes.some((suffix) => {
          return tool.name.endsWith(suffix);
        })
      );
    });
    return tools.some((tool) => {
      return isDataRouterToolEnabled(tool.name);
    });
  }
  return true;
}

/** Hide disabled tool entry points in help without rejecting explicit calls. */
export function filterRouterCommandHelp(
  command: Command,
  path: readonly string[] = [],
): void {
  command.configureHelp({
    visibleCommands(parent) {
      return Help.prototype.visibleCommands
        .call(this, parent)
        .filter((child) => {
          return visible([...path, child.name()], child);
        });
    },
  });
  for (const child of command.commands) {
    filterRouterCommandHelp(child, [...path, child.name()]);
  }
}
