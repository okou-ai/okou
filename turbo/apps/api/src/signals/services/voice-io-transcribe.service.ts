import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import type {
  VoiceIoTranscribeContext,
  VoiceIoTranscribeSegmentOptions,
  VoiceIoTranscribeSegmentResponse,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { command } from "ccstate";
import { isSpanContextValid, trace } from "@opentelemetry/api";

import { env } from "../../lib/env";
import { notConfigured } from "../../lib/error";
import { logger } from "../../lib/log";
import { request$, requestSignal$, setResHeader$ } from "../context/hono";
import {
  VOICE_NO_SPEECH,
  polishLongVoiceTranscript,
  transcribeVoice,
  finishIncrementalVoice,
} from "../external/voice-completion";
import { settle } from "../utils";
import { GcpLlmAuthError, gcpLlmConfiguration } from "../external/gcp-llm-auth";
import {
  VOICE_INPUT_MODEL,
  vertexVoiceDiagnosticFields,
  VertexVoiceError,
} from "../external/vertex-voice";
import type { VoiceAudio } from "../external/voice-completion-types";
import { VoiceProviderUnavailableError } from "../external/voice-provider-request";
import { VoiceResponseError } from "../external/voice-response-error";

const L = logger("VoiceSegment");

// Character rate is noisy for short clips, so only context-sized output can
// trigger the conservative upper bound for human speech.
const VOICE_TRANSCRIPT_MAX_CHARACTERS_PER_SECOND = 25;
const VOICE_TRANSCRIPT_MINIMUM_SUSPICIOUS_CHARACTERS = 100;

type VoiceDraftTranscriptionInput = VoiceIoTranscribeContext &
  VoiceIoTranscribeSegmentOptions & {
    readonly files: readonly File[];
    readonly debug: boolean;
    readonly audioDurationSeconds: number;
  };

interface VoiceTranscriptionAttempt {
  stage:
    | "audio_read"
    | "transcription"
    | "finalization"
    | "polish"
    | "output_validation";
  /** Whether the failed stage called the voice model. */
  modelCall: boolean;
  transcriptCharacters?: number;
}

function hasExistingVoiceFailureOwner(error: unknown): boolean {
  return (
    error instanceof GcpLlmAuthError ||
    (error instanceof VertexVoiceError &&
      error.diagnosticOwner === "provider") ||
    error instanceof VoiceProviderUnavailableError
  );
}

function voiceFailureReason(error: unknown): string {
  return error instanceof VoiceResponseError ||
    error instanceof VertexVoiceError
    ? error.reason
    : "unknown";
}

function vertexFailureFields(error: unknown) {
  return error instanceof VertexVoiceError
    ? vertexVoiceDiagnosticFields(error)
    : {};
}

async function emitVoiceFailure(
  input: VoiceDraftTranscriptionInput,
  attempt: VoiceTranscriptionAttempt,
  error: unknown,
  clientRequestId: string | undefined,
  result?: VoiceIoTranscribeSegmentResponse,
): Promise<void> {
  // These boundaries already own the terminal record for their error.
  if (hasExistingVoiceFailureOwner(error)) {
    return;
  }
  const span = trace.getActiveSpan()?.spanContext();
  const deployment = env("GIT_COMMIT_SHA");
  const transcriptCharacters =
    result?.transcript.trim().length ?? attempt.transcriptCharacters;
  // The caller settles this emission, including synchronous/abort-shaped sink
  // failures. Request middleware retains ownership of the asynchronous flush.
  await Promise.resolve(
    L.warn("Voice segment transcription failed", {
      type: "voice_transcription_failure",
      stage: attempt.stage,
      reason: voiceFailureReason(error),
      ...(attempt.modelCall
        ? { model: VOICE_INPUT_MODEL, provider: "vertex" }
        : {}),
      ...vertexFailureFields(error),
      final: input.final,
      has_audio: input.files.length > 0,
      audio_duration_seconds: input.audioDurationSeconds,
      total_duration_seconds: input.totalDurationSeconds,
      previous_transcript_chars: input.previousTranscript.trim().length,
      ...(transcriptCharacters === undefined
        ? {}
        : { transcript_chars: transcriptCharacters }),
      ...(result?.polishedText === undefined
        ? {}
        : { polished_chars: result.polishedText.trim().length }),
      ...(span && isSpanContextValid(span) ? { trace_id: span.traceId } : {}),
      ...(clientRequestId &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(clientRequestId)
        ? { x_client_request_id: clientRequestId }
        : {}),
      ...(/^[0-9a-f]{40}$/iu.test(deployment)
        ? { deployment_commit_sha: deployment }
        : {}),
    }),
  );
}

function transcriptionError<Status extends number>(
  status: Status,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } } as const;
}

function providerError(error: unknown) {
  if (error instanceof VoiceProviderUnavailableError) {
    return transcriptionError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Speech recognition is temporarily busy. Please retry in a moment.",
    );
  }
  if (
    (error instanceof GcpLlmAuthError || error instanceof VertexVoiceError) &&
    error.temporary
  ) {
    return transcriptionError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Voice draft transcription is temporarily unavailable",
    );
  }
  return transcriptionError(
    502,
    "VOICE_TRANSCRIPTION_FAILED",
    "Voice draft transcription failed to produce a usable response",
  );
}

async function voiceAudio(
  file: File,
  signal: AbortSignal,
): Promise<VoiceAudio> {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  return {
    data: Buffer.from(bytes).toString("base64"),
    format: "wav",
  };
}

