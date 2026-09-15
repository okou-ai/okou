import { z } from "zod";

export const PRIVATE_VIDEO_POSTER_PATH = "/__artifact-video-poster";
export const PRIVATE_VIDEO_POSTER_MAX_BYTES = 100_000_000;

/** A short-lived, server-only capability for one private video's poster. */
export const privateVideoPosterGrantSchema = z.object({
  version: z.literal(1),
  sourceKey: z.string().regex(/^private-artifacts\/[0-9a-f-]{36}\/[^/]+$/u),
  expiresAt: z.iso.datetime(),
});

export function privateVideoPosterGrantKey(token: string): string {
  return `private-video-previews/${token}.json`;
}
