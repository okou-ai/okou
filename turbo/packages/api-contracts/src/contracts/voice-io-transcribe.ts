import { number, object, string, type infer as zInfer } from "zod";

import {
  VOICE_IO_TRANSCRIBE_MAX_PREVIOUS_CHARS,
  VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS,
} from "../validators/voice-io-transcribe";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "./voice-io-polish";
import { voiceIoQuotaErrorSchema } from "./voice-io-quota";

const c = initContract();

export {
  VOICE_IO_TRANSCRIBE_MAX_PREVIOUS_CHARS,
  VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS,
};
export const VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS = 75;
const VOICE_IO_TRANSCRIBE_MAX_RECORDING_SECONDS = 60 * 60;

export const voiceIoTranscribeSegmentOptionsSchema = object({
  previousTranscript: string().max(VOICE_IO_TRANSCRIBE_MAX_PREVIOUS_CHARS),
  overlapDurationSeconds: number().min(0).max(2).default(0),
  totalDurationSeconds: number()
    .nonnegative()
    .max(VOICE_IO_TRANSCRIBE_MAX_RECORDING_SECONDS),
});

export type VoiceIoTranscribeSegmentOptions = zInfer<
  typeof voiceIoTranscribeSegmentOptionsSchema
>;

export const voiceIoEditorContextSchema = object({
  before: string().max(VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS),
  selected: string().max(VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS),
  after: string().max(VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS),
}).strict();

export type VoiceIoEditorContext = zInfer<typeof voiceIoEditorContextSchema>;

export interface VoiceIoTranscribeContext {
  readonly editorContext?: VoiceIoEditorContext;
  readonly previousTranscript?: string;
}

export const voiceIoTranscribeSegmentResponseSchema = object({
  transcript: string().max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
  language: string().trim().min(1).max(64),
}).strict();

export type VoiceIoTranscribeSegmentResponse = zInfer<
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
    summary: "Transcribe a voice draft segment",
  },
});

export type VoiceIoTranscribeContract = typeof voiceIoTranscribeContract;
