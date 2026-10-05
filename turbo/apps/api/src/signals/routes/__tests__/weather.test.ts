import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  AIR_QUALITY_ATTRIBUTION,
  WEATHER_ATTRIBUTION,
  weatherContract,
  type AirQualityResponse,
  type WeatherConditionsResponse,
} from "@okouai/api-contracts/contracts/weather";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { weatherRoutes } from "../weather";

const context = testContext();
const GOOGLE_WEATHER_CURRENT_URL =
  "https://weather.googleapis.com/v1/currentConditions:lookup";
const GOOGLE_WEATHER_FORECAST_HOURLY_URL =
  "https://weather.googleapis.com/v1/forecast/hours:lookup";
const GOOGLE_WEATHER_FORECAST_DAILY_URL =
  "https://weather.googleapis.com/v1/forecast/days:lookup";
const GOOGLE_WEATHER_HISTORY_HOURLY_URL =
  "https://weather.googleapis.com/v1/history/hours:lookup";
const GOOGLE_AIR_QUALITY_CURRENT_URL =
  "https://airquality.googleapis.com/v1/currentConditions:lookup";

function authenticate(actor: ApiTestUser): { readonly authorization: string } {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

const WEATHER_PRICING_ROWS = [
  {
    kind: "weather",
    provider: "google-weather",
    category: "current",
    unitPrice: 0,
    unitSize: 1,
  },
  {
    kind: "weather",
    provider: "google-weather",
    category: "forecast.hourly",
    unitPrice: 0,
    unitSize: 1,
  },
  {
    kind: "weather",
    provider: "google-weather",
    category: "forecast.daily",
    unitPrice: 0,
    unitSize: 1,
  },
  {
    kind: "weather",
    provider: "google-weather",
    category: "history.hourly",
    unitPrice: 0,
    unitSize: 1,
  },
  {
    kind: "weather",
    provider: "google-air-quality",
    category: "current",
    unitPrice: 0,
    unitSize: 1,
  },
] as const satisfies readonly UsagePricingRow[];

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupApp({
    context,
    routes: weatherRoutes,
    usagePricingResolution,
  })(weatherContract);
}

function configureProvider(): void {
  mockEnv("OKOU_WEATHER_GOOGLE_WEATHER_TOKEN", "test-google-weather-key");
}

async function prepareFreeWeatherActor(actor: ApiTestUser) {
  const pricing = await createUsagePricingFixture({
    configured: WEATHER_PRICING_ROWS,
  });
  onTestFinished(pricing.cleanup);
  const fixture = createPublicUnfundedProFixture(context, actor);
  await fixture.initialize();
  return { pricing, run: fixture.run };
}

function expectFreeWeatherResponse(
  body: WeatherConditionsResponse,
  operation: WeatherConditionsResponse["operation"],
): void {
  expect(body).toMatchObject({
    operation,
    provider: "google-weather",
    attribution: WEATHER_ATTRIBUTION,
    creditsCharged: 0,
    billingCategory: operation,
    billingQuantity: 1,
  });
}

function expectFreeAirQualityResponse(body: AirQualityResponse): void {
  expect(body).toMatchObject({
    operation: "air-quality.current",
    provider: "google-air-quality",
    attribution: AIR_QUALITY_ATTRIBUTION,
    creditsCharged: 0,
    billingCategory: "current",
    billingQuantity: 1,
  });
}

