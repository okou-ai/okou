import { z } from "zod";
import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import {
  builtInGenerationErrorSchema,
  builtInGenerationStatusSchema,
} from "./built-in-generation";
import { apiErrorSchema } from "./errors";

const c = initContract();
export const MAX_INTRO_VIDEO_PROJECT_BYTES = 200 * 1024 * 1024;
export const introVideoCompositionSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => {
    return (
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      path.split("/").every((part) => {
        return part !== ".." && part !== "." && part !== "";
      }) &&
      /\.html?$/i.test(path)
    );
  }, "Use an HTML path inside the project archive");
export const introVideoRenderRequestSchema = z.strictObject({
  requestId: z.uuid(),
  projectFileId: z.uuid(),
  composition: introVideoCompositionSchema.default("index.html"),
  output: z.strictObject({
    format: z.literal("mp4"),
    resolution: z.literal("1080p"),
    fps: z.literal(30),
    quality: z.literal("standard"),
    aspectRatio: z.enum(["16:9", "9:16"]),
  }),
  title: z.string().trim().min(1).max(500).optional(),
});
export const introVideoRenderPhaseSchema = z.enum([
  "preparing",
  "submitting",
  "submission_unknown",
  "queued",
  "rendering",
  "persisting",
  "settling",
  "needs_attention",
  "completed",
  "failed",
]);
export const introVideoRenderResultSchema = z.object({
  url: artifactUrlSchema,
  filename: z.string(),
  contentType: z.literal("video/mp4"),
  size: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
});
export const introVideoRenderResponseSchema = z.object({
  generationId: z.uuid(),
  type: z.literal("video"),
  status: builtInGenerationStatusSchema,
  phase: introVideoRenderPhaseSchema,
  providerRenderId: z.string().nullable(),
  input: introVideoRenderRequestSchema,
  recovery: z.object({
    action: z.enum(["poll", "replay_submission", "manual_check", "none"]),
    retryAfterSeconds: z.number().int().positive().optional(),
    replayBefore: z.iso.datetime().optional(),
  }),
  billing: z.object({
    status: z.enum(["pending", "settled"]),
    creditsCharged: z.number().int().nonnegative().nullable(),
  }),
  result: introVideoRenderResultSchema.nullable(),
  notice: z.string().optional(),
  error: builtInGenerationErrorSchema.optional(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type IntroVideoRenderRequest = z.infer<
  typeof introVideoRenderRequestSchema
>;
export type IntroVideoRenderResponse = z.infer<
  typeof introVideoRenderResponseSchema
>;

export const introVideoRenderContract = c.router({
  create: {
    method: "POST",
    path: "/api/intro-video/renders",
    headers: authHeadersSchema,
    body: introVideoRenderRequestSchema,
    responses: {
      200: introVideoRenderResponseSchema,
      202: introVideoRenderResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Render an owned HyperFrames project using the platform HeyGen account",
  },
  get: {
    method: "GET",
    path: "/api/intro-video/renders/:generationId",
    headers: authHeadersSchema,
    pathParams: z.object({ generationId: z.uuid() }),
    responses: {
      200: introVideoRenderResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Reconcile an existing cloud render without creating another paid render",
  },
});
