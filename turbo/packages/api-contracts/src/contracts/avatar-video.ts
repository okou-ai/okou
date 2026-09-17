import { z } from "zod";
import { artifactUrlSchema } from "./artifact-references";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { builtInGenerationAcceptedResponseSchema } from "./built-in-generation";

const c = initContract();

export const avatarVideoAspectRatioSchema = z.enum([
  "portrait",
  "landscape",
  "square",
]);
/**
 * JoggAI background style.
 *
 * - `1` renders the avatar over its baked-in scene
 * - `2` renders it over a green screen (MP4, keyed downstream)
 * - `3` renders it with a real alpha channel (WebM)
 *
 * JoggAI's v1 documentation states that the alpha-channel WebM is only produced
 * when captions are disabled. The v2 endpoint this client calls does not repeat
 * that constraint, so it is honoured as a default rather than enforced here.
 */
export const avatarVideoScreenStyleSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export const AVATAR_VIDEO_TRANSPARENT_SCREEN_STYLE = 3;
export const avatarVideoVoiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const avatarVideoGenerateRequestSchema = z
  .object({
    /** Fail before creating bytes when private artifact creation is unavailable. */
    requirePrivateArtifact: z.boolean().optional(),
    avatarId: z.number().int().positive(),
    voiceId: avatarVideoVoiceIdSchema,
    script: z.string().trim().min(1).optional(),
    audioUrl: artifactUrlSchema.optional(),
    aspectRatio: avatarVideoAspectRatioSchema.optional(),
    screenStyle: avatarVideoScreenStyleSchema.optional(),
    caption: z.boolean().optional(),
    videoName: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => {
      return Boolean(value.script) !== Boolean(value.audioUrl);
    },
    {
      message: "Provide exactly one of script or audioUrl",
    },
  );

export const avatarVideoGenerateResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  provider: z.literal("joggai"),
  model: z.literal("joggai-talking-avatar"),
  providerVideoId: z.string(),
  avatarId: z.number().int().positive(),
  voiceId: z.string(),
  inputType: z.enum(["script", "audio"]),
  aspectRatio: avatarVideoAspectRatioSchema,
  screenStyle: avatarVideoScreenStyleSchema,
  caption: z.boolean(),
  sourceUrl: z.url().optional(),
});

export const avatarVideoAvatarSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  videoUrl: z.url().optional(),
  coverUrl: z.url().optional(),
  aspectRatio: z.number().int().optional(),
  style: z.string().optional(),
  gender: z.string().optional(),
  age: z.string().optional(),
});

export const avatarVideoVoiceSchema = z.object({
  id: avatarVideoVoiceIdSchema,
  name: z.string(),
  sampleUrl: z.url().optional(),
  language: z.string().optional(),
  gender: z.string().optional(),
  age: z.string().optional(),
  accent: z.string().optional(),
  useCase: z.string().optional(),
});

export const avatarVideoAvatarsResponseSchema = z.object({
  avatars: z.array(avatarVideoAvatarSchema),
});
export const avatarVideoVoicesResponseSchema = z.object({
  voices: z.array(avatarVideoVoiceSchema),
  hasMore: z.boolean(),
  filterOptions: z
    .object({
      languages: z.array(z.string().min(1)),
      useCases: z.array(z.string().min(1)),
    })
    .optional(),
});

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const avatarVideoAvatarsQuerySchema = pageQuerySchema.extend({
  aspectRatio: avatarVideoAspectRatioSchema.optional(),
  style: z.enum(["professional", "social"]).optional(),
  gender: z.enum(["female", "male"]).optional(),
  age: z.enum(["adult", "senior", "young_adult"]).optional(),
  scene: z
    .enum([
      "lifestyle",
      "outdoors",
      "business",
      "studio",
      "health_fitness",
      "education",
      "news",
    ])
    .optional(),
  ethnicity: z
    .enum([
      "european",
      "african",
      "south_asian",
      "east_asian",
      "middle_eastern",
      "south_american",
      "north_american",
    ])
    .optional(),
});

export const avatarVideoVoicesQuerySchema = pageQuerySchema.extend({
  gender: z.enum(["female", "male"]).optional(),
  language: z.string().min(1).optional(),
  age: z.enum(["young", "middle_aged", "old"]).optional(),
  useCase: z.string().min(1).optional(),
});

export type AvatarVideoGenerateRequest = z.infer<
  typeof avatarVideoGenerateRequestSchema
>;
export type AvatarVideoGenerateResponse = z.infer<
  typeof avatarVideoGenerateResponseSchema
>;
export type AvatarVideoAvatarsQuery = z.infer<
  typeof avatarVideoAvatarsQuerySchema
>;
export type AvatarVideoVoicesQuery = z.infer<
  typeof avatarVideoVoicesQuerySchema
>;
export type AvatarVideoAvatar = z.infer<typeof avatarVideoAvatarSchema>;
export type AvatarVideoVoice = z.infer<typeof avatarVideoVoiceSchema>;

const creationRoute = {
  method: "POST",
  path: "/api/avatar-video/generate",
  headers: authHeadersSchema,
  body: avatarVideoGenerateRequestSchema,
  responses: {
    200: avatarVideoGenerateResponseSchema,
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
  summary: "Generate and persist a JoggAI talking-avatar video",
} as const;

export const avatarVideoContract = c.router({
  generate: creationRoute,
  generatePrivate: {
    ...creationRoute,
    path: "/api/avatar-video/generate/private",
  },
  avatars: {
    method: "GET",
    path: "/api/avatar-video/avatars",
    headers: authHeadersSchema,
    query: avatarVideoAvatarsQuerySchema,
    responses: {
      200: avatarVideoAvatarsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public JoggAI avatars",
  },
  voices: {
    method: "GET",
    path: "/api/avatar-video/voices",
    headers: authHeadersSchema,
    query: avatarVideoVoicesQuerySchema,
    responses: {
      200: avatarVideoVoicesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "List public JoggAI voices",
  },
});

export type AvatarVideoContract = typeof avatarVideoContract;