describe("okou weather route", () => {
  it("returns not configured before calling Google Weather", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    mockEnv("OKOU_WEATHER_GOOGLE_WEATHER_TOKEN", undefined);
    server.use(
      http.get(GOOGLE_WEATHER_CURRENT_URL, () => {
        providerRequests += 1;
        return HttpResponse.json({});
      }),
    );

    const response = await accept(
      client().current({
        headers: authenticate(actor),
        body: { lat: 39.9042, lng: 116.4074, units: "metric" },
      }),
      [503],
    );

    expect(response.body.error.code).toBe("NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("records current conditions at zero credits for an empty balance", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      mockEnv(
        "OKOU_WEATHER_GOOGLE_WEATHER_TOKEN",
        "test-okou-google-weather-key",
      );
      let providerUrl: URL | undefined;
      server.use(
        http.get(GOOGLE_WEATHER_CURRENT_URL, ({ request }) => {
          providerUrl = new URL(request.url);
          return HttpResponse.json({
            weatherCondition: { description: { text: "晴" } },
            temperature: { degrees: 28, unit: "CELSIUS" },
          });
        }),
      );

      const response = await accept(
        client(pricing.resolution).current({
          headers: authenticate(actor),
          body: {
            lat: 39.9042,
            lng: 116.4074,
            units: "metric",
            languageCode: "zh-CN",
          },
        }),
        [200],
      );

      expectFreeWeatherResponse(response.body, "current");
      expect(response.body.result).toMatchObject({
        weatherCondition: { description: { text: "晴" } },
      });
      expect(providerUrl?.searchParams.get("key")).toBe(
        "test-okou-google-weather-key",
      );
      expect(providerUrl?.searchParams.get("location.latitude")).toBe(
        "39.9042",
      );
      expect(providerUrl?.searchParams.get("location.longitude")).toBe(
        "116.4074",
      );
      expect(providerUrl?.searchParams.get("unitsSystem")).toBe("METRIC");
      expect(providerUrl?.searchParams.get("languageCode")).toBe("zh-CN");
    });
  });

  it("forwards one hourly forecast page to Google Weather", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      configureProvider();
      let providerUrl: URL | undefined;
      server.use(
        http.get(GOOGLE_WEATHER_FORECAST_HOURLY_URL, ({ request }) => {
          providerUrl = new URL(request.url);
          return HttpResponse.json({
            forecastHours: [],
            nextPageToken: "next-hourly-page",
          });
        }),
      );

      const response = await accept(
        client(pricing.resolution).forecastHourly({
          headers: authenticate(actor),
          body: {
            lat: 37.7749,
            lng: -122.4194,
            units: "imperial",
            hours: 72,
            pageSize: 12,
            pageToken: "hourly-page",
          },
        }),
        [200],
      );

      expectFreeWeatherResponse(response.body, "forecast.hourly");
      expect(providerUrl?.searchParams.get("unitsSystem")).toBe("IMPERIAL");
      expect(providerUrl?.searchParams.get("hours")).toBe("72");
      expect(providerUrl?.searchParams.get("pageSize")).toBe("12");
      expect(providerUrl?.searchParams.get("pageToken")).toBe("hourly-page");
    });
  });

  it("forwards one daily forecast page to Google Weather", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      configureProvider();
      let providerUrl: URL | undefined;
      server.use(
        http.get(GOOGLE_WEATHER_FORECAST_DAILY_URL, ({ request }) => {
          providerUrl = new URL(request.url);
          return HttpResponse.json({ forecastDays: [] });
        }),
      );

      const response = await accept(
        client(pricing.resolution).forecastDaily({
          headers: authenticate(actor),
          body: {
            lat: 51.5072,
            lng: -0.1276,
            units: "metric",
            days: 10,
            pageSize: 5,
            pageToken: "daily-page",
          },
        }),
        [200],
      );

      expectFreeWeatherResponse(response.body, "forecast.daily");
      expect(providerUrl?.searchParams.get("days")).toBe("10");
      expect(providerUrl?.searchParams.get("pageSize")).toBe("5");
      expect(providerUrl?.searchParams.get("pageToken")).toBe("daily-page");
    });
  });

  it("forwards one hourly history page to Google Weather", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      configureProvider();
      let providerUrl: URL | undefined;
      server.use(
        http.get(GOOGLE_WEATHER_HISTORY_HOURLY_URL, ({ request }) => {
          providerUrl = new URL(request.url);
          return HttpResponse.json({ historyHours: [] });
        }),
      );

      const response = await accept(
        client(pricing.resolution).historyHourly({
          headers: authenticate(actor),
          body: {
            lat: 35.6762,
            lng: 139.6503,
            units: "metric",
            hours: 24,
            pageSize: 24,
            pageToken: "history-page",
          },
        }),
        [200],
      );

      expectFreeWeatherResponse(response.body, "history.hourly");
      expect(providerUrl?.searchParams.get("hours")).toBe("24");
      expect(providerUrl?.searchParams.get("pageSize")).toBe("24");
      expect(providerUrl?.searchParams.get("pageToken")).toBe("history-page");
    });
  });

  it("returns compact current air quality at zero credits", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      configureProvider();
      let providerUrl: URL | undefined;
      let providerBody: unknown;
      server.use(
        http.post(GOOGLE_AIR_QUALITY_CURRENT_URL, async ({ request }) => {
          providerUrl = new URL(request.url);
          providerBody = await request.json();
          return HttpResponse.json({
            dateTime: "2026-07-23T06:00:00Z",
            indexes: [
              { code: "uaqi", aqi: 42 },
              { code: "chn_mee", aqi: 31 },
            ],
            pollutants: [
              {
                code: "pm25",
                concentration: {
                  value: 18.2,
                  units: "MICROGRAMS_PER_CUBIC_METER",
                },
              },
            ],
          });
        }),
      );

      const response = await accept(
        client(pricing.resolution).airQualityCurrent({
          headers: authenticate(actor),
          body: {
            lat: 39.9042,
            lng: 116.4074,
            languageCode: "zh-CN",
          },
        }),
        [200],
      );

      expectFreeAirQualityResponse(response.body);
      expect(response.body.result).toMatchObject({
        indexes: [
          { code: "uaqi", aqi: 42 },
          { code: "chn_mee", aqi: 31 },
        ],
        pollutants: [{ code: "pm25" }],
      });
      expect(providerUrl?.searchParams.get("key")).toBe(
        "test-google-weather-key",
      );
      expect(providerBody).toStrictEqual({
        location: {
          latitude: 39.9042,
          longitude: 116.4074,
        },
        universalAqi: true,
        extraComputations: ["LOCAL_AQI", "POLLUTANT_CONCENTRATION"],
        languageCode: "zh-CN",
      });
    });
  });

  it("returns Google Air Quality errors without success billing metadata", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      configureProvider();
      server.use(
        http.post(GOOGLE_AIR_QUALITY_CURRENT_URL, () => {
          return HttpResponse.json(
            { error: { message: "Air quality location unavailable" } },
            { status: 400 },
          );
        }),
      );

      const response = await accept(
        client(pricing.resolution).airQualityCurrent({
          headers: authenticate(actor),
          body: { lat: 39.9042, lng: 116.4074 },
        }),
        [502],
      );

      expect(response.body.error.code).toBe("GOOGLE_AIR_QUALITY_ERROR");
      expect(response.body.error.message).toBe(
        "Air quality location unavailable",
      );
    });
  });

  it("returns Google Weather errors without success billing metadata", async () => {
    const actor = createBddApi(context).user();
    const { pricing, run } = await prepareFreeWeatherActor(actor);
    await run(async () => {
      configureProvider();
      server.use(
        http.get(GOOGLE_WEATHER_CURRENT_URL, () => {
          return HttpResponse.json(
            { error: { message: "Weather location unavailable" } },
            { status: 400 },
          );
        }),
      );

      const response = await accept(
        client(pricing.resolution).current({
          headers: authenticate(actor),
          body: { lat: 39.9042, lng: 116.4074, units: "metric" },
        }),
        [502],
      );

      expect(response.body.error.code).toBe("GOOGLE_WEATHER_ERROR");
      expect(response.body.error.message).toBe("Weather location unavailable");
    });
  });
});
