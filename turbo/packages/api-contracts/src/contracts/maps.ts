import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const MAPS_SEARCH_MAX_QUERY_CHARS = 4_096;
export const MAPS_SEARCH_MAX_ANSWER_CHARS = 32_768;
export const MAPS_SEARCH_MAX_SOURCES = 64;
export const MAPS_SEARCH_MAX_SOURCE_TITLE_CHARS = 512;
export const MAPS_SEARCH_MAX_SOURCE_URL_CHARS = 2_048;
export const MAPS_SEARCH_MAX_CITATIONS = 128;

export const mapsSearchLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export const mapsSearchLanguageCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z]{2,3}(?:[-_][A-Z]{2})?$/u,
    "languageCode must look like en or en_US",
  )
  .transform((value) => {
    return value.replace("-", "_");
  });

export const mapsSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(MAPS_SEARCH_MAX_QUERY_CHARS),
  location: mapsSearchLocationSchema.optional(),
  languageCode: mapsSearchLanguageCodeSchema.optional(),
});

const mapsSearchSourceUrlSchema = z
  .string()
  .max(MAPS_SEARCH_MAX_SOURCE_URL_CHARS)
  .url()
  .regex(/^https:\/\//u, "Google Maps source URL must use https");

export const mapsSearchSourceSchema = z.object({
  title: z.string().min(1).max(MAPS_SEARCH_MAX_SOURCE_TITLE_CHARS),
  uri: mapsSearchSourceUrlSchema,
});

export const mapsSearchCitationSchema = z.object({
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  text: z.string().min(1).max(MAPS_SEARCH_MAX_ANSWER_CHARS),
  sourceIndices: z.array(z.number().int().nonnegative()).min(1).max(64),
});

export const mapsSearchUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const mapsSearchResponseSchema = z.object({
  query: z.string().max(MAPS_SEARCH_MAX_QUERY_CHARS),
  location: mapsSearchLocationSchema.optional(),
  languageCode: mapsSearchLanguageCodeSchema.optional(),
  provider: z.literal("google-maps-grounding"),
  model: z.literal("gemini-2.5-flash"),
  billingCategory: z.literal("provider_cost_usd_micros"),
  billingQuantity: z.number().int().nonnegative(),
  providerCostUsd: z.number().finite().nonnegative(),
  creditsCharged: z.number().int().nonnegative(),
  answer: z.string().min(1).max(MAPS_SEARCH_MAX_ANSWER_CHARS),
  sources: z.array(mapsSearchSourceSchema).max(MAPS_SEARCH_MAX_SOURCES),
  citations: z.array(mapsSearchCitationSchema).max(MAPS_SEARCH_MAX_CITATIONS),
  attribution: z.literal("Google Maps").optional(),
  usage: mapsSearchUsageSchema,
});

export type MapsSearchLocation = z.infer<typeof mapsSearchLocationSchema>;
export type MapsSearchRequest = z.infer<typeof mapsSearchRequestSchema>;
export type MapsSearchSource = z.infer<typeof mapsSearchSourceSchema>;
export type MapsSearchCitation = z.infer<typeof mapsSearchCitationSchema>;
export type MapsSearchUsage = z.infer<typeof mapsSearchUsageSchema>;
export type MapsSearchResponse = z.infer<typeof mapsSearchResponseSchema>;

const mapsSearchResponses = {
  200: mapsSearchResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const mapsContract = c.router({
  search: {
    method: "POST",
    path: "/api/maps/search",
    headers: authHeadersSchema,
    body: mapsSearchRequestSchema,
    responses: mapsSearchResponses,
    summary: "Search places and routes with Google Maps grounding",
  },
});

export type MapsContract = typeof mapsContract;
