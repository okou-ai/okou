import { z } from "zod";

/** Shared wire format consumed by the API and both delivery workers. */
export const artifactOgMetadataSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(false),
    normalizeImageUrls: z.boolean().optional(),
  }),
  z.object({
    available: z.literal(true),
    normalizeImageUrls: z.boolean().optional(),
    title: z.string(),
    description: z.string(),
    imageUrl: z.url(),
    url: z.url(),
  }),
]);
