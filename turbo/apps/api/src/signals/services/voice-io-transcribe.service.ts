import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
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

import { notConfigured } from "../../lib/error";
import { requestSignal$, setResHeader$ } from "../context/hono";
import { isLlmConfigured } from "../external/openrouter";
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

// Character rate is noisy for short clips, so only context-sized output can
// trigger the conservative upper bound for human speech.
const VOICE_TRANSCRIPT_MAX_CHARACTERS_PER_SECOND = 25;
const VOICE_TRANSCRIPT_MINIMUM_SUSPICIOUS_CHARACTERS = 200;

type VoiceDraftTranscriptionInput = VoiceIoTranscribeContext &
  VoiceIoTranscribeSegmentOptions & {
    readonly files: readonly File[];
    readonly model: VoiceInputModel;
    readonly debug: boolean;
    readonly audioDurationSeconds: number;
  };

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
    throw new Error("Stitched voice transcript is invalid");
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
      : providerError(
          new Error("Voice transcription exceeded a plausible speech rate"),
        );
  }
  if (
    input.final &&
    result.polishedText !== undefined &&
    exceedsPlausibleSpeechRate(result.polishedText, input.totalDurationSeconds)
  ) {
    return providerError(
      new Error("Voice polish exceeded a plausible speech rate"),
    );
  }
  if (
    input.final &&
    (hasSavedSpeech || hasTranscribedSpeech) &&
    !result.polishedText?.trim()
  ) {
    return providerError(new Error("Voice polish discarded recorded speech"));
  }
}

async function transcribeIncrementalVoice(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceIoTranscribeSegmentResponse> {
  const file = input.files[0];
  const audio = file ? await voiceAudio(file, signal) : undefined;
  if (audio && input.final && input.model.kind === "multimodal") {
    const result = await finishIncrementalVoice(
      audio,
      input,
      input.model.id,
      signal,
    );
    if (!result) {
      throw new Error("Voice transcription is not configured");
    }
    return normalizeVoiceTranscript(result);
  }
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
    throw new Error("Voice transcription is not configured");
  }
  const transcript =
    result.transcript === VOICE_NO_SPEECH ? "" : result.transcript;
  if (
    input.model.kind === "transcription" &&
    input.overlapDurationSeconds > 0 &&
    input.previousTranscript
  ) {
    const reconciled = await reconcileVoiceSegmentTranscript(
      transcript,
      input,
      input.final,
      DEFAULT_VOICE_INPUT_MODEL,
      signal,
    );
    if (!reconciled) {
      throw new Error("Voice transcription is not configured");
    }
    return normalizeVoiceTranscript(reconciled);
  }
  if (!input.final) {
    return { transcript, language: result.language };
  }
  const completeTranscript = stitchTranscripts([
    input.previousTranscript,
    transcript,
  ]);
  if (!completeTranscript) {
    return { transcript, polishedText: "", language: result.language };
  }
  const polished = await polishLongVoiceTranscript(
    completeTranscript,
    input,
    voicePolishModel(input),
    signal,
  );
  if (!polished) {
    throw new Error("Voice transcription is not configured");
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
    const generated = await settle(
      transcribeIncrementalVoice(input, requestSignal),
      signal,
    );
    requestSignal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    const rejected = rejectUnusableVoiceOutput(input, generated.value);
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
