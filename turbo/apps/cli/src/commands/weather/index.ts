import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import {
  callWeather,
  type WeatherResponse,
} from "../../lib/api/domains/weather";
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

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function arrayField(
  value: unknown,
  key: string,
): readonly unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function formatTemperature(value: unknown): string | undefined {
  const degrees = numberField(value, "degrees");
  if (degrees === undefined) {
    return undefined;
  }
  const unit = stringField(value, "unit");
  const suffix = unit === "FAHRENHEIT" ? "°F" : "°C";
  return `${formatNumber(degrees)}${suffix}`;
}

function temperatureSuffix(value: unknown): string {
  return stringField(value, "unit") === "FAHRENHEIT" ? "°F" : "°C";
}

function formatTemperatureRange(
  minimum: unknown,
  maximum: unknown,
): string | undefined {
  const minimumText = formatTemperature(minimum);
  const maximumText = formatTemperature(maximum);
  const minimumDegrees = numberField(minimum, "degrees");
  const maximumDegrees = numberField(maximum, "degrees");
  if (
    minimumDegrees !== undefined &&
    maximumDegrees !== undefined &&
    temperatureSuffix(minimum) === temperatureSuffix(maximum)
  ) {
    return `${formatNumber(minimumDegrees)}–${formatNumber(maximumDegrees)}${temperatureSuffix(minimum)}`;
  }
  if (minimumText && maximumText) {
    return `${minimumText}–${maximumText}`;
  }
  return minimumText ?? maximumText;
}

function formatCardinalDirection(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const abbreviations: Record<string, string> = {
    NORTH: "N",
    NORTHEAST: "NE",
    EAST: "E",
    SOUTHEAST: "SE",
    SOUTH: "S",
    SOUTHWEST: "SW",
    WEST: "W",
    NORTHWEST: "NW",
  };
  return value
    .split("_")
    .map((part) => {
      return abbreviations[part] ?? part;
    })
    .join("");
}

function formatSpeed(value: unknown): string | undefined {
  const speed = numberField(value, "value");
  if (speed === undefined) {
    return undefined;
  }
  const unit = stringField(value, "unit");
  const suffix =
    unit === "MILES_PER_HOUR"
      ? "mph"
      : unit === "METERS_PER_SECOND"
        ? "m/s"
        : "km/h";
  return `${formatNumber(speed)} ${suffix}`;
}

function formatWind(value: unknown): string | undefined {
  const direction = formatCardinalDirection(
    stringField(recordField(value, "direction"), "cardinal"),
  );
  const speed = formatSpeed(recordField(value, "speed"));
  const gust = formatSpeed(recordField(value, "gust"));
  const primary = [direction, speed].filter(Boolean).join(" ");
  if (!primary && !gust) {
    return undefined;
  }
  if (!gust) {
    return primary || undefined;
  }
  return `${primary || "Wind"}, gusts ${gust}`;
}

function formatCondition(value: unknown): string | undefined {
  const description = recordField(value, "description");
  return stringField(description, "text") ?? stringField(value, "text");
}

function formatProbability(value: unknown): string | undefined {
  const percent = numberField(recordField(value, "probability"), "percent");
  return percent === undefined ? undefined : `${formatNumber(percent)}%`;
}

function formatQuantity(value: unknown): string | undefined {
  const quantity = numberField(value, "quantity");
  if (quantity === undefined || quantity === 0) {
    return undefined;
  }
  const unit = stringField(value, "unit");
  return `${formatNumber(quantity)} ${unit === "MILLIMETERS" ? "mm" : (unit ?? "units")}`;
}

function formatTimeZone(value: unknown): string | undefined {
  return typeof value === "string" ? value : stringField(value, "id");
}

