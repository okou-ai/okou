import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { builtInGenerationAcceptedResponseSchema } from "./built-in-generation";

const c = initContract();
const stringOrStringArraySchema = z.union([
  z.string(),
  z.array(z.string()).readonly(),
]);
const numberOrStringSchema = z.union([z.number(), z.string()]);
const imageReferenceIdsSchema = z.array(z.string().uuid()).max(1).readonly();

export const imageIoGenerateRequestSchema = z
  .object({
    prompt: z.string().optional(),
    model: z.string().optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    background: z.string().optional(),
    outputFormat: z.string().optional(),
    outputCompression: numberOrStringSchema.optional(),
    moderation: z.string().optional(),
    seed: numberOrStringSchema.optional(),
    safetyTolerance: z.string().optional(),
    enhancePrompt: z.boolean().optional(),
    imageUrl: stringOrStringArraySchema.optional(),
    image_url: stringOrStringArraySchema.optional(),
    imageUrls: stringOrStringArraySchema.optional(),
    image_urls: stringOrStringArraySchema.optional(),
    imageReferenceIds: imageReferenceIdsSchema.optional(),
    maskImageUrl: z.string().optional(),
    mask_image_url: z.string().optional(),
    inputFidelity: z.string().optional(),
    input_fidelity: z.string().optional(),
    imagePromptStrength: numberOrStringSchema.optional(),
    image_prompt_strength: numberOrStringSchema.optional(),
  })
  .passthrough();

export const imageIoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  // Private outputs omit this; public outputs retain their optimized CDN URL.
  embedUrl: z.string().optional(),
  creditsCharged: z.number(),
  model: z.string(),
  provider: z.string(),
  imageSize: z.string(),
  quality: z.string(),
  background: z.string(),
  outputFormat: z.string(),
  outputCompression: z.number().optional(),
  moderation: z.string().optional(),
  safetyTolerance: z.string().optional(),
  revisedPrompt: z.string().optional(),
  billingCategory: z.string().optional(),
  billingQuantity: z.number().optional(),
  sourceUrl: z.string().optional(),
  seed: z.number().optional(),
  sourceImageUrls: z.array(z.string()).optional(),
  maskImageUrl: z.string().optional(),
  inputFidelity: z.string().optional(),
  imagePromptStrength: z.number().optional(),
});

export type ImageIoGenerateRequest = z.infer<
  typeof imageIoGenerateRequestSchema
>;
export type ImageIoGenerateResponse = z.infer<
  typeof imageIoGenerateResponseSchema
>;

export const imageIoGenerateContract = c.router({
  post: {
    method: "POST",
    path: "/api/image-io/generate",
    headers: authHeadersSchema,
    body: imageIoGenerateRequestSchema,
    responses: {
      200: imageIoGenerateResponseSchema,
      202: builtInGenerationAcceptedResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Generate and persist an image file",
  },
});

export type ImageIoGenerateContract = typeof imageIoGenerateContract;
