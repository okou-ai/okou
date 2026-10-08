import {
  PEOPLE_SEARCH_DEFAULT_LIMIT,
  PEOPLE_SEARCH_MAX_LIMIT,
  peopleSearchRequestSchema,
} from "@okouai/api-contracts/contracts/people-search";
import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";

import { callPeopleSearch } from "../../lib/api/domains/people-search";
import type { PeopleSearchResponse } from "@okouai/api-contracts/contracts/people-search";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface PeopleSearchOptions {
  readonly limit: number;
  readonly json?: boolean;
}

function parseLimit(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      `limit must be an integer from 1 to ${PEOPLE_SEARCH_MAX_LIMIT}`,
    );
  }
  const limit = Number(value);
  if (limit < 1 || limit > PEOPLE_SEARCH_MAX_LIMIT) {
    throw new InvalidArgumentError(
      `limit must be an integer from 1 to ${PEOPLE_SEARCH_MAX_LIMIT}`,
    );
  }
  return limit;
}

function renderMetadata(response: PeopleSearchResponse): void {
  console.log(chalk.dim(`  Provider: ${response.provider}`));
  console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  console.log(
    chalk.dim(
      `  Credits charged: ${response.creditsCharged === null ? "pending" : response.creditsCharged}`,
    ),
  );
}

function renderProfile(
  profile: PeopleSearchResponse["profiles"][number],
  index: number,
): void {
  console.log(`${index + 1}. ${profile.name}`);
  if (profile.title) {
    console.log(`   Title: ${profile.title}`);
  }
  if (profile.company) {
    console.log(`   Company: ${profile.company}`);
  }
  if (profile.location) {
    console.log(`   Location: ${profile.location}`);
  }
  if (profile.summary) {
    console.log(`   ${profile.summary}`);
  }
  console.log("   Sources:");
  for (const [sourceIndex, source] of profile.sources.entries()) {
    console.log(
      `     ${sourceIndex + 1}. ${source.title || "(untitled source)"}`,
    );
    console.log(`        ${source.url}`);
  }
}

function renderProfiles(response: PeopleSearchResponse): void {
  if (response.profiles.length === 0) {
    console.log(
      chalk.dim(
        "No matching professionals found. Try a broader role, company, skill, or location query.",
      ),
    );
    return;
  }
  for (const [index, profile] of response.profiles.entries()) {
    renderProfile(profile, index);
  }
}

export const peopleSearchCommand = new Command()
  .name("people-search")
  .description("Find professionals through managed Okou people search")
  .argument("<query>", "Professional research query")
  .addOption(
    new Option(
      "--limit <count>",
      `Maximum profiles (1-${PEOPLE_SEARCH_MAX_LIMIT})`,
    )
      .default(PEOPLE_SEARCH_DEFAULT_LIMIT)
      .argParser(parseLimit),
  )
  .option("--json", "Print the raw people-search response as JSON")
  .action(
    withErrorHandler(async (query: string, options: PeopleSearchOptions) => {
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
      const response = await callPeopleSearch(request.data);
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      console.log(chalk.green("✓ People search completed"));
      renderMetadata(response);
      renderProfiles(response);
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Find a professional: okou people-search "Who leads platform engineering at Notion?"
  Search by criteria: okou people-search "Fintech compliance leaders in New York" --limit 10
  Machine-readable:   okou people-search "Kubernetes platform engineers" --json

Notes:
  - Authenticates via OKOU_TOKEN (requires people-search:read capability) or a CLI token
  - Successful requests use managed credits, including searches with no matches
  - Queries are sent to Okou's managed Perplexity provider; never include secrets or private context
  - Profile fields are model-extracted from public professional sources and are not verified facts
  - Verify important claims using the provider-backed source URLs shown with each profile
  - Use only for legitimate professional research; never for harassment, doxxing, stalking, unauthorized background screening, or unlawful employment/privacy decisions
  - This command does not enrich email/phone data, message people, scrape profiles, or access authenticated LinkedIn`,
  );
