import { command } from "ccstate";
import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  readVoiceDraftRecording,
  saveVoiceDraftProgress,
} from "../external/voice-draft-store.ts";
import type { VoiceDraftTranscriptionResult } from "./voice-draft-transcription-segment.ts";

/** Final editing owns no audio uploads; successful segment checkpoints survive retries. */
export const polishVoiceDraft$ = command(
  async (
    { get },
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
      const response = await accept(
        get(apiClient$)(voiceIoPolishContract).post({
          body: {
            segments,
            ...(progress.context.lastAssistantMessage
              ? { lastAssistantMessage: progress.context.lastAssistantMessage }
              : {}),
          },
          fetchOptions: { signal },
        }),
        [200, 402, 503],
        signal,
      );
      if (response.status === 402) {
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
