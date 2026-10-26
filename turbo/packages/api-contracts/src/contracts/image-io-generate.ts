import {
  array,
  boolean,
  number,
  object,
  string,
  union,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { builtInGenerationAcceptedResponseSchema } from "./built-in-generation";

const c = initContract();
const stringOrStringArraySchema = union([string(), array(string()).readonly()]);
const numberOrStringSchema = union([number(), string()]);

export const imageIoGenerateRequestSchema = object({
  /** Fail before creating bytes when private artifact creation is unavailable. */
  requirePrivateArtifact: boolean().optional(),
  prompt: string().optional(),
  size: string().optional(),
  quality: string().optional(),
  background: string().optional(),
  outputFormat: string().optional(),
  outputCompression: numberOrStringSchema.optional(),
  moderation: string().optional(),
  seed: numberOrStringSchema.optional(),
  safetyTolerance: string().optional(),
  enhancePrompt: boolean().optional(),
  imageUrl: stringOrStringArraySchema.optional(),
  image_url: stringOrStringArraySchema.optional(),
  imageUrls: stringOrStringArraySchema.optional(),
  image_urls: stringOrStringArraySchema.optional(),
  maskImageUrl: string().optional(),
  mask_image_url: string().optional(),
  inputFidelity: string().optional(),
  input_fidelity: string().optional(),
  imagePromptStrength: numberOrStringSchema.optional(),
  image_prompt_strength: numberOrStringSchema.optional(),
}).passthrough();

export const imageIoGenerateResponseSchema = object({
  id: string(),
  filename: string(),
  contentType: string(),
  size: number(),
  url: string(),
  privateArtifacts: boolean().optional(),
  // Private outputs omit this; public outputs retain their optimized CDN URL.
  embedUrl: string().optional(),
  creditsCharged: number(),
  model: string(),
  provider: string(),
  imageSize: string(),
  quality: string(),
  background: string(),
  outputFormat: string(),
  outputCompression: number().optional(),
  moderation: string().optional(),
  safetyTolerance: string().optional(),
  revisedPrompt: string().optional(),
  billingCategory: string().optional(),
  billingQuantity: number().optional(),
  sourceUrl: string().optional(),
  seed: number().optional(),
  sourceImageUrls: array(string()).optional(),
  maskImageUrl: string().optional(),
  inputFidelity: string().optional(),
  imagePromptStrength: number().optional(),
});

export type ImageIoGenerateRequest = zInfer<
  typeof imageIoGenerateRequestSchema
>;
export type ImageIoGenerateResponse = zInfer<
  typeof imageIoGenerateResponseSchema
>;

const creationRoute = {
  method: "POST",
  path: "/api/image-io/generate",
  headers: authHeadersSchema,
  body: imageIoGenerateRequestSchema,
  responses: {
    202: builtInGenerationAcceptedResponseSchema,
    400: apiErrorSchema,
    401: apiErrorSchema,
    402: apiErrorSchema,
    403: apiErrorSchema,
    500: apiErrorSchema,
    502: apiErrorSchema,
    503: apiErrorSchema,
  },
  summary: "Generate and persist an image file",
} as const;

export const imageIoGenerateContract = c.router({
  post: creationRoute,
  postPrivate: {
    ...creationRoute,
    path: "/api/image-io/generate/private",
  },
});

export type ImageIoGenerateContract = typeof imageIoGenerateContract;
