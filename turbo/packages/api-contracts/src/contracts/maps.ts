import { z } from "zod";

export const MAPS_SEARCH_MAX_QUERY_CHARS = 4_096;

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

export type MapsSearchRequest = z.infer<typeof mapsSearchRequestSchema>;
