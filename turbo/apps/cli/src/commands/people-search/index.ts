import { printDataRouterTool } from "../data/print-result";
import {
  PEOPLE_SEARCH_DEFAULT_LIMIT,
  PEOPLE_SEARCH_MAX_LIMIT,
  peopleSearchRequestSchema,
} from "@okouai/api-contracts/contracts/people-search";
import { Command, InvalidArgumentError, Option } from "commander";
import { isPaidToolEnabled } from "../../lib/command/paid-tools";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  addDataProspectOptions,
  runDataProspect,
  usesDataProspect,
  type DataProspectOptions,
} from "../data/query";

const MAX_PROSPECT_LIMIT = 100;

interface PeopleSearchOptions extends DataProspectOptions {
  readonly limit: number;
  readonly json?: boolean;
}

function parseLimit(value: string, prospectEnabled: boolean): number {
  const limit = Number(value);
  const maximum = prospectEnabled
    ? MAX_PROSPECT_LIMIT
    : PEOPLE_SEARCH_MAX_LIMIT;
  if (!/^\d+$/.test(value) || limit < 1 || limit > maximum) {
    throw new InvalidArgumentError(
      `limit must be an integer from 1 to ${maximum}${prospectEnabled ? ` (research maximum: ${PEOPLE_SEARCH_MAX_LIMIT})` : ""}`,
    );
  }
  return limit;
}

export function createPeopleSearchCommand(): Command {
  const prospectEnabled = isPaidToolEnabled("data-search");
  const peopleSearchCommand = new Command()
    .name("search")
    .description("Find professionals through managed Okou people search")
    .argument(
      "[query]",
      prospectEnabled
        ? "Research query (optional with structured prospect filters)"
        : "Research query",
    )
    .addOption(
      new Option(
        "--limit <count>",
        prospectEnabled
          ? `Maximum profiles (research: 1-${PEOPLE_SEARCH_MAX_LIMIT}; prospect: 1-${MAX_PROSPECT_LIMIT})`
          : `Maximum profiles (1-${PEOPLE_SEARCH_MAX_LIMIT})`,
      )
        .default(PEOPLE_SEARCH_DEFAULT_LIMIT)
        .argParser((value) => {
          return parseLimit(value, prospectEnabled);
        }),
    )
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(
        async (
          query: string | undefined,
          options: PeopleSearchOptions,
          command: Command,
        ) => {
          if (usesDataProspect(options)) {
            await runDataProspect(query, options);
            return;
          }
          for (const option of command.options) {
            const name = option.attributeName();
            if (
              !["backend", "limit", "json"].includes(name) &&
              command.getOptionValueSource(name) === "cli"
            ) {
              throw new InvalidArgumentError(
                `${option.long} requires --backend prospect`,
              );
            }
          }
          const request = peopleSearchRequestSchema.safeParse({
            query,
            limit: options.limit,
          });
          if (!request.success) {
            throw new InvalidArgumentError(
              request.error.issues[0]?.message ??
                "people-search request is invalid",
            );
          }
          await printDataRouterTool(
            "people_search",
            request.data,
            options.json,
          );
        },
      ),
    )
    .addHelpText(
      "after",
      `
Examples:
  Find a professional: okou data people search "Who leads platform engineering at Notion?"
  Search by criteria: okou data people search "Fintech compliance leaders in New York" --limit 10
  Machine-readable:   okou data people search "Kubernetes platform engineers" --json${prospectEnabled ? '\n  Structured filters: okou data people search --backend prospect --titles "Head of Marketing" --company-domains example.com --dry-run --json' : ""}

Notes:
  - Authenticates via OKOU_TOKEN (requires people-search:read capability) or a CLI token
  - Successful requests use managed credits, including searches with no matches
  - Queries are sent to external providers through Data Router; never include secrets or private context
  - Profile fields are model-extracted from public professional sources and are not verified facts
  - Verify important claims using the provider-backed source URLs shown with each profile
  - Use only for legitimate professional research; never for harassment, doxxing, stalking, unauthorized background screening, or unlawful employment/privacy decisions
  - The default research backend does not enrich email/phone data, message people, scrape profiles, or access authenticated LinkedIn${prospectEnabled ? "\n  - Use --backend prospect for structured business prospect search; see its filter and saved-job options below" : ""}`,
    );

  if (prospectEnabled) addDataProspectOptions(peopleSearchCommand);
  return peopleSearchCommand;
}
