import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import type {
  VoiceIoTranscribeContext,
  VoiceIoTranscribeSegmentOptions,
  VoiceIoTranscribeSegmentResponse,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import {
  DEFAULT_VOICE_INPUT_MODEL,
  type MultimodalVoiceInputModelId,
  type VoiceInputModel,
} from "@okouai/api-contracts/contracts/voice-input-models";
import { command } from "ccstate";
import { isSpanContextValid, trace } from "@opentelemetry/api";

import { env } from "../../lib/env";
import { notConfigured } from "../../lib/error";
import { logger } from "../../lib/log";
import { request$, requestSignal$, setResHeader$ } from "../context/hono";
import {
  isLlmConfigured,
  OpenRouterRequestError,
} from "../external/openrouter";
import {
  VOICE_NO_SPEECH,
  polishLongVoiceTranscript,
  transcribeVoice,
  finishIncrementalVoice,
  reconcileVoiceSegmentTranscript,
} from "../external/voice-completion";
import {
  isVoiceTranscriptionConfigured,
  transcribeVoiceInputAudio,
} from "../external/voice-input-transcription";
import { settle } from "../utils";
import { GcpLlmAuthError, gcpLlmConfiguration } from "../external/gcp-llm-auth";
import { isVertexVoiceModel, VertexVoiceError } from "../external/vertex-voice";
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
    readonly model: VoiceInputModel;
    readonly debug: boolean;
    readonly audioDurationSeconds: number;
  };

type VoiceDiagnosticModel = VoiceInputModel | MultimodalVoiceInputModelId;

interface VoiceTranscriptionAttempt {
  stage:
    | "audio_read"
    | "transcription"
    | "finalization"
    | "reconciliation"
    | "stitching"
    | "polish"
    | "output_validation";
  model: VoiceDiagnosticModel | undefined;
  transcriptModel: VoiceDiagnosticModel;
  transcriptCharacters?: number;
}

function voiceModelFields(model: VoiceDiagnosticModel | undefined) {
  if (model === undefined) {
    return {};
  }
  const id = typeof model === "string" ? model : model.id;
  const multimodal =
    typeof model === "string"
      ? model
      : model.kind === "multimodal"
        ? model.id
        : undefined;
  return {
    model: id,
    provider: multimodal
      ? isVertexVoiceModel(multimodal)
        ? "vertex"
        : "openrouter"
      : id === "fal-ai/elevenlabs/speech-to-text/scribe-v2"
        ? "fal"
        : "openrouter",
  };
}

