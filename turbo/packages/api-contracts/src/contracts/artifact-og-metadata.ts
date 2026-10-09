import { z } from "zod";

/** Shared wire format consumed by the API and both delivery workers. */
export const artifactOgMetadataSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    title: z.string(),
    description: z.string(),
    imageUrl: z.url(),
    url: z.url(),
  }),
]);
