import { command, state, type Command, type Computed } from "ccstate";
import type { VoiceIoTranscribeContext } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import {
  readVoiceDraftRecording,
  type VoiceDraftSegment,
} from "../external/voice-draft-store.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
import { nextVoiceDraftSegment } from "./voice-draft-audio.ts";
import { VOICE_DRAFT_PCM_SAMPLE_RATE } from "./voice-draft-pcm.ts";
import {
  transcribeVoiceDraftSegment$,
  type VoiceDraftTranscriptionResult,
} from "./voice-draft-transcription-segment.ts";
import {
  openAudioInputQuotaRecovery$,
  refreshAudioInputQuota$,
} from "./voice-io-stt.ts";

interface VoiceDraftTranscriptionOptions {
  readonly storageKey$: Computed<Promise<string>>;
  readonly readContext$: Command<VoiceIoTranscribeContext, []>;
}

interface VoiceDraftTranscriptionRecording {
  readonly key: string;
  readonly recordingId: string;
  readonly context?: VoiceIoTranscribeContext;
}

interface VoiceDraftTranscriptionSession {
  readonly recording: VoiceDraftTranscriptionRecording;
  readonly signal: AbortSignal;
}

interface VoiceDraftTranscriptionSegment {
  readonly segment?: VoiceDraftSegment;
  readonly totalDurationSeconds: number;
  readonly result: Promise<VoiceDraftTranscriptionResult | undefined>;
}

function isFinalSegment(
  entry: VoiceDraftTranscriptionSegment | undefined,
): boolean {
  return entry !== undefined && (entry.segment?.final ?? true);
}

function createTranscriptionState() {
  const resetSession$ = resetSignal();
  const session$ = state<VoiceDraftTranscriptionSession | null>(null);
  const segments$ = state<readonly VoiceDraftTranscriptionSegment[]>([]);
  // Each append starts finite, ordered command work. Its promise is also the
  // drain handle used by Stop, Retry, and cancellation; no state read starts I/O.
  const enqueue$ = command(
    (
      { get, set },
      recording: VoiceDraftTranscriptionRecording,
      request: Pick<
        VoiceDraftTranscriptionSegment,
        "segment" | "totalDurationSeconds"
      >,
      previous: VoiceDraftTranscriptionSegment | undefined,
      signal: AbortSignal,
    ): VoiceDraftTranscriptionSegment => {
      signal.throwIfAborted();
      const { segment, totalDurationSeconds } = request;
      if (!recording.context) {
        throw new Error("Voice transcription context has not been captured");
      }
      const result = set(
        transcribeVoiceDraftSegment$,
        {
          key: recording.key,
          recordingId: recording.recordingId,
          context: recording.context,
          segment,
          overlapDurationSeconds: segment
            ? Math.max(
                0,
                (previous?.segment?.endSample ?? 0) - segment.startSample,
              ) / VOICE_DRAFT_PCM_SAMPLE_RATE
            : 0,
          totalDurationSeconds,
        },
        previous?.result,
        signal,
      );
      const entry = { segment, totalDurationSeconds, result };
      detach(
        (async (ownerSignal: AbortSignal): Promise<void> => {
          // A failed segment stays available to the explicit Stop/Retry command.
          // It must not reject the PCM writer or stop subsequent audio persistence.
          const [outcome] = await Promise.allSettled([result]);
          ownerSignal.throwIfAborted();
          if (get(segments$).at(-1) !== entry) {
            return;
          }
          if (outcome?.status === "fulfilled") {
            if (outcome.value?.kind === "transcribed") {
              set(refreshAudioInputQuota$);
            } else if (!outcome.value) {
              await set(openAudioInputQuotaRecovery$, ownerSignal);
            }
          }
        })(signal),
        Reason.Daemon,
        "voice draft transcription",
      );
      return entry;
    },
  );

  return { session$, segments$, enqueue$, resetSession$ };
}

type TranscriptionState = ReturnType<typeof createTranscriptionState>;

function createInitialization(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, segments$, enqueue$, resetSession$ } = state;
  const initialize$ = command(async ({ get, set }, signal: AbortSignal) => {
    const key = await get(options.storageKey$);
    signal.throwIfAborted();
    const recording = await readVoiceDraftRecording(key);
    signal.throwIfAborted();
    if (!recording) {
      return;
    }
    const current = get(session$);
    if (
      current?.recording.recordingId === recording.id &&
      !current.signal.aborted
    ) {
      return;
    }
    set(resetSession$);
    await Promise.allSettled([get(segments$).at(-1)?.result]);
    signal.throwIfAborted();
    if (get(session$) !== current) {
      return;
    }
    const session = {
      recording: {
        key,
        recordingId: recording.id,
        context: recording.progress?.context,
      },
      signal: set(resetSession$, signal),
    };
    const restored: VoiceDraftTranscriptionSegment[] = [];
    for (const segment of recording.progress?.segments ?? []) {
      restored.push(
        set(
          enqueue$,
          session.recording,
          {
            segment,
            totalDurationSeconds:
              recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE,
          },
          restored.at(-1),
          session.signal,
        ),
      );
    }
    set(session$, session);
    set(segments$, restored);
  });

  return initialize$;
}