async function emitVoiceFailure(
  input: VoiceDraftTranscriptionInput,
  attempt: VoiceTranscriptionAttempt,
  error: unknown,
  clientRequestId: string | undefined,
  result?: VoiceIoTranscribeSegmentResponse,
): Promise<void> {
  // These boundaries already own the terminal record for their error.
  if (
    error instanceof GcpLlmAuthError ||
    error instanceof VertexVoiceError ||
    error instanceof VoiceProviderUnavailableError ||
    error instanceof OpenRouterRequestError ||
    (error instanceof VoiceResponseError &&
      error.diagnosticOwner === "provider")
  ) {
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
      reason: error instanceof VoiceResponseError ? error.reason : "unknown",
      ...voiceModelFields(attempt.model),
      input_model: input.model.id,
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

function voicePolishModel(
  input: VoiceDraftTranscriptionInput,
): MultimodalVoiceInputModelId {
  // GPT Audio requires audio input. Finalization without a remaining audio
  // segment uses the shared text-capable polish model.
  if (
    input.model.kind === "transcription" ||
    (input.files.length === 0 &&
      (input.model.id === "openai/gpt-audio" ||
        input.model.id === "openai/gpt-audio-mini"))
  ) {
    return DEFAULT_VOICE_INPUT_MODEL;
  }
  return input.model.id;
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

function stitchTranscripts(pieces: readonly string[]): string {
  const transcript = pieces
    .map((piece) => {
      return piece.trim();
    })
    .filter((text) => {
      return text !== VOICE_NO_SPEECH;
    })
    .join(" ")
    .trim();
  if (transcript.length > VOICE_IO_POLISH_MAX_TEXT_CHARS) {
    throw new VoiceResponseError("stitched_transcript_too_large");
  }
  return transcript;
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
  const audio = file ? await voiceAudio(file, signal) : undefined;
  if (audio && input.final && input.model.kind === "multimodal") {
    attempt.stage = "finalization";
    attempt.model = input.model;
    const result = await finishIncrementalVoice(
      audio,
      input,
      input.model.id,
      signal,
    );
    if (!result) {
      throw new VoiceResponseError("not_configured");
    }
    return normalizeVoiceTranscript(result);
  }
  attempt.stage = "transcription";
  attempt.model = audio ? input.model : undefined;
  const result = audio
    ? input.model.kind === "transcription"
      ? {
          transcript: await transcribeVoiceInputAudio(
            input.model,
            audio,
            signal,
          ),
          language: "und",
        }
      : await transcribeVoice(audio, input, input.model.id, signal)
    : { transcript: "", language: "und" };
  if (!result) {
    throw new VoiceResponseError("not_configured");
  }
  const transcript =
    result.transcript === VOICE_NO_SPEECH ? "" : result.transcript;
  attempt.transcriptCharacters = transcript.trim().length;
  if (
    input.model.kind === "transcription" &&
    input.overlapDurationSeconds > 0 &&
    input.previousTranscript
  ) {
    attempt.stage = "reconciliation";
    attempt.model = DEFAULT_VOICE_INPUT_MODEL;
    attempt.transcriptModel = DEFAULT_VOICE_INPUT_MODEL;
    const reconciled = await reconcileVoiceSegmentTranscript(
      transcript,
      input,
      input.final,
      DEFAULT_VOICE_INPUT_MODEL,
      signal,
    );
    if (!reconciled) {
      throw new VoiceResponseError("not_configured");
    }
    return normalizeVoiceTranscript(reconciled);
  }
  if (!input.final) {
    return { transcript, language: result.language };
  }
  attempt.stage = "stitching";
  attempt.model = undefined;
  const completeTranscript = stitchTranscripts([
    input.previousTranscript,
    transcript,
  ]);
  if (!completeTranscript) {
    return { transcript, polishedText: "", language: result.language };
  }
  attempt.stage = "polish";
  attempt.model = voicePolishModel(input);
  const polished = await polishLongVoiceTranscript(
    completeTranscript,
    input,
    voicePolishModel(input),
    signal,
  );
  if (!polished) {
    throw new VoiceResponseError("not_configured");
  }
  return {
    transcript,
    ...polished,
    polishedText:
      polished.polishedText === VOICE_NO_SPEECH ? "" : polished.polishedText,
  };
}

function voiceProvidersConfigured(
  input: VoiceDraftTranscriptionInput,
): boolean {
  const audio = input.files.length > 0;
  if (
    audio &&
    input.model.kind === "transcription" &&
    !isVoiceTranscriptionConfigured(input.model)
  ) {
    return false;
  }
  if (
    audio &&
    input.model.kind === "multimodal" &&
    !isVertexVoiceModel(input.model.id) &&
    !isLlmConfigured()
  ) {
    return false;
  }
  const gemini =
    (input.model.kind === "multimodal" && isVertexVoiceModel(input.model.id)) ||
    (input.final && isVertexVoiceModel(voicePolishModel(input))) ||
    (audio &&
      input.model.kind === "transcription" &&
      input.overlapDurationSeconds > 0 &&
      Boolean(input.previousTranscript));
  return !gemini || gcpLlmConfiguration() !== undefined;
}

export const transcribeVoiceSegment$ = command(
  async (
    { get, set },
    input: VoiceDraftTranscriptionInput,
    signal: AbortSignal,
  ) => {
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    if (!voiceProvidersConfigured(input)) {
      return notConfigured("Voice transcription is not configured");
    }
    if (input.debug) {
      set(setResHeader$, "X-Voice-Input-Model", input.model.id);
      if (input.final) {
        set(setResHeader$, "X-Voice-Polish-Model", voicePolishModel(input));
      }
      set(
        setResHeader$,
        "Access-Control-Expose-Headers",
        "Server-Timing, X-Voice-Input-Model, X-Voice-Polish-Model",
        { append: true },
      );
    }
    const startedAt = performance.now();
    const attempt: VoiceTranscriptionAttempt = {
      stage: "audio_read",
      model: undefined,
      transcriptModel: input.model,
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
      attempt.model =
        rejected.reason === "transcription_rate_exceeded"
          ? attempt.transcriptModel
          : voicePolishModel(input);
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
