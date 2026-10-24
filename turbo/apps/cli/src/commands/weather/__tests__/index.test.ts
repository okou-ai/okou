import { dataRouterTool } from "../../../mocks/data-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { HttpResponse } from "msw";

import { server } from "../../../mocks/server";
import { weatherCommand } from "../index";
const WEATHER_ATTRIBUTION = "Source: Includes weather data from Google";
const AIR_QUALITY_ATTRIBUTION = "Source: Includes air quality data from Google";

describe("okou data weather command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("posts current-condition requests and renders a readable summary", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("weather_current", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          operation: "current",
          provider: "google-weather",
          attribution: WEATHER_ATTRIBUTION,
          creditsCharged: 0,
          billingCategory: "current",
          billingQuantity: 1,
          result: {
            timeZone: { id: "America/Los_Angeles" },
            weatherCondition: { description: { text: "Clear" } },
            temperature: { degrees: 28, unit: "CELSIUS" },
          },
        });
      }),
    );

    await weatherCommand.parseAsync([
      "node",
      "cli",
      "current",
      "--lat",
      "39.9042",
      "--lng",
      "116.4074",
    ]);

    expect(requestBody).toEqual({
      lat: 39.9042,
      lng: 116.4074,
      units: "metric",
      languageCode: "en",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ Current weather retrieved");
    expect(output).toContain("Current conditions · America/Los_Angeles");
    expect(output).toContain("Clear · 28°C");
    expect(output).toContain(WEATHER_ATTRIBUTION);
    expect(output).not.toContain('"temperature"');
  });

  it("renders daily forecasts with the useful weather fields", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("weather_forecast_daily", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          operation: "forecast.daily",
          provider: "google-weather",
          attribution: WEATHER_ATTRIBUTION,
          creditsCharged: 0,
          billingCategory: "forecast.daily",
          billingQuantity: 1,
          result: {
            forecastDays: [
              {
                displayDate: { year: 2026, month: 7, day: 23 },
                daytimeForecast: {
                  weatherCondition: {
                    description: { text: "Partly cloudy" },
                  },
                  precipitation: { probability: { percent: 10 } },
                  wind: {
                    direction: { cardinal: "WEST" },
                    speed: { unit: "KILOMETERS_PER_HOUR", value: 27 },
                    gust: { unit: "KILOMETERS_PER_HOUR", value: 39 },
                  },
                  uvIndex: 9,
                },
                nighttimeForecast: {
                  weatherCondition: {
                    description: { text: "Partly clear" },
                  },
                  precipitation: { probability: { percent: 5 } },
                },
                maxTemperature: { degrees: 19.9, unit: "CELSIUS" },
                minTemperature: { degrees: 15.1, unit: "CELSIUS" },
                feelsLikeMaxTemperature: {
                  degrees: 24.6,
                  unit: "CELSIUS",
                },
                feelsLikeMinTemperature: { degrees: 14, unit: "CELSIUS" },
                sunEvents: {
                  sunriseTime: "2026-07-22T13:05:12Z",
                  sunsetTime: "2026-07-23T03:26:43Z",
                },
              },
            ],
            timeZone: { id: "America/Los_Angeles" },
          },
        });
      }),
    );

    await weatherCommand.parseAsync([
      "node",
      "cli",
      "forecast",
      "daily",
      "--lat",
      "37.7749",
      "--lng",
      "-122.4194",
      "--days",
      "1",
    ]);

    expect(requestBody).toEqual({
      lat: 37.7749,
      lng: -122.4194,
      units: "metric",
      languageCode: "en",
      days: 1,
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Daily forecast · America/Los_Angeles");
    expect(output).toContain("Thu, Jul 23");
    expect(output).toContain("Partly cloudy · Partly clear overnight");
    expect(output).toContain("15.1–19.9°C");
    expect(output).toContain("feels like 14–24.6°C");
    expect(output).toContain("rain 10% (night 5%)");
    expect(output).toContain("W 27 km/h, gusts 39 km/h");
    expect(output).toContain("UV 9");
    expect(output).toContain("Sunrise 6:05 AM · Sunset 8:26 PM");
    expect(output).not.toContain('"forecastDays"');
  });

  it("passes hourly forecast range and pagination without aggregating pages", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("weather_forecast_hourly", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          operation: "forecast.hourly",
          provider: "google-weather",
          attribution: WEATHER_ATTRIBUTION,
          creditsCharged: 0,
          billingCategory: "forecast.hourly",
          billingQuantity: 1,
          result: {
            forecastHours: [],
            nextPageToken: "next-hourly-page",
          },
        });
      }),
    );

    await weatherCommand.parseAsync([
      "node",
      "cli",
      "forecast",
      "hourly",
      "--lat",
      "37.7749",
      "--lng",
      "-122.4194",
      "--units",
      "imperial",
      "--hours",
      "72",
      "--page-size",
      "12",
      "--page-token",
      "hourly-page",
      "--json",
    ]);

    expect(requestBody).toEqual({
      lat: 37.7749,
      lng: -122.4194,
      units: "imperial",
      languageCode: "en",
      pageSize: 12,
      pageToken: "hourly-page",
      hours: 72,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        operation: "forecast.hourly",
        provider: "google-weather",
        attribution: WEATHER_ATTRIBUTION,
        creditsCharged: 0,
        billingCategory: "forecast.hourly",
        billingQuantity: 1,
        result: {
          forecastHours: [],
          nextPageToken: "next-hourly-page",
        },
      }),
    );
  });

  it("posts compact current air quality requests", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("weather_air_quality_current", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          operation: "air-quality.current",
          provider: "google-air-quality",
          attribution: AIR_QUALITY_ATTRIBUTION,
          creditsCharged: 0,
          billingCategory: "current",
          billingQuantity: 1,
          result: {
            indexes: [{ code: "uaqi", aqi: 42 }],
            pollutants: [{ code: "pm25", concentration: { value: 18.2 } }],
          },
        });
      }),
    );

    await weatherCommand.parseAsync([
      "node",
      "cli",
      "air-quality",
      "current",
      "--lat",
      "39.9042",
      "--lng",
      "116.4074",
    ]);

    expect(requestBody).toEqual({
      lat: 39.9042,
      lng: 116.4074,
      languageCode: "en",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("✓ Current air quality retrieved");
    expect(output).toContain("Current air quality");
    expect(output).toContain(AIR_QUALITY_ATTRIBUTION);
  });

  it("posts daily forecast options to the daily endpoint", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("weather_forecast_daily", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          operation: "forecast.daily",
          provider: "google-weather",
          attribution: WEATHER_ATTRIBUTION,
          creditsCharged: 0,
          billingCategory: "forecast.daily",
          billingQuantity: 1,
          result: { forecastDays: [] },
        });
      }),
    );

    await weatherCommand.parseAsync([
      "node",
      "cli",
      "forecast",
      "daily",
      "--lat",
      "51.5072",
      "--lng",
      "-0.1276",
      "--days",
      "10",
      "--page-size",
      "5",
      "--json",
    ]);

    expect(requestBody).toEqual({
      lat: 51.5072,
      lng: -0.1276,
      units: "metric",
      languageCode: "en",
      pageSize: 5,
      days: 10,
    });
  });

  it("posts recent hourly history options to the history endpoint", async () => {
    let requestBody: unknown;
    server.use(
      dataRouterTool("weather_history_hourly", ({ toolArguments }) => {
        requestBody = toolArguments;
        return HttpResponse.json({
          operation: "history.hourly",
          provider: "google-weather",
          attribution: WEATHER_ATTRIBUTION,
          creditsCharged: 0,
          billingCategory: "history.hourly",
          billingQuantity: 1,
          result: { historyHours: [] },
        });
      }),
    );

    await weatherCommand.parseAsync([
      "node",
      "cli",
      "history",
      "hourly",
      "--lat",
      "35.6762",
      "--lng",
      "139.6503",
      "--hours",
      "24",
      "--page-token",
      "history-page",
    ]);

    expect(requestBody).toEqual({
      lat: 35.6762,
      lng: 139.6503,
      units: "metric",
      languageCode: "en",
      pageToken: "history-page",
      hours: 24,
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Hourly history");
    expect(output).toContain("No history data returned.");
  });
});
