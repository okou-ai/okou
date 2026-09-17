import { command } from "ccstate";
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
} from "../external/voice-draft-store.ts";
import { voiceDraftSegmentFile } from "./voice-draft-audio.ts";

export type VoiceDraftTranscriptionResult =
  | {
      readonly kind: "transcribed";
      readonly transcript: string;
      readonly text?: string;
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

async function segmentBody(
  options: SegmentOptions,
  context: VoiceIoTranscribeContext,
  previousTranscript: string,
  signal: AbortSignal,
): Promise<FormData> {
  const body = new FormData();
  if (options.segment) {
    const audio = await readVoiceDraftAudio(options.key, options.recordingId);
    signal.throwIfAborted();
    body.append(
      "file",
      await voiceDraftSegmentFile(audio, options.segment, signal),
    );
  }
  body.append(
    "options",
    JSON.stringify({
      previousTranscript,
      final: options.segment?.final ?? true,
      totalDurationSeconds: options.totalDurationSeconds,
      overlapDurationSeconds: options.overlapDurationSeconds,
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

/** Run one ordered segment and persist its checkpoint under the session owner. */
export const transcribeVoiceDraftSegment$ = command(
  async (
    { get },
    options: SegmentOptions,
    predecessor: Promise<VoiceDraftTranscriptionResult | undefined> | undefined,
    signal: AbortSignal,
  ): Promise<VoiceDraftTranscriptionResult | undefined> => {
    const { key, recordingId, segment } = options;
    const final = segment ? segment.final : true;
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
    if (saved?.transcript !== undefined) {
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
    const body = await segmentBody(
      options,
      progress.context,
      previous.transcript,
      signal,
    );
    const result = await requestSegment(get(apiClient$), body, final, signal);
    signal.throwIfAborted();
    if (!result || result.kind === "unavailable") {
      return result;
    }
    const { transcript, text } = result;
    await saveVoiceDraftProgress(key, recordingId, {
      ...progress,
      revision: progress.revision + 1,
      segments: progress.segments.map((item) => {
        return item.endSample === segmentEnd ? { ...item, transcript } : item;
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