function createSegmentPreparation(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, segments$, enqueue$ } = state;
  // Persisted PCM schedules segment commands without waiting for their HTTP.
  // Stop can therefore drain audio even while an earlier segment is pending.
  const append$ = command(
    async ({ get, set }, finished: boolean, signal: AbortSignal) => {
      let session = get(session$);
      if (!session) {
        return;
      }
      const existing = get(segments$);
      const last = existing.at(-1);
      if (isFinalSegment(last)) {
        return;
      }
      const recording = await readVoiceDraftRecording(session.recording.key);
      signal.throwIfAborted();
      session.signal.throwIfAborted();
      if (get(session$) !== session) {
        return;
      }
      if (recording?.id !== session.recording.recordingId) {
        throw new Error("Voice recording changed during transcription");
      }
      const startSample = last?.segment?.endSample ?? 0;
      if (
        !finished &&
        !nextVoiceDraftSegment(recording.sampleCount, startSample, false)
      ) {
        return;
      }
      if (!session.recording.context) {
        session = {
          ...session,
          recording: {
            ...session.recording,
            context: set(options.readContext$),
          },
        };
        set(session$, session);
      }
      if (get(segments$) !== existing) {
        return;
      }
      const segments = [...existing];
      let previousEndSample = last?.segment?.endSample ?? 0;
      const totalDurationSeconds =
        recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE;
      while (previousEndSample < recording.sampleCount) {
        const segment = nextVoiceDraftSegment(
          recording.sampleCount,
          previousEndSample,
          finished,
        );
        if (!segment) {
          break;
        }
        segments.push(
          set(
            enqueue$,
            session.recording,
            { segment, totalDurationSeconds },
            segments.at(-1),
            session.signal,
          ),
        );
        previousEndSample = segment.endSample;
      }
      if (finished && !isFinalSegment(segments.at(-1))) {
        segments.push(
          set(
            enqueue$,
            session.recording,
            { totalDurationSeconds },
            segments.at(-1),
            session.signal,
          ),
        );
      }
      set(segments$, segments);
    },
  );

  return append$;
}

function createCheckpointRetry(state: TranscriptionState) {
  const { session$, segments$, enqueue$ } = state;
  const retry$ = command(async ({ get, set }, signal: AbortSignal) => {
    const session = get(session$);
    if (!session) {
      return;
    }
    const entries = get(segments$);
    if (entries.length === 0) {
      return;
    }
    const recording = await readVoiceDraftRecording(session.recording.key);
    signal.throwIfAborted();
    if (recording?.id !== session.recording.recordingId) {
      throw new Error("Voice recording changed during transcription");
    }
    if (get(segments$) !== entries || recording.progress?.text !== undefined) {
      return;
    }
    const firstUnfinished = entries.findIndex(({ segment }) => {
      return (
        !segment ||
        recording.progress?.segments.find((saved) => {
          return saved.endSample === segment.endSample;
        })?.transcript === undefined
      );
    });
    const completed = firstUnfinished === -1 ? entries.length : firstUnfinished;
    const retried = entries.slice(0, completed);
    for (const entry of entries.slice(completed)) {
      retried.push(
        set(enqueue$, session.recording, entry, retried.at(-1), session.signal),
      );
    }
    set(segments$, retried);
  });

  return retry$;
}

/** Commands own the ordered segment chain and its recording-session lifetime. */
export function createVoiceDraftTranscriptionSignals(
  options: VoiceDraftTranscriptionOptions,
) {
  const state = createTranscriptionState();
  const { session$, segments$, resetSession$ } = state;
  const initialize$ = createInitialization(options, state);
  const append$ = createSegmentPreparation(options, state);
  const retry$ = createCheckpointRetry(state);
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(session$);
    const previous =
      current && !current.signal.aborted && get(segments$).length > 0
        ? Promise.allSettled([get(segments$).at(-1)?.result])
        : undefined;
    await set(initialize$, signal);
    await set(append$, true, signal);
    // Seal the tail immediately, even while its predecessor is requesting.
    // Only an already-started failed chain needs its unfinished suffix rebuilt.
    if (previous) {
      const [outcome] = await previous;
      signal.throwIfAborted();
      if (
        outcome?.status === "rejected" ||
        !outcome?.value ||
        outcome.value.kind === "unavailable"
      ) {
        await set(retry$, signal);
        await set(append$, true, signal);
      }
    }
    const result = await get(segments$).at(-1)?.result;
    signal.throwIfAborted();
    if (!result) {
      if (get(segments$).length > 0) {
        await set(openAudioInputQuotaRecovery$, signal);
      }
      return;
    }
    if (result.kind === "transcribed") {
      set(refreshAudioInputQuota$);
    }
    return result;
  });

  const cancel$ = command(async ({ get, set }, signal: AbortSignal) => {
    const session = get(session$);
    set(resetSession$);
    await Promise.allSettled([get(segments$).at(-1)?.result]);
    signal.throwIfAborted();
    if (get(session$) === session) {
      set(session$, null);
      set(segments$, []);
    }
  });

  return { initialize$, append$, transcribe$, cancel$ };
}
