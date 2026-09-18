import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { builtInGenerationAcceptedResponseSchema } from "./built-in-generation";

const c = initContract();
const stringOrStringArraySchema = z.union([
  z.string(),
  z.array(z.string()).readonly(),
]);

export const videoIoGenerateRequestSchema = z
  .object({
    /** Fail before creating bytes when private artifact creation is unavailable. */
    requirePrivateArtifact: z.boolean().optional(),
    prompt: z.string().optional(),
    model: z.string().optional(),
    aspectRatio: z.string().optional(),
    duration: z.string().optional(),
    resolution: z.string().optional(),
    generateAudio: z.boolean().optional(),
    negativePrompt: z.string().optional(),
    seed: z.number().optional(),
    autoFix: z.boolean().optional(),
    safetyTolerance: z.string().optional(),
    imageUrls: stringOrStringArraySchema.optional(),
    videoUrls: stringOrStringArraySchema.optional(),
    audioUrls: stringOrStringArraySchema.optional(),
    referenceImageUrls: stringOrStringArraySchema.optional(),
    referenceVideoUrls: stringOrStringArraySchema.optional(),
    referenceAudioUrls: stringOrStringArraySchema.optional(),
    firstFrameImageUrl: z.string().optional(),
    lastFrameImageUrl: z.string().optional(),
  })
  .passthrough();

export const videoIoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  privateArtifacts: z.boolean().optional(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  model: z.string(),
  aspectRatio: z.string(),
  duration: z.string(),
  resolution: z.string(),
  generateAudio: z.boolean(),
  sourceUrl: z.string().optional(),
  requestId: z.string().optional(),
});

export type VideoIoGenerateRequest = z.infer<
  typeof videoIoGenerateRequestSchema
>;
export type VideoIoGenerateResponse = z.infer<
  typeof videoIoGenerateResponseSchema
>;

const creationRoute = {
  method: "POST",
  path: "/api/video-io/generate",
  headers: authHeadersSchema,
  body: videoIoGenerateRequestSchema,
  responses: {
    200: videoIoGenerateResponseSchema,
    202: builtInGenerationAcceptedResponseSchema,
    400: apiErrorSchema,
    401: apiErrorSchema,
    402: apiErrorSchema,
    403: apiErrorSchema,
    500: apiErrorSchema,
    502: apiErrorSchema,
    503: apiErrorSchema,
    504: apiErrorSchema,
  },
  summary: "Generate and persist a video file",
} as const;

export const videoIoGenerateContract = c.router({
  post: creationRoute,
  postPrivate: {
    ...creationRoute,
    path: "/api/video-io/generate/private",
  },
});

export type VideoIoGenerateContract = typeof videoIoGenerateContract;
