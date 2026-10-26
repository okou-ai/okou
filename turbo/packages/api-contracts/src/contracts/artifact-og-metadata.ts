import { discriminatedUnion, literal, object, string, url } from "zod";

/** Shared wire format consumed by the API and both delivery workers. */
export const artifactOgMetadataSchema = discriminatedUnion("available", [
  object({ available: literal(false) }),
  object({
    available: literal(true),
    title: string(),
    description: string(),
    imageUrl: url(),
    url: url(),
  }),
]);
