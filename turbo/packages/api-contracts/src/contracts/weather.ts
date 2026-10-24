import { z } from "zod";

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