function formatDisplayDate(value: unknown): string | undefined {
  const year = numberField(value, "year");
  const month = numberField(value, "month");
  const day = numberField(value, "day");
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatDateTime(
  value: unknown,
  timeZone: string | undefined,
): string | undefined {
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  const year = numberField(value, "year");
  const month = numberField(value, "month");
  const day = numberField(value, "day");
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  const hour = numberField(value, "hours") ?? numberField(value, "hour") ?? 0;
  const minute =
    numberField(value, "minutes") ?? numberField(value, "minute") ?? 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatLocalTime(
  value: unknown,
  timeZone: string | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function renderSource(response: WeatherResponse): void {
  if (response.attribution) {
    console.log(chalk.dim(response.attribution));
  }
}

function renderCurrentConditions(result: JsonRecord): boolean {
  const timeZone = formatTimeZone(result.timeZone);
  console.log(`Current conditions${timeZone ? ` · ${timeZone}` : ""}`);

  const condition = formatCondition(result.weatherCondition);
  const temperature = formatTemperature(result.temperature);
  const feelsLike = formatTemperature(result.feelsLikeTemperature);
  const currentTime = formatDateTime(result.currentTime, timeZone);
  if (condition || temperature || feelsLike) {
    console.log(
      `  ${[
        condition,
        temperature,
        feelsLike ? `feels like ${feelsLike}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")}`,
    );
  }

  const details = [
    formatWind(result.wind),
    numberField(result, "relativeHumidity") !== undefined
      ? `humidity ${formatNumber(numberField(result, "relativeHumidity") ?? 0)}%`
      : undefined,
    numberField(result, "uvIndex") !== undefined
      ? `UV ${formatNumber(numberField(result, "uvIndex") ?? 0)}`
      : undefined,
    formatProbability(result.precipitation)
      ? `rain ${formatProbability(result.precipitation)}`
      : undefined,
  ].filter(Boolean);
  if (details.length > 0) {
    console.log(`  ${details.join(" · ")}`);
  }
  if (currentTime) {
    console.log(chalk.dim(`  Updated ${currentTime}`));
  }
  return Boolean(condition || temperature || feelsLike || details.length > 0);
}

function compactStrings(
  values: readonly (string | undefined)[],
): readonly string[] {
  return values.filter((value): value is string => {
    return value !== undefined;
  });
}

function formatLabeledTemperatureRange(
  label: string,
  minimum: unknown,
  maximum: unknown,
): string | undefined {
  const range = formatTemperatureRange(minimum, maximum);
  return range ? `${label}${range}` : undefined;
}

function formatDailyRainProbability(
  daytime: JsonRecord | undefined,
  nighttime: JsonRecord | undefined,
): string | undefined {
  const daytimeProbability = formatProbability(daytime?.precipitation);
  if (!daytimeProbability) {
    return undefined;
  }
  const nighttimeProbability = formatProbability(nighttime?.precipitation);
  return `rain ${daytimeProbability}${
    nighttimeProbability ? ` (night ${nighttimeProbability})` : ""
  }`;
}

function formatLabeledNumber(
  label: string,
  value: unknown,
  key: string,
  onlyWhenPositive = false,
): string | undefined {
  const number = numberField(value, key);
  if (number === undefined || (onlyWhenPositive && number <= 0)) {
    return undefined;
  }
  return `${label} ${formatNumber(number)}${label === "UV" ? "" : "%"}`;
}

function formatLabeledQuantity(
  label: string,
  value: unknown,
): string | undefined {
  const quantity = formatQuantity(value);
  return quantity ? `${label} ${quantity}` : undefined;
}

function renderDailyForecastDay(
  forecastDay: unknown,
  timeZone: string | undefined,
): void {
  const day = isRecord(forecastDay) ? forecastDay : {};
  const daytime = recordField(day, "daytimeForecast");
  const nighttime = recordField(day, "nighttimeForecast");
  const date = formatDisplayDate(day.displayDate) ?? "Forecast day";
  console.log(chalk.bold(`  ${date}`));

  const nighttimeCondition = formatCondition(
    recordField(nighttime, "weatherCondition"),
  );
  const conditions = compactStrings([
    formatCondition(recordField(daytime, "weatherCondition")),
    nighttimeCondition ? `${nighttimeCondition} overnight` : undefined,
  ]);
  if (conditions.length > 0) {
    console.log(`    ${conditions.join(" · ")}`);
  }

  const details = compactStrings([
    formatTemperatureRange(day.minTemperature, day.maxTemperature),
    formatLabeledTemperatureRange(
      "feels like ",
      day.feelsLikeMinTemperature,
      day.feelsLikeMaxTemperature,
    ),
    formatDailyRainProbability(daytime, nighttime),
    formatWind(daytime?.wind) ?? formatWind(nighttime?.wind),
    formatLabeledNumber("UV", daytime, "uvIndex"),
    formatLabeledNumber(
      "thunderstorms",
      daytime,
      "thunderstormProbability",
      true,
    ),
    formatLabeledQuantity(
      "snow",
      recordField(daytime?.precipitation, "snowQpf"),
    ),
    formatLabeledQuantity("ice", recordField(daytime, "iceThickness")),
  ]);
  if (details.length > 0) {
    console.log(`    ${details.join(" · ")}`);
  }

  const sunEvents = recordField(day, "sunEvents");
  const sunrise = formatLocalTime(
    stringField(sunEvents, "sunriseTime"),
    timeZone,
  );
  const sunset = formatLocalTime(
    stringField(sunEvents, "sunsetTime"),
    timeZone,
  );
  const sunDetails = compactStrings([
    sunrise ? `Sunrise ${sunrise}` : undefined,
    sunset ? `Sunset ${sunset}` : undefined,
  ]);
  if (sunDetails.length > 0) {
    console.log(chalk.dim(`    ${sunDetails.join(" · ")}`));
  }
}

function renderDailyForecast(result: JsonRecord): boolean {
  const forecastDays = arrayField(result, "forecastDays");
  if (!forecastDays) {
    return false;
  }
  const timeZone = formatTimeZone(result.timeZone);
  console.log(`Daily forecast${timeZone ? ` · ${timeZone}` : ""}`);
  if (forecastDays.length === 0) {
    console.log(chalk.dim("  No daily forecast data returned."));
    return true;
  }

  for (const forecastDay of forecastDays) {
    renderDailyForecastDay(forecastDay, timeZone);
  }
  return true;
}

function renderHourlyForecast(
  result: JsonRecord,
  key: "forecastHours" | "historyHours",
  title: string,
): boolean {
  const hours = arrayField(result, key);
  if (!hours) {
    return false;
  }
  const timeZone = formatTimeZone(result.timeZone);
  console.log(`${title}${timeZone ? ` · ${timeZone}` : ""}`);
  if (hours.length === 0) {
    console.log(
      chalk.dim(
        `  No ${key === "forecastHours" ? "forecast" : "history"} data returned.`,
      ),
    );
    return true;
  }

  for (const hour of hours) {
    const interval = recordField(hour, "interval");
    const timestamp =
      (isRecord(hour) ? hour.displayDateTime : undefined) ??
      stringField(interval, "startTime");
    const dateTime = formatDateTime(timestamp, timeZone) ?? "Unknown time";
    const details = [
      dateTime,
      formatCondition(recordField(hour, "weatherCondition")),
      formatTemperature(recordField(hour, "temperature")),
      formatProbability(recordField(hour, "precipitation"))
        ? `rain ${formatProbability(recordField(hour, "precipitation"))}`
        : undefined,
      formatWind(recordField(hour, "wind")),
    ].filter(Boolean);
    console.log(`  ${details.join(" · ")}`);
  }
  return true;
}

function formatConcentration(value: unknown): string | undefined {
  const concentration = numberField(value, "value");
  if (concentration === undefined) {
    return undefined;
  }
  const unit = stringField(value, "units");
  const suffix =
    unit === "MICROGRAMS_PER_CUBIC_METER"
      ? "µg/m³"
      : unit === "MILLIGRAMS_PER_CUBIC_METER"
        ? "mg/m³"
        : unit === "PARTS_PER_BILLION"
          ? "ppb"
          : unit === "PARTS_PER_MILLION"
            ? "ppm"
            : (unit ?? "units");
  return `${formatNumber(concentration)} ${suffix}`;
}

function renderAirQuality(result: JsonRecord): boolean {
  const indexes = arrayField(result, "indexes");
  const pollutants = arrayField(result, "pollutants");
  if (!indexes && !pollutants) {
    return false;
  }
  console.log("Current air quality");
  for (const index of indexes ?? []) {
    const label =
      stringField(index, "displayName") ?? stringField(index, "code") ?? "AQI";
    const aqi = numberField(index, "aqi");
    const category = stringField(index, "category");
    const value = aqi === undefined ? label : `${label}: ${formatNumber(aqi)}`;
    console.log(`  ${value}${category ? ` · ${category}` : ""}`);
  }
  for (const pollutant of pollutants ?? []) {
    const label =
      stringField(pollutant, "fullName") ??
      stringField(pollutant, "displayName") ??
      stringField(pollutant, "code");
    const concentration = formatConcentration(
      recordField(pollutant, "concentration"),
    );
    if (label || concentration) {
      console.log(`  ${[label, concentration].filter(Boolean).join(": ")}`);
    }
  }
  return true;
}

function renderReadableWeatherResult(
  operation: string | undefined,
  result: unknown,
): void {
  if (!isRecord(result)) {
    console.log(chalk.dim("No structured weather data returned."));
    return;
  }

  const rendered =
    operation === "current"
      ? renderCurrentConditions(result)
      : operation === "forecast.daily"
        ? renderDailyForecast(result)
        : operation === "forecast.hourly"
          ? renderHourlyForecast(result, "forecastHours", "Hourly forecast")
          : operation === "history.hourly"
            ? renderHourlyForecast(result, "historyHours", "Hourly history")
            : operation === "air-quality.current"
              ? renderAirQuality(result)
              : false;

  if (!rendered) {
    console.log(chalk.dim("No readable weather fields were returned."));
  }
}

function renderWeatherResponse(label: string, response: WeatherResponse): void {
  console.log(chalk.green(`✓ ${label}`));
  renderReadableWeatherResult(response.operation, response.result);
  renderSource(response);
}

async function runWeatherRequest(
  label: string,
  endpoint:
    | "current"
    | "forecast/hourly"
    | "forecast/daily"
    | "history/hourly"
    | "air-quality/current",
  payload: Record<string, unknown>,
  options: JsonOption,
): Promise<void> {
  const response = await callWeather(endpoint, payload);
  if (options.json) {
    console.log(JSON.stringify(response));
    return;
  }
  renderWeatherResponse(label, response);
}

function addCoordinateOptions(command: Command): Command {
  return command
    .requiredOption("--lat <number>", "Latitude", parseLatitude)
    .requiredOption("--lng <number>", "Longitude", parseLongitude)
    .option("--json", "Print the raw response as JSON");
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
    await runWeatherRequest(
      "Current weather retrieved",
      "current",
      locationPayload(options),
      options,
    );
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
        "Hourly forecast retrieved",
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
        "Daily forecast retrieved",
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
        "Hourly weather history retrieved",
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
      "Current air quality retrieved",
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
  - Each command makes one Google Weather or Air Quality API request; use page tokens for additional weather pages
  - Data Router determines final credits using its current pricing`,
  );
