import { z } from "zod";

export const PEOPLE_SEARCH_DEFAULT_LIMIT = 5;

export const PEOPLE_SEARCH_MAX_LIMIT = 20;

export const PEOPLE_SEARCH_MAX_QUERY_CHARS = 2_048;

export const peopleSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(PEOPLE_SEARCH_MAX_QUERY_CHARS),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PEOPLE_SEARCH_MAX_LIMIT)
    .default(PEOPLE_SEARCH_DEFAULT_LIMIT),
});

export type PeopleSearchRequest = z.infer<typeof peopleSearchRequestSchema>;
