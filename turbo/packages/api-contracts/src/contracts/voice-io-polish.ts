import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { voiceIoQuotaErrorSchema } from "./voice-io-quota";

const c = initContract();

export const VOICE_IO_POLISH_MAX_TEXT_CHARS = 262_144;

const assistantReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(VOICE_IO_POLISH_MAX_TEXT_CHARS)
  .optional();

export const voiceIoPolishRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
    lastAssistantMessage: assistantReferenceSchema,
  })
  .strict();

export const voiceIoPolishSegmentsRequestSchema = z
  .object({
    segments: z
      .array(z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS))
      .min(1)
      .max(128)
      .refine((segments) => {
        return (
          segments.reduce(
            (total, segment) => {
              return total + segment.length;
            },
            Math.max(0, segments.length - 1),
          ) <= VOICE_IO_POLISH_MAX_TEXT_CHARS
        );
      }, "Voice segments exceed the total text limit"),
    lastAssistantMessage: assistantReferenceSchema,
  })
  .strict();

export const voiceIoPolishResponseSchema = z
  .object({
    text: z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
  })
  .strict();

export type VoiceIoPolishRequest = z.infer<typeof voiceIoPolishRequestSchema>;
export type VoiceIoPolishSegmentsRequest = z.infer<
  typeof voiceIoPolishSegmentsRequestSchema
>;
export type VoiceIoPolishResponse = z.infer<typeof voiceIoPolishResponseSchema>;

// Preserve the live text-only caller until the replacement App floor and API
// rollback boundary allow retirement. No voice-cache compatibility is implied.
export const voiceIoPolishContract = c.router({
  post: {
    method: "POST",
    path: "/api/voice-io/polish",
    headers: authHeadersSchema,
    body: voiceIoPolishRequestSchema,
    responses: {
      200: voiceIoPolishResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Polish a raw voice transcription into send-ready writing",
  },
});

export const voiceIoPolishSegmentsContract = c.router({
  post: {
    method: "POST",
    path: "/api/voice-io/polish/segments",
    headers: authHeadersSchema,
    body: voiceIoPolishSegmentsRequestSchema,
    responses: {
      200: voiceIoPolishResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: voiceIoQuotaErrorSchema,
      403: apiErrorSchema,
      // A supported old API has no additive route; its 404 body is unspecified.
      404: z.unknown(),
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Merge ordered voice transcripts into complete send-ready writing",
  },
});

export type VoiceIoPolishContract = typeof voiceIoPolishContract;
export type VoiceIoPolishSegmentsContract =
  typeof voiceIoPolishSegmentsContract;
