import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const WEATHER_ATTRIBUTION = "Source: Includes weather data from Google";
export const AIR_QUALITY_ATTRIBUTION =
  "Source: Includes air quality data from Google";

const weatherConditionsOperationSchema = z.enum([
  "current",
  "forecast.hourly",
  "forecast.daily",
  "history.hourly",
]);
export const weatherOperationSchema = z.enum([
  ...weatherConditionsOperationSchema.options,
  "air-quality.current",
]);

export const weatherUnitsSchema = z.enum(["metric", "imperial"]);

const weatherLocationRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  units: weatherUnitsSchema.default("metric"),
  languageCode: z.string().trim().min(1).optional(),
});

const weatherHourlyPageRequestSchema = weatherLocationRequestSchema.extend({
  pageSize: z.number().int().min(1).max(24).optional(),
  pageToken: z.string().trim().min(1).optional(),
});

export const weatherCurrentRequestSchema = weatherLocationRequestSchema;

export const weatherForecastHourlyRequestSchema =
  weatherHourlyPageRequestSchema.extend({
    hours: z.number().int().min(1).max(240).optional(),
  });

export const weatherForecastDailyRequestSchema =
  weatherLocationRequestSchema.extend({
    days: z.number().int().min(1).max(10).optional(),
    pageSize: z.number().int().min(1).max(10).optional(),
    pageToken: z.string().trim().min(1).optional(),
  });

export const weatherHistoryHourlyRequestSchema =
  weatherHourlyPageRequestSchema.extend({
    hours: z.number().int().min(1).max(24).optional(),
  });

export const airQualityCurrentRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  languageCode: z.string().trim().min(1).optional(),
});

const weatherResponseBaseSchema = z.object({
  creditsCharged: z.number().nullable(),
  billingCategory: z.string(),
  billingQuantity: z.number(),
  result: z.unknown(),
});

export const weatherConditionsResponseSchema = weatherResponseBaseSchema.extend(
  {
    operation: weatherConditionsOperationSchema,
    provider: z.literal("google-weather"),
    attribution: z.literal(WEATHER_ATTRIBUTION),
  },
);

export const airQualityResponseSchema = weatherResponseBaseSchema.extend({
  operation: z.literal("air-quality.current"),
  provider: z.literal("google-air-quality"),
  attribution: z.literal(AIR_QUALITY_ATTRIBUTION),
});

export const weatherResponseSchema = z.discriminatedUnion("provider", [
  weatherConditionsResponseSchema,
  airQualityResponseSchema,
]);

export type WeatherResponse = z.infer<typeof weatherResponseSchema>;
export type WeatherConditionsResponse = z.infer<
  typeof weatherConditionsResponseSchema
>;
export type AirQualityResponse = z.infer<typeof airQualityResponseSchema>;
export type WeatherCurrentRequest = z.infer<typeof weatherCurrentRequestSchema>;
export type WeatherForecastHourlyRequest = z.infer<
  typeof weatherForecastHourlyRequestSchema
>;
export type WeatherForecastDailyRequest = z.infer<
  typeof weatherForecastDailyRequestSchema
>;
export type WeatherHistoryHourlyRequest = z.infer<
  typeof weatherHistoryHourlyRequestSchema
>;
export type AirQualityCurrentRequest = z.infer<
  typeof airQualityCurrentRequestSchema
>;

const weatherResponses = {
  200: weatherConditionsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const airQualityResponses = {
  200: airQualityResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const weatherContract = c.router({
  current: {
    method: "POST",
    path: "/api/weather/current",
    headers: authHeadersSchema,
    body: weatherCurrentRequestSchema,
    responses: weatherResponses,
    summary: "Get current conditions through managed Okou Weather",
  },
  forecastHourly: {
    method: "POST",
    path: "/api/weather/forecast/hourly",
    headers: authHeadersSchema,
    body: weatherForecastHourlyRequestSchema,
    responses: weatherResponses,
    summary: "Get an hourly forecast through managed Okou Weather",
  },
  forecastDaily: {
    method: "POST",
    path: "/api/weather/forecast/daily",
    headers: authHeadersSchema,
    body: weatherForecastDailyRequestSchema,
    responses: weatherResponses,
    summary: "Get a daily forecast through managed Okou Weather",
  },
  historyHourly: {
    method: "POST",
    path: "/api/weather/history/hourly",
    headers: authHeadersSchema,
    body: weatherHistoryHourlyRequestSchema,
    responses: weatherResponses,
    summary: "Get recent hourly history through managed Okou Weather",
  },
  airQualityCurrent: {
    method: "POST",
    path: "/api/weather/air-quality/current",
    headers: authHeadersSchema,
    body: airQualityCurrentRequestSchema,
    responses: airQualityResponses,
    summary: "Get current air quality through managed Okou Weather",
  },
});

export type WeatherContract = typeof weatherContract;
