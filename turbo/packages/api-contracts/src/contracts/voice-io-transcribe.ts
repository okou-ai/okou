import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "./voice-io-polish";
import { voiceIoQuotaErrorSchema } from "./voice-io-quota";

const c = initContract();

export const VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS = 8_000;
export const VOICE_IO_TRANSCRIBE_MAX_PREVIOUS_CHARS = 1_000;
export const VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS = 1_000;
export const VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS = 75;
const VOICE_IO_TRANSCRIBE_MAX_RECORDING_SECONDS = 60 * 60;

export const voiceIoTranscribeSegmentOptionsSchema = z.object({
  // Live old Apps send their accumulated prefix. Bound the model context at
  // the service boundary; retire after the live App floor and API rollback gate.
  previousTranscript: z.string().max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
  final: z.boolean().optional(),
  overlapDurationSeconds: z.number().min(0).max(2).default(0),
  totalDurationSeconds: z
    .number()
    .nonnegative()
    .max(VOICE_IO_TRANSCRIBE_MAX_RECORDING_SECONDS),
});

export type VoiceIoTranscribeSegmentOptions = z.infer<
  typeof voiceIoTranscribeSegmentOptionsSchema
>;

export const voiceIoEditorContextSchema = z
  .object({
    before: z.string().max(VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS),
    selected: z.string().max(VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS),
    after: z.string().max(VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS),
  })
  .strict();

export type VoiceIoEditorContext = z.infer<typeof voiceIoEditorContextSchema>;

export interface VoiceIoTranscribeContext {
  readonly lastAssistantMessage?: string;
  readonly editorContext?: VoiceIoEditorContext;
  readonly previousTranscript?: string;
}

export const voiceIoTranscribeSegmentResponseSchema = z
  .object({
    transcript: z.string().max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
    polishedText: z.string().max(VOICE_IO_POLISH_MAX_TEXT_CHARS).optional(),
    language: z.string().trim().min(1).max(64),
  })
  .strict();

export type VoiceIoTranscribeSegmentResponse = z.infer<
  typeof voiceIoTranscribeSegmentResponseSchema
>;

export const voiceIoTranscribeContract = c.router({
  segment: {
    method: "POST",
    path: "/api/voice-io/transcribe/segment",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: voiceIoTranscribeSegmentResponseSchema,
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: voiceIoQuotaErrorSchema,
      403: apiErrorSchema,
      429: voiceIoQuotaErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Transcribe a segment and retain existing final callers during rollout",
  },
});

export type VoiceIoTranscribeContract = typeof voiceIoTranscribeContract;
