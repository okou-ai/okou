import { command } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import {
  analyzeVoiceActivity,
  VOICE_ACTIVITY_POLICY_VERSION,
} from "../../lib/voice-io/voice-activity.ts";
import { settle } from "../utils.ts";
import {
  voiceIoTranscribeContract,
  type VoiceIoTranscribeContext,
  type VoiceIoTranscribeSegmentResponse,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import {
  readVoiceDraftRecording,
  readVoiceDraftAudio,
  saveVoiceDraftProgress,
  type VoiceDraftSegment,
  type VoiceDraftProgress,
} from "../external/voice-draft-store.ts";
import { voiceDraftSegmentSamples } from "./voice-draft-audio.ts";
import {
  encodeVoiceDraftPcmWav,
  VOICE_DRAFT_PCM_SAMPLE_RATE,
} from "./voice-draft-pcm.ts";

export type VoiceDraftTranscriptionResult =
  | {
      readonly kind: "transcribed";
      readonly transcript: string;
      readonly text?: string;
      readonly vadPolicyVersion?: string;
    }
  | { readonly kind: "unavailable"; readonly message: string };

interface SegmentOptions {
  readonly key: string;
  readonly recordingId: string;
  readonly context: VoiceIoTranscribeContext;
  readonly segment?: VoiceDraftSegment;
  readonly totalDurationSeconds: number;
  readonly overlapDurationSeconds: number;
}

function segmentBody(
  options: SegmentOptions,
  context: VoiceIoTranscribeContext,
  previousTranscript: string,
  file: File | undefined,
): FormData {
  const body = new FormData();
  if (file) {
    body.append("file", file);
  }
  body.append(
    "options",
    JSON.stringify({
      previousTranscript,
      final: options.segment?.final ?? true,
      totalDurationSeconds: options.totalDurationSeconds,
      overlapDurationSeconds: file ? options.overlapDurationSeconds : 0,
    }),
  );
  if (context.lastAssistantMessage) {
    body.append("lastAssistantMessage", context.lastAssistantMessage);
  }
  if (context.editorContext) {
    body.append("editorContext", JSON.stringify(context.editorContext));
  }
  return body;
}

function completedText(
  final: boolean,
  response: VoiceIoTranscribeSegmentResponse | undefined,
): string | undefined {
  if (!final) {
    return;
  }
  if (!response) {
    return "";
  }
  if (!response.polishedText?.trim()) {
    throw new Error("Final voice transcription returned no polished text");
  }
  return response.polishedText;
}

async function requestSegment(
  createClient: ApiClientFactory,
  body: FormData,
  final: boolean,
  signal: AbortSignal,
): Promise<VoiceDraftTranscriptionResult | undefined> {
  const result = await accept(
    createClient(voiceIoTranscribeContract).segment({
      body,
      fetchOptions: { signal },
    }),
    [200, 204, 402, 429, 503],
    signal,
  );
  signal.throwIfAborted();
  if (result.status === 402 || result.status === 429) {
    return;
  }
  if (result.status === 503) {
    if (result.body.error.code === "PROVIDER_UNAVAILABLE") {
      return { kind: "unavailable", message: result.body.error.message };
    }
    // Only classified provider unavailability is a recovery outcome.
    return await accept(Promise.resolve(result), [200], signal);
  }
  return {
    kind: "transcribed",
    transcript: result.status === 200 ? result.body.transcript : "",
    text: completedText(final, result.status === 200 ? result.body : undefined),
  };
}

async function transcribePreparedSegment(
  createClient: ApiClientFactory,
  options: SegmentOptions,
  context: VoiceIoTranscribeContext,
  previousTranscript: string,
  signal: AbortSignal,
): Promise<VoiceDraftTranscriptionResult | undefined> {
  const { segment } = options;
  let file: File | undefined;
  let vadPolicyVersion: string | undefined;
  if (segment) {
    const audio = await readVoiceDraftAudio(options.key, options.recordingId);
    signal.throwIfAborted();
    const samples = await voiceDraftSegmentSamples(audio, segment, signal);
    // The overlap is earlier audio, not evidence that this segment adds speech.
    const newSamples = samples.subarray(
      Math.round(options.overlapDurationSeconds * VOICE_DRAFT_PCM_SAMPLE_RATE),
    );
    const detected = await settle(
      analyzeVoiceActivity(newSamples, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!detected.ok) {
      return {
        kind: "unavailable",
        message: i18n.t(($) => {
          return $.chat.voice.detectionFailed;
        }),
      };
    }
    if (detected.value === "no_speech") {
      vadPolicyVersion = VOICE_ACTIVITY_POLICY_VERSION;
      if (!segment.final || !previousTranscript.trim()) {
        return {
          kind: "transcribed",
          transcript: "",
          ...(segment.final ? { text: "" } : {}),
          vadPolicyVersion,
        };
      }
      // A silent tail still finalizes all earlier speech using the existing
      // no-audio polish endpoint contract. Never discard the saved prefix.
    } else {
      file = new File(
        [encodeVoiceDraftPcmWav(samples)],
        `voice-draft-${String(segment.startSample)}.wav`,
        { type: "audio/wav" },
      );
    }
  }
  const body = segmentBody(options, context, previousTranscript, file);
  const result = await requestSegment(
    createClient,
    body,
    segment?.final ?? true,
    signal,
  );
  return result?.kind === "transcribed"
    ? { ...result, ...(vadPolicyVersion ? { vadPolicyVersion } : {}) }
    : result;
}

function hasReusableTranscript(
  segment: VoiceDraftSegment | undefined,
): segment is VoiceDraftSegment & { readonly transcript: string } {
  return (
    segment?.transcript !== undefined &&
    (segment.vadPolicyVersion === undefined ||
      segment.vadPolicyVersion === VOICE_ACTIVITY_POLICY_VERSION)
  );
}

function invalidateStaleVadCompletion(
  progress: VoiceDraftProgress,
): VoiceDraftProgress {
  if (
    progress.segments.some((item) => {
      return (
        item.vadPolicyVersion !== undefined &&
        item.vadPolicyVersion !== VOICE_ACTIVITY_POLICY_VERSION
      );
    })
  ) {
    return {
      revision: progress.revision,
      context: progress.context,
      segments: progress.segments,
    };
  }
  return progress;
}

/** Run one ordered segment and persist its checkpoint under the session owner. */
export const transcribeVoiceDraftSegment$ = command(
  async (
    { get },
    options: SegmentOptions,
    predecessor: Promise<VoiceDraftTranscriptionResult | undefined> | undefined,
    signal: AbortSignal,
  ): Promise<VoiceDraftTranscriptionResult | undefined> => {
    const { key, recordingId, segment } = options;
    const segmentEnd = segment?.endSample;
    const previous = predecessor
      ? await predecessor
      : { kind: "transcribed" as const, transcript: "" };
    signal.throwIfAborted();
    // An exhausted quota stops the rest of the chain until an explicit retry.
    if (!previous) {
      return;
    }
    if (previous.kind === "unavailable") {
      return previous;
    }
    const recording = await readVoiceDraftRecording(key);
    signal.throwIfAborted();
    if (recording?.id !== recordingId) {
      throw new Error("Voice recording changed during transcription");
    }
    let progress = recording.progress ?? {
      revision: 0,
      context: options.context,
      segments: [],
    };
    // A policy change invalidates the final text as well as locally skipped
    // segments. Recheck them before reusing an interrupted completion.
    progress = invalidateStaleVadCompletion(progress);
    if (progress.text !== undefined) {
      return {
        kind: "transcribed",
        transcript: previous.transcript,
        text: progress.text,
      };
    }
    const saved = progress.segments.find((item) => {
      return item.endSample === segmentEnd;
    });
    if (hasReusableTranscript(saved)) {
      return {
        kind: "transcribed",
        transcript: [previous.transcript, saved.transcript]
          .filter(Boolean)
          .join(" "),
      };
    }
    if (!segment && !previous.transcript) {
      return { kind: "transcribed", transcript: "", text: "" };
    }
    if (segment && !saved) {
      progress = {
        ...progress,
        revision: progress.revision + 1,
        segments: [...progress.segments, segment],
      };
      // Persist the boundary before HTTP so retries use the same audio bytes.
      await saveVoiceDraftProgress(key, recordingId, progress);
      signal.throwIfAborted();
    }
    const result = await transcribePreparedSegment(
      get(apiClient$),
      options,
      progress.context,
      previous.transcript,
      signal,
    );
    signal.throwIfAborted();
    if (!result || result.kind === "unavailable") {
      return result;
    }
    const { transcript, text } = result;
    await saveVoiceDraftProgress(key, recordingId, {
      ...progress,
      revision: progress.revision + 1,
      segments: progress.segments.map((item) => {
        return item.endSample === segmentEnd
          ? { ...item, transcript, vadPolicyVersion: result.vadPolicyVersion }
          : item;
      }),
      ...(text === undefined ? {} : { text }),
    });
    signal.throwIfAborted();
    return {
      kind: "transcribed",
      transcript: [previous.transcript, transcript].filter(Boolean).join(" "),
      ...(text === undefined ? {} : { text }),
    };
  },
);