function normalizeVoiceTranscript(
  result: VoiceIoTranscribeSegmentResponse,
): VoiceIoTranscribeSegmentResponse {
  return {
    ...result,
    transcript: result.transcript === VOICE_NO_SPEECH ? "" : result.transcript,
    ...(result.polishedText === VOICE_NO_SPEECH ? { polishedText: "" } : {}),
  };
}

function exceedsPlausibleSpeechRate(
  text: string,
  durationSeconds: number,
): boolean {
  const characters = text.trim().length;
  return (
    durationSeconds > 0 &&
    characters >= VOICE_TRANSCRIPT_MINIMUM_SUSPICIOUS_CHARACTERS &&
    characters / durationSeconds > VOICE_TRANSCRIPT_MAX_CHARACTERS_PER_SECOND
  );
}

function rejectUnusableVoiceOutput(
  input: VoiceDraftTranscriptionInput,
  result: VoiceIoTranscribeSegmentResponse,
) {
  const hasSavedSpeech = Boolean(input.previousTranscript.trim());
  const hasTranscribedSpeech = Boolean(result.transcript.trim());
  if (input.final && !hasSavedSpeech && !hasTranscribedSpeech) {
    return { status: 204 as const, body: undefined };
  }
  if (
    exceedsPlausibleSpeechRate(result.transcript, input.audioDurationSeconds)
  ) {
    return input.final && !hasSavedSpeech
      ? { status: 204 as const, body: undefined }
      : new VoiceResponseError("transcription_rate_exceeded");
  }
  if (
    input.final &&
    result.polishedText !== undefined &&
    exceedsPlausibleSpeechRate(result.polishedText, input.totalDurationSeconds)
  ) {
    return new VoiceResponseError("polish_rate_exceeded");
  }
  if (
    input.final &&
    (hasSavedSpeech || hasTranscribedSpeech) &&
    !result.polishedText?.trim()
  ) {
    return new VoiceResponseError("polish_discarded_speech");
  }
}

async function transcribeIncrementalVoice(
  input: VoiceDraftTranscriptionInput,
  attempt: VoiceTranscriptionAttempt,
  signal: AbortSignal,
): Promise<VoiceIoTranscribeSegmentResponse> {
  const file = input.files[0];
  if (!file) {
    // Only a final request may omit audio; it polishes the saved prefix.
    const saved = input.previousTranscript.trim();
    if (!saved) {
      return { transcript: "", polishedText: "", language: "und" };
    }
    attempt.stage = "polish";
    attempt.modelCall = true;
    const polished = await polishLongVoiceTranscript(saved, input, signal);
    if (!polished) {
      throw new VoiceResponseError("not_configured");
    }
    return normalizeVoiceTranscript({ transcript: "", ...polished });
  }
  const audio = await voiceAudio(file, signal);
  attempt.modelCall = true;
  if (input.final) {
    attempt.stage = "finalization";
    const result = await finishIncrementalVoice(audio, input, signal);
    if (!result) {
      throw new VoiceResponseError("not_configured");
    }
    return normalizeVoiceTranscript(result);
  }
  attempt.stage = "transcription";
  const result = await transcribeVoice(audio, input, signal);
  if (!result) {
    throw new VoiceResponseError("not_configured");
  }
  const transcript =
    result.transcript === VOICE_NO_SPEECH ? "" : result.transcript;
  attempt.transcriptCharacters = transcript.trim().length;
  return { transcript, language: result.language };
}

export const transcribeVoiceSegment$ = command(
  async (
    { get, set },
    input: VoiceDraftTranscriptionInput,
    signal: AbortSignal,
  ) => {
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    if (gcpLlmConfiguration() === undefined) {
      return notConfigured("Voice transcription is not configured");
    }
    if (input.debug) {
      set(setResHeader$, "Access-Control-Expose-Headers", "Server-Timing", {
        append: true,
      });
    }
    const startedAt = performance.now();
    const attempt: VoiceTranscriptionAttempt = {
      stage: "audio_read",
      modelCall: false,
    };
    const generated = await settle(
      transcribeIncrementalVoice(input, attempt, requestSignal),
      signal,
    );
    requestSignal.throwIfAborted();
    if (!generated.ok) {
      await Promise.allSettled([
        emitVoiceFailure(
          input,
          attempt,
          generated.error,
          get(request$).header(CLIENT_REQUEST_ID_HEADER),
        ),
      ]);
      signal.throwIfAborted();
      requestSignal.throwIfAborted();
      return providerError(generated.error);
    }
    const rejected = rejectUnusableVoiceOutput(input, generated.value);
    if (rejected instanceof VoiceResponseError) {
      attempt.stage = "output_validation";
      attempt.modelCall = true;
      await Promise.allSettled([
        emitVoiceFailure(
          input,
          attempt,
          rejected,
          get(request$).header(CLIENT_REQUEST_ID_HEADER),
          generated.value,
        ),
      ]);
      signal.throwIfAborted();
      requestSignal.throwIfAborted();
      return providerError(rejected);
    }
    if (rejected) {
      return rejected;
    }
    if (input.debug) {
      set(
        setResHeader$,
        "Server-Timing",
        `voice_segment;dur=${(performance.now() - startedAt).toFixed(2)}`,
        { append: true },
      );
    }
    if (
      !generated.value.transcript &&
      (!input.final || !generated.value.polishedText)
    ) {
      return { status: 204 as const, body: undefined };
    }
    return { status: 200 as const, body: generated.value };
  },
);
