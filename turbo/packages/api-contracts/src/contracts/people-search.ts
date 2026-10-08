import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const PEOPLE_SEARCH_DEFAULT_LIMIT = 5;
export const PEOPLE_SEARCH_MAX_LIMIT = 20;
export const PEOPLE_SEARCH_MAX_QUERY_CHARS = 2_048;
export const PEOPLE_SEARCH_MAX_NAME_CHARS = 256;
export const PEOPLE_SEARCH_MAX_TITLE_CHARS = 512;
export const PEOPLE_SEARCH_MAX_COMPANY_CHARS = 256;
export const PEOPLE_SEARCH_MAX_LOCATION_CHARS = 256;
export const PEOPLE_SEARCH_MAX_SUMMARY_CHARS = 1_000;
export const PEOPLE_SEARCH_MAX_SOURCE_TITLE_CHARS = 512;
export const PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS = 2_048;
export const PEOPLE_SEARCH_MAX_SOURCES = 5;

export const peopleSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(PEOPLE_SEARCH_MAX_QUERY_CHARS),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PEOPLE_SEARCH_MAX_LIMIT)
    .default(PEOPLE_SEARCH_DEFAULT_LIMIT),
});

const peopleSearchHttpUrlSchema = z
  .string()
  .max(PEOPLE_SEARCH_MAX_SOURCE_URL_CHARS)
  .url()
  .regex(/^https?:\/\//i, "Source URL must use http or https");

export const peopleSearchSourceSchema = z.object({
  title: z.string().max(PEOPLE_SEARCH_MAX_SOURCE_TITLE_CHARS),
  url: peopleSearchHttpUrlSchema,
});

export const peopleSearchProfileSchema = z.object({
  name: z.string().min(1).max(PEOPLE_SEARCH_MAX_NAME_CHARS),
  title: z.string().max(PEOPLE_SEARCH_MAX_TITLE_CHARS).optional(),
  company: z.string().max(PEOPLE_SEARCH_MAX_COMPANY_CHARS).optional(),
  location: z.string().max(PEOPLE_SEARCH_MAX_LOCATION_CHARS).optional(),
  summary: z.string().max(PEOPLE_SEARCH_MAX_SUMMARY_CHARS).optional(),
  sources: z
    .array(peopleSearchSourceSchema)
    .min(1)
    .max(PEOPLE_SEARCH_MAX_SOURCES),
});

export const peopleSearchResponseSchema = z.object({
  query: z.string().max(PEOPLE_SEARCH_MAX_QUERY_CHARS),
  limit: z.number().int().min(1).max(PEOPLE_SEARCH_MAX_LIMIT),
  provider: z.literal("perplexity"),
  billingCategory: z.literal("request"),
  billingQuantity: z.literal(1),
  creditsCharged: z.number().int().nonnegative().nullable(),
  profiles: z.array(peopleSearchProfileSchema).max(PEOPLE_SEARCH_MAX_LIMIT),
});

export type PeopleSearchRequest = z.infer<typeof peopleSearchRequestSchema>;
export type PeopleSearchSource = z.infer<typeof peopleSearchSourceSchema>;
export type PeopleSearchProfile = z.infer<typeof peopleSearchProfileSchema>;
export type PeopleSearchResponse = z.infer<typeof peopleSearchResponseSchema>;

export const peopleSearchContract = c.router({
  search: {
    method: "POST",
    path: "/api/people-search",
    headers: authHeadersSchema,
    body: peopleSearchRequestSchema,
    responses: {
      200: peopleSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Find professionals through Okou-managed People Search",
  },
});

export type PeopleSearchContract = typeof peopleSearchContract;
