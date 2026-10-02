import {
  WEATHER_ATTRIBUTION,
  type WeatherCurrentRequest,
  type WeatherForecastDailyRequest,
  type WeatherForecastHourlyRequest,
  type WeatherHistoryHourlyRequest,
  type WeatherConditionsResponse,
} from "@okouai/api-contracts/contracts/weather";
import { command } from "ccstate";

import type { AuthContext } from "../../types/auth";
import { env } from "../../lib/env";
import { safeJsonParse } from "../utils";
import {
  checkManagedCredits$,
  recordSuccessfulManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";

const PROVIDER = "google-weather";
const USAGE_KIND = "weather";
const CURRENT_CATEGORY = "current";
const FORECAST_HOURLY_CATEGORY = "forecast.hourly";
const FORECAST_DAILY_CATEGORY = "forecast.daily";
const HISTORY_HOURLY_CATEGORY = "history.hourly";

const GOOGLE_WEATHER_CURRENT_URL =
  "https://weather.googleapis.com/v1/currentConditions:lookup";
const GOOGLE_WEATHER_FORECAST_HOURLY_URL =
  "https://weather.googleapis.com/v1/forecast/hours:lookup";
const GOOGLE_WEATHER_FORECAST_DAILY_URL =
  "https://weather.googleapis.com/v1/forecast/days:lookup";
const GOOGLE_WEATHER_HISTORY_HOURLY_URL =
  "https://weather.googleapis.com/v1/history/hours:lookup";

type ErrorStatus = 502 | 503;

interface WeatherErrorResponse {
  readonly status: ErrorStatus;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type WeatherCommandResponse =
  | { readonly status: 200; readonly body: WeatherConditionsResponse }
  | WeatherErrorResponse
  | ManagedUsageErrorResponse;

interface WeatherRequestBody {
  readonly lat: number;
  readonly lng: number;
  readonly units: "metric" | "imperial";
  readonly languageCode?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly hours?: number;
  readonly days?: number;
}

interface AuthedWeatherArgs<TBody extends WeatherRequestBody> {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: TBody;
}

interface WeatherRequestArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: WeatherRequestBody;
  readonly operation: WeatherConditionsResponse["operation"];
  readonly category: string;
  readonly providerUrl: string;
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badGateway(message: string): WeatherErrorResponse {
  return {
    status: 502,
    body: errorBody(message, "GOOGLE_WEATHER_ERROR"),
  };
}

function serviceUnavailable(
  message: string,
  code: string,
): WeatherErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWeatherErrorResponse(value: unknown): value is WeatherErrorResponse {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.body) &&
    isRecord(value.body.error)
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  const parsed = safeJsonParse(text);
  return parsed === undefined ? text : parsed;
}

function googleWeatherErrorMessage(body: unknown): string {
  if (isRecord(body)) {
    const error = body.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body;
  }
  return "Google Weather request failed";
}

async function fetchGoogleWeatherJson(
  url: URL,
  signal: AbortSignal,
): Promise<unknown | WeatherErrorResponse> {
  const response = await fetch(url, { signal });
  const body = await readResponseBody(response);
  if (!response.ok) {
    return badGateway(googleWeatherErrorMessage(body));
  }
  return body;
}

function maybeSetParam(
  params: URLSearchParams,
  name: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) {
    params.set(name, String(value));
  }
}

function googleWeatherUrl(
  providerUrl: string,
  apiKey: string,
  body: WeatherRequestBody,
): URL {
  const url = new URL(providerUrl);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("location.latitude", String(body.lat));
  url.searchParams.set("location.longitude", String(body.lng));
  url.searchParams.set("unitsSystem", body.units.toUpperCase());
  maybeSetParam(url.searchParams, "languageCode", body.languageCode);
  maybeSetParam(url.searchParams, "pageSize", body.pageSize);
  maybeSetParam(url.searchParams, "pageToken", body.pageToken);
  maybeSetParam(url.searchParams, "hours", body.hours);
  maybeSetParam(url.searchParams, "days", body.days);
  return url;
}

function runIdForUsage(auth: AuthContext): string | undefined {
  return auth.tokenType === "agent" || auth.tokenType === "sandbox"
    ? auth.runId
    : undefined;
}

const weatherRequest$ = command(
  async (
    { set },
    args: WeatherRequestArgs,
    signal: AbortSignal,
  ): Promise<WeatherCommandResponse> => {
    const apiKey = env("OKOU_WEATHER_GOOGLE_WEATHER_TOKEN");
    if (!apiKey) {
      return serviceUnavailable(
        "Okou Weather Google Weather provider is not configured",
        "NOT_CONFIGURED",
      );
    }

    const creditError = await set(
      checkManagedCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: runIdForUsage(args.auth),
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: args.category,
        },
        label: "Okou Weather",
      },
      signal,
    );
    if (creditError) {
      return creditError;
    }

    const result = await fetchGoogleWeatherJson(
      googleWeatherUrl(args.providerUrl, apiKey, args.body),
      signal,
    );
    if (isWeatherErrorResponse(result)) {
      return result;
    }

    const runId = runIdForUsage(args.auth);
    const creditsCharged = await set(
      recordSuccessfulManagedUsage$,
      {
        actor: {
          orgId: args.auth.orgId,
          userId: args.auth.userId,
          ...(runId ? { runId } : {}),
        },
        resource: {
          kind: USAGE_KIND,
          provider: PROVIDER,
          category: args.category,
        },
        label: "weather",
      },
      signal,
    );

    const body: WeatherConditionsResponse = {
      operation: args.operation,
      provider: PROVIDER,
      attribution: WEATHER_ATTRIBUTION,
      creditsCharged,
      billingCategory: args.category,
      billingQuantity: 1,
      result,
    };
    return { status: 200, body };
  },
);

export const weatherCurrent$ = command(
  async (
    { set },
    args: AuthedWeatherArgs<WeatherCurrentRequest>,
    signal: AbortSignal,
  ) => {
    return await set(
      weatherRequest$,
      {
        ...args,
        operation: "current",
        category: CURRENT_CATEGORY,
        providerUrl: GOOGLE_WEATHER_CURRENT_URL,
      },
      signal,
    );
  },
);

export const weatherForecastHourly$ = command(
  async (
    { set },
    args: AuthedWeatherArgs<WeatherForecastHourlyRequest>,
    signal: AbortSignal,
  ) => {
    return await set(
      weatherRequest$,
      {
        ...args,
        operation: "forecast.hourly",
        category: FORECAST_HOURLY_CATEGORY,
        providerUrl: GOOGLE_WEATHER_FORECAST_HOURLY_URL,
      },
      signal,
    );
  },
);

export const weatherForecastDaily$ = command(
  async (
    { set },
    args: AuthedWeatherArgs<WeatherForecastDailyRequest>,
    signal: AbortSignal,
  ) => {
    return await set(
      weatherRequest$,
      {
        ...args,
        operation: "forecast.daily",
        category: FORECAST_DAILY_CATEGORY,
        providerUrl: GOOGLE_WEATHER_FORECAST_DAILY_URL,
      },
      signal,
    );
  },
);

export const weatherHistoryHourly$ = command(
  async (
    { set },
    args: AuthedWeatherArgs<WeatherHistoryHourlyRequest>,
    signal: AbortSignal,
  ) => {
    return await set(
      weatherRequest$,
      {
        ...args,
        operation: "history.hourly",
        category: HISTORY_HOURLY_CATEGORY,
        providerUrl: GOOGLE_WEATHER_HISTORY_HOURLY_URL,
      },
      signal,
    );
  },
);
