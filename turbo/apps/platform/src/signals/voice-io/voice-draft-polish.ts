import { command } from "ccstate";
import {
  voiceIoPolishSegmentsContract,
  type VoiceIoPolishSegmentsRequest,
} from "@okouai/api-contracts/contracts/voice-io-polish";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { VOICE_DRAFT_PCM_SAMPLE_RATE } from "./voice-draft-pcm.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  readVoiceDraftRecording,
  saveVoiceDraftProgress,
} from "../external/voice-draft-store.ts";
import type { VoiceDraftTranscriptionResult } from "./voice-draft-transcription-segment.ts";

const requestPolish$ = command(
  async (
    { get },
    body: VoiceIoPolishSegmentsRequest,
    totalDurationSeconds: number,
    signal: AbortSignal,
  ) => {
    const response = await accept(
      get(apiClient$)(voiceIoPolishSegmentsContract).post({
        body,
        fetchOptions: { signal },
      }),
      [200, 402, 404, 503],
      signal,
    );
    if (response.status !== 404) {
      return response;
    }
    // New Web -> old API: only a missing additive route uses the existing
    // text-only final request. Retire after older APIs leave serving/rollback.
    // It preserves their recording quota writer without re-uploading audio.
    const form = new FormData();
    form.append(
      "options",
      JSON.stringify({
        previousTranscript: body.segments.join(" "),
        final: true,
        totalDurationSeconds,
        overlapDurationSeconds: 0,
      }),
    );
    if (body.lastAssistantMessage) {
      form.append("lastAssistantMessage", body.lastAssistantMessage);
    }
    const legacy = await accept(
      get(apiClient$)(voiceIoTranscribeContract).segment({
        body: form,
        fetchOptions: { signal },
      }),
      [200, 204, 402, 429, 503],
      signal,
    );
    if (legacy.status === 200) {
      if (!legacy.body.polishedText?.trim()) {
        throw new Error("Voice completion discarded the saved speech");
      }
      return { status: 200 as const, body: { text: legacy.body.polishedText } };
    }
    if (legacy.status === 204) {
      throw new Error("Voice completion discarded the saved speech");
    }
    return legacy;
  },
);

/** Final editing owns no audio uploads; successful segment checkpoints survive retries. */
export const polishVoiceDraft$ = command(
  async (
    { set },
    key: string,
    recordingId: string,
    signal: AbortSignal,
  ): Promise<VoiceDraftTranscriptionResult | undefined> => {
    const recording = await readVoiceDraftRecording(key);
    signal.throwIfAborted();
    if (recording?.id !== recordingId) {
      throw new Error("Voice recording changed before polish");
    }
    const progress = recording.progress;
    if (!progress) {
      if (recording.sampleCount === 0) {
        return { kind: "transcribed", transcript: "", text: "" };
      }
      throw new Error("Voice polish requires transcription progress");
    }
    const segments = progress.segments
      .map((segment) => {
        if (segment.transcript === undefined) {
          throw new Error("Voice polish requires all segment transcripts");
        }
        return segment.transcript;
      })
      .filter((text) => {
        return Boolean(text.trim());
      });
    const transcript = segments.join(" ");
    if (progress.text !== undefined) {
      return { kind: "transcribed", transcript, text: progress.text };
    }
    let text = "";
    if (segments.length > 0) {
      const response = await set(
        requestPolish$,
        {
          segments,
          ...(progress.context.lastAssistantMessage
            ? { lastAssistantMessage: progress.context.lastAssistantMessage }
            : {}),
        },
        recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE,
        signal,
      );
      if (response.status === 402 || response.status === 429) {
        return;
      }
      if (response.status === 503) {
        if (response.body.error.code !== "PROVIDER_UNAVAILABLE") {
          return await accept(Promise.resolve(response), [200], signal);
        }
        return { kind: "unavailable", message: response.body.error.message };
      }
      text = response.body.text;
    }
    signal.throwIfAborted();
    await saveVoiceDraftProgress(key, recordingId, {
      ...progress,
      revision: progress.revision + 1,
      text,
    });
    signal.throwIfAborted();
    return { kind: "transcribed", transcript, text };
  },
);
