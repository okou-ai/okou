import { z } from "zod";
import {
  artifactReferenceSchema,
  artifactUrlSchema,
} from "./artifact-references";

import { authHeadersSchema, initContract } from "./base";
import {
  builtInGenerationErrorSchema,
  builtInGenerationStatusSchema,
} from "./built-in-generation";
import { apiErrorSchema } from "./errors";
import {
  introVideoAvatarGroupIdSchema,
  introVideoPresenterAvatarIdSchema,
  introVideoStyleIdSchema,
  introVideoVoiceIdSchema,
} from "./intro-video-presenter";

const c = initContract();
const orientationSchema = z.enum(["landscape", "portrait"]);

// The API additionally resolves every URL against the current user's managed
// files and validates its actual MIME type before passing it to HeyGen. Stable
// API references may use a local HTTP origin; the API verifies that origin and
// ownership before converting them to signed R2 URLs.
const fileUrlSchema = z.url({ protocol: /^https?$/ }).pipe(
  z.string().refine((value) => {
    const url = new URL(value);
    if (url.username || url.password) {
      return false;
    }
    if (url.pathname === "/api/web/download-file") {
      return z.uuid().safeParse(url.searchParams.get("file_id")).success;
    }
    return (
      url.protocol === "https:" &&
      z.regexes.domain.test(url.hostname) &&
      !url.port &&
      !/\.(?:localhost|local|internal)$/.test(url.hostname)
    );
  }, "Use a managed HTTPS file URL or an authenticated artifact reference without credentials"),
);

export const introVideoAgentGenerateRequestSchema = z.object({
  requestId: z.uuid(),
  prompt: z.string().trim().min(1).max(10_000),
  styleId: introVideoStyleIdSchema,
  avatarId: introVideoPresenterAvatarIdSchema.optional(),
  avatarGroupId: introVideoAvatarGroupIdSchema.optional(),
  voiceId: introVideoVoiceIdSchema.optional(),
  orientation: orientationSchema,
  fileUrls: z
    .array(z.union([fileUrlSchema, artifactReferenceSchema]))
    .max(20)
    .optional(),
});

/**
 * A durable native Video Agent job. Nullable provider identifiers describe
 * progress without requiring a second billed submission. Completed URLs refer
 * to persisted Okou files, never temporary provider output.
 */
export const introVideoAgentResponseSchema = z.object({
  generationId: z.uuid(),
  status: builtInGenerationStatusSchema,
  sessionId: z.string().nullable(),
  videoId: z.string().nullable(),
  providerStatus: z.string().optional(),
  notice: z.string().optional(),
  error: builtInGenerationErrorSchema.optional(),
  url: artifactUrlSchema.optional(),
  privateArtifacts: z.boolean().optional(),
  filename: z.string().optional(),
  contentType: z.literal("video/mp4").optional(),
  size: z.number().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  creditsCharged: z.number().nonnegative().optional(),
  styleId: introVideoStyleIdSchema.optional(),
  avatarId: introVideoPresenterAvatarIdSchema.optional(),
  voiceId: introVideoVoiceIdSchema.optional(),
  orientation: orientationSchema.optional(),
});

export type IntroVideoAgentGenerateRequest = z.infer<
  typeof introVideoAgentGenerateRequestSchema
>;
export type IntroVideoAgentResponse = z.infer<
  typeof introVideoAgentResponseSchema
>;

export const introVideoAgentContract = c.router({
  generate: {
    method: "POST",
    path: "/api/intro-video/agent/generate",
    headers: authHeadersSchema,
    body: introVideoAgentGenerateRequestSchema,
    responses: {
      200: introVideoAgentResponseSchema,
      202: introVideoAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
      504: apiErrorSchema,
    },
    summary:
      "Submit a managed HeyGen Video Agent job with a durable request ID",
  },
  get: {
    method: "GET",
    path: "/api/intro-video/agent/:generationId",
    headers: authHeadersSchema,
    pathParams: z.object({ generationId: z.uuid() }),
    responses: {
      200: introVideoAgentResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Reconcile an existing Intro Video Agent job without resubmitting",
  },
});

export type IntroVideoAgentContract = typeof introVideoAgentContract;
