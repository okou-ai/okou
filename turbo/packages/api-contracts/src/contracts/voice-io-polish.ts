import { array, object, string, type infer as zInfer } from "zod";

import { VOICE_IO_POLISH_MAX_SEGMENTS } from "../validators/voice-io-polish";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { voiceIoQuotaErrorSchema } from "./voice-io-quota";

const c = initContract();

export const VOICE_IO_POLISH_MAX_TEXT_CHARS = 262_144;
export { VOICE_IO_POLISH_MAX_SEGMENTS };

export const voiceIoPolishSegmentsRequestSchema = object({
  segments: array(string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS))
    .min(1)
    .max(VOICE_IO_POLISH_MAX_SEGMENTS)
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
}).strict();

export const voiceIoPolishResponseSchema = object({
  text: string().trim().min(1).max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
}).strict();

export type VoiceIoPolishSegmentsRequest = zInfer<
  typeof voiceIoPolishSegmentsRequestSchema
>;
export type VoiceIoPolishResponse = zInfer<typeof voiceIoPolishResponseSchema>;

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
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Merge ordered voice transcripts into complete send-ready writing",
  },
});

export type VoiceIoPolishSegmentsContract =
  typeof voiceIoPolishSegmentsContract;
