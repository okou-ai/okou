import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const voiceIoSpeechRequestSchema = z
  .object({
    /** Fail before creating bytes when private artifact creation is unavailable. */
    requirePrivateArtifact: z.boolean().optional(),
    text: z.string().optional(),
    voice: z.string().optional(),
    instructions: z.string().optional(),
  })
  .passthrough();

export const voiceIoSpeechResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  url: z.string(),
  durationSeconds: z.number(),
  creditsCharged: z.number(),
  model: z.string(),
  voice: z.string(),
});

export type VoiceIoSpeechRequest = z.infer<typeof voiceIoSpeechRequestSchema>;
export type VoiceIoSpeechResponse = z.infer<typeof voiceIoSpeechResponseSchema>;

const creationRoute = {
  method: "POST",
  path: "/api/voice-io/speech",
  headers: authHeadersSchema,
  body: voiceIoSpeechRequestSchema,
  responses: {
    200: voiceIoSpeechResponseSchema,
    400: apiErrorSchema,
    401: apiErrorSchema,
    402: apiErrorSchema,
    403: apiErrorSchema,
    500: apiErrorSchema,
    502: apiErrorSchema,
    503: apiErrorSchema,
  },
  summary: "Generate and persist WAV speech audio",
} as const;

export const voiceIoSpeechContract = c.router({
  post: creationRoute,
  postPrivate: {
    ...creationRoute,
    path: "/api/voice-io/speech/private",
  },
});

export type VoiceIoSpeechContract = typeof voiceIoSpeechContract;
