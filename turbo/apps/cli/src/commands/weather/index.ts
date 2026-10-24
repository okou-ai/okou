import { printDataRouterTool } from "../data/print-result";
import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";

const WEATHER_UNITS = ["metric", "imperial"] as const;
const WEATHER_LANGUAGE_CODE = "en";

type WeatherUnits = (typeof WEATHER_UNITS)[number];

interface JsonOption {
  readonly json?: boolean;
}

interface CoordinateOptions extends JsonOption {
  readonly lat: number;
  readonly lng: number;
}

interface LocationOptions extends CoordinateOptions {
  readonly units: WeatherUnits;
}

interface PagedOptions extends LocationOptions {
  readonly pageSize?: number;
  readonly pageToken?: string;
}

interface HourlyForecastOptions extends PagedOptions {
  readonly hours?: number;
}

interface DailyForecastOptions extends PagedOptions {
  readonly days?: number;
}

interface HourlyHistoryOptions extends PagedOptions {
  readonly hours?: number;
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

function parseIntegerInRange(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidArgumentError(
      `value must be an integer from ${min} to ${max}`,
    );
  }
  return parsed;
}

function parseWeatherUnits(value: string): WeatherUnits {
  if (WEATHER_UNITS.includes(value as WeatherUnits)) {
    return value as WeatherUnits;
  }
  throw new InvalidArgumentError(
    `units must be one of: ${WEATHER_UNITS.join(", ")}`,
  );
}

function coordinatePayload(
  options: CoordinateOptions,
): Record<string, unknown> {
  return {
    lat: options.lat,
    lng: options.lng,
    languageCode: WEATHER_LANGUAGE_CODE,
  };
}

function locationPayload(options: LocationOptions): Record<string, unknown> {
  return {
    ...coordinatePayload(options),
    units: options.units,
  };
}

function pagedPayload(options: PagedOptions): Record<string, unknown> {
  return {
    ...locationPayload(options),
    pageSize: options.pageSize,
    pageToken: options.pageToken,
  };
}

async function runWeatherRequest(
  endpoint: string,
  payload: Record<string, unknown>,
  options: JsonOption,
): Promise<void> {
  await printDataRouterTool(
    `weather_${endpoint.replaceAll("/", "_").replaceAll("-", "_")}`,
    payload,
    options.json,
  );
}

function addCoordinateOptions(command: Command): Command {
  return command
    .requiredOption("--lat <number>", "Latitude", parseLatitude)
    .requiredOption("--lng <number>", "Longitude", parseLongitude)
    .option("--json", "Print compact JSON");
}

function addLocationOptions(command: Command): Command {
  return addCoordinateOptions(command).option(
    "--units <system>",
    "Units system: metric or imperial",
    parseWeatherUnits,
    "metric",
  );
}

function addHourlyPaginationOptions(command: Command): Command {
  return command
    .option("--page-size <n>", "Records per page, from 1 to 24", (value) => {
      return parseIntegerInRange(value, 1, 24);
    })
    .option("--page-token <token>", "Token for the next page");
}

const currentCommand = addLocationOptions(
  new Command().name("current").description("Get current weather conditions"),
).action(
  withErrorHandler(async (options: LocationOptions) => {
    await runWeatherRequest("current", locationPayload(options), options);
  }),
);

const hourlyForecastCommand = addHourlyPaginationOptions(
  addLocationOptions(
    new Command()
      .name("hourly")
      .description("Get up to 240 hours of hourly forecasts"),
  ),
)
  .option("--hours <n>", "Total forecast hours, from 1 to 240", (value) => {
    return parseIntegerInRange(value, 1, 240);
  })
  .action(
    withErrorHandler(async (options: HourlyForecastOptions) => {
      await runWeatherRequest(
        "forecast/hourly",
        { ...pagedPayload(options), hours: options.hours },
        options,
      );
    }),
  );

const dailyForecastCommand = addLocationOptions(
  new Command()
    .name("daily")
    .description("Get up to 10 days of daily forecasts"),
)
  .option("--days <n>", "Total forecast days, from 1 to 10", (value) => {
    return parseIntegerInRange(value, 1, 10);
  })
  .option("--page-size <n>", "Records per page, from 1 to 10", (value) => {
    return parseIntegerInRange(value, 1, 10);
  })
  .option("--page-token <token>", "Token for the next page")
  .action(
    withErrorHandler(async (options: DailyForecastOptions) => {
      await runWeatherRequest(
        "forecast/daily",
        { ...pagedPayload(options), days: options.days },
        options,
      );
    }),
  );

const hourlyHistoryCommand = addHourlyPaginationOptions(
  addLocationOptions(
    new Command()
      .name("hourly")
      .description("Get up to 24 hours of recent hourly history"),
  ),
)
  .option("--hours <n>", "Total history hours, from 1 to 24", (value) => {
    return parseIntegerInRange(value, 1, 24);
  })
  .action(
    withErrorHandler(async (options: HourlyHistoryOptions) => {
      await runWeatherRequest(
        "history/hourly",
        { ...pagedPayload(options), hours: options.hours },
        options,
      );
    }),
  );

const airQualityCurrentCommand = addCoordinateOptions(
  new Command().name("current").description("Get current air quality"),
).action(
  withErrorHandler(async (options: CoordinateOptions) => {
    await runWeatherRequest(
      "air-quality/current",
      coordinatePayload(options),
      options,
    );
  }),
);

const forecastCommand = new Command()
  .name("forecast")
  .description("Get hourly or daily weather forecasts")
  .addCommand(hourlyForecastCommand)
  .addCommand(dailyForecastCommand);

const historyCommand = new Command()
  .name("history")
  .description("Get recent weather history")
  .addCommand(hourlyHistoryCommand);

const airQualityCommand = new Command()
  .name("air-quality")
  .description("Get current air quality")
  .addCommand(airQualityCurrentCommand);

export const weatherCommand = new Command()
  .name("weather")
  .description("Use managed Okou weather and air quality services")
  .addCommand(currentCommand)
  .addCommand(forecastCommand)
  .addCommand(historyCommand)
  .addCommand(airQualityCommand)
  .addHelpText(
    "after",
    `
Examples:
  Current conditions:  okou data weather current --lat 39.9042 --lng 116.4074 --json
  Hourly forecast:     okou data weather forecast hourly --lat 39.9042 --lng 116.4074 --hours 48 --page-size 24 --json
  Daily forecast:      okou data weather forecast daily --lat 39.9042 --lng 116.4074 --days 10 --page-size 10 --json
  Hourly history:      okou data weather history hourly --lat 39.9042 --lng 116.4074 --hours 24 --json
  Current air quality: okou data weather air-quality current --lat 39.9042 --lng 116.4074 --json

Notes:
  - Authenticates via OKOU_TOKEN (requires weather:read capability) or a CLI token
  - Each command submits one request to Data Router; use page tokens for additional weather pages
  - Data Router determines final credits using its current pricing`,
  );
