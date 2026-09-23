import {
  mapsSearchRequestSchema,
  type MapsSearchResponse,
} from "@okouai/api-contracts/contracts/maps";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { callMapsSearch } from "../../lib/api/domains/maps";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface MapsSearchOptions {
  readonly lat?: number;
  readonly lng?: number;
  readonly language?: string;
  readonly json?: boolean;
}

function parseLatitude(value: string): number {
  const latitude = Number(value);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new InvalidArgumentError("latitude must be a number from -90 to 90");
  }
  return latitude;
}

function parseLongitude(value: string): number {
  const longitude = Number(value);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new InvalidArgumentError(
      "longitude must be a number from -180 to 180",
    );
  }
  return longitude;
}

function renderSources(response: MapsSearchResponse): void {
  if (response.sources.length === 0) {
    console.log(chalk.dim("No Google Maps sources were returned."));
    return;
  }

  console.log(chalk.bold("Google Maps sources:"));
  for (const [index, source] of response.sources.entries()) {
    console.log(`${index + 1}. ${source.title}`);
    console.log(`   ${source.uri}`);
  }
}

function renderMetadata(response: MapsSearchResponse): void {
  console.log(chalk.dim(`  Provider: ${response.provider}`));
  console.log(chalk.dim(`  Model: ${response.model}`));
  console.log(chalk.dim(`  Billing category: ${response.billingCategory}`));
  console.log(chalk.dim(`  Billing quantity: ${response.billingQuantity}`));
  console.log(
    chalk.dim(`  Provider cost: $${response.providerCostUsd.toFixed(6)}`),
  );
  console.log(chalk.dim(`  Credits charged: ${response.creditsCharged}`));
}

const searchCommand = new Command()
  .name("search")
  .description("Search places and routes with Google Maps grounding")
  .argument("<query>", "Conversational map question")
  .option("--lat <number>", "Explicit user-provided latitude", parseLatitude)
  .option("--lng <number>", "Explicit user-provided longitude", parseLongitude)
  .option(
    "--language <code>",
    "Optional Maps result language, such as en or en_US",
  )
  .option("--json", "Print the raw grounded maps response as JSON")
  .action(
    withErrorHandler(
      async (query: string, options: MapsSearchOptions): Promise<void> => {
        if ((options.lat === undefined) !== (options.lng === undefined)) {
          throw new InvalidArgumentError(
            "--lat and --lng must be provided together",
          );
        }
        const request = mapsSearchRequestSchema.safeParse({
          query,
          ...(options.lat !== undefined && options.lng !== undefined
            ? {
                location: {
                  latitude: options.lat,
                  longitude: options.lng,
                },
              }
            : {}),
          ...(options.language ? { languageCode: options.language } : {}),
        });
        if (!request.success) {
          throw new InvalidArgumentError(
            request.error.issues[0]?.message ??
              "maps search request is invalid",
          );
        }

        const response = await callMapsSearch(request.data);
        if (options.json) {
          console.log(JSON.stringify(response));
          return;
        }

        console.log(chalk.green("✓ Maps search completed"));
        console.log(response.answer);
        // Grounded content and its required attribution stay adjacent.
        renderSources(response);
        renderMetadata(response);
      },
    ),
  );

export const mapsCommand = new Command()
  .name("maps")
  .description("Search places and routes with Google Maps grounding")
  .addCommand(searchCommand)
  .addHelpText(
    "after",
    `
Examples:
  Find nearby places:  okou maps search "quiet coffee shops near Union Square, San Francisco"
  Plan a route:        okou maps search "How do I get from SFO to Mountain View by transit?"
  Explicit location:   okou maps search "best espresso near me" --lat 40.7128 --lng -74.0060
  Localized results:   okou maps search "family restaurants in Paris" --language fr_FR --json

Notes:
  - Authenticates via OKOU_TOKEN (requires maps:read capability) or a CLI token
  - Search uses Gemini with Google Maps grounding through Okou's managed Google Cloud identity
  - No location is inferred from server IP or headers; use --lat and --lng only when the user supplied them
  - Human-readable output keeps the grounded answer and its Google Maps sources together
  - Queries are sent to Google; never include secrets or private internal context`,
  );
