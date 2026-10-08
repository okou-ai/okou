import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { voiceIoQuotaErrorSchema } from "./voice-io-quota";

const c = initContract();

export const VOICE_IO_POLISH_MAX_TEXT_CHARS = 262_144;

export const voiceIoPolishRequestSchema = z
  .object({
    segments: z
      .array(z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS))
      .min(1)
      .max(128)
      .refine((segments) => {
        return (
          segments.reduce((total, segment) => {
            return total + segment.length;
          }, 0) <= VOICE_IO_POLISH_MAX_TEXT_CHARS
        );
      }, "Voice segments exceed the total text limit"),
    lastAssistantMessage: z
      .string()
      .trim()
      .min(1)
      .max(VOICE_IO_POLISH_MAX_TEXT_CHARS)
      .optional(),
  })
  .strict();

export const voiceIoPolishResponseSchema = z
  .object({
    text: z.string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
  })
  .strict();

export type VoiceIoPolishRequest = z.infer<typeof voiceIoPolishRequestSchema>;
export type VoiceIoPolishResponse = z.infer<typeof voiceIoPolishResponseSchema>;

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
      402: voiceIoQuotaErrorSchema,
      403: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Merge ordered voice transcripts into complete send-ready writing",
  },
});

export type VoiceIoPolishContract = typeof voiceIoPolishContract;
