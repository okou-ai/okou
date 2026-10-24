import { printDataRouterTool } from "../data/print-result";
import { mapsSearchRequestSchema } from "@okouai/api-contracts/contracts/maps";
import { Command, InvalidArgumentError } from "commander";
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
  .option("--json", "Print compact JSON")
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

        await printDataRouterTool("maps_search", request.data, options.json);
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
  Find nearby places:  okou data maps search "quiet coffee shops near Union Square, San Francisco"
  Plan a route:        okou data maps search "How do I get from SFO to Mountain View by transit?"
  Explicit location:   okou data maps search "best espresso near me" --lat 40.7128 --lng -74.0060
  Localized results:   okou data maps search "family restaurants in Paris" --language fr_FR --json

Notes:
  - Authenticates via OKOU_TOKEN (requires maps:read capability) or a CLI token
  - Search uses Gemini with Google Maps grounding through Okou's managed Google Cloud identity
  - No location is inferred from server IP or headers; use --lat and --lng only when the user supplied them
  - Output is the unchanged Router JSON, including its answer and Google Maps sources
  - Queries are sent to Google; never include secrets or private internal context`,
  );
