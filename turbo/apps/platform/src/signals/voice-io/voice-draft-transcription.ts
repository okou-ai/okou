import { command, computed, state, type Command, type Computed } from "ccstate";
import type { VoiceIoTranscribeContext } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import {
  readVoiceDraftRecording,
  type VoiceDraftSegment,
} from "../external/voice-draft-store.ts";
import { resetSignal, createDeferredPromise, setLoop } from "../utils.ts";
import { nextVoiceDraftSegment } from "./voice-draft-audio.ts";
import { VOICE_DRAFT_PCM_SAMPLE_RATE } from "./voice-draft-pcm.ts";
import { createVoiceDraftSegmentResult } from "./voice-draft-transcription-segment.ts";
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
  readonly result$: ReturnType<typeof createVoiceDraftSegmentResult>;
}

function createSegment(
  recording: VoiceDraftTranscriptionRecording,
  segment: VoiceDraftSegment | undefined,
  previous: VoiceDraftTranscriptionSegment | undefined,
  totalDurationSeconds: number,
  signal: AbortSignal,
): VoiceDraftTranscriptionSegment {
  if (!recording.context) {
    throw new Error("Voice transcription context has not been captured");
  }
  return {
    segment,
    totalDurationSeconds,
    result$: createVoiceDraftSegmentResult(
      {
        key: recording.key,
        recordingId: recording.recordingId,
        context: recording.context,
        segment,
        previous$: previous?.result$,
        overlapDurationSeconds: segment
          ? Math.max(
              0,
              (previous?.segment?.endSample ?? 0) - segment.startSample,
            ) / VOICE_DRAFT_PCM_SAMPLE_RATE
          : 0,
        totalDurationSeconds,
      },
      signal,
    ),
  };
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
  const result$ = computed(async (get) => {
    const last = get(segments$).at(-1);
    return last ? await get(last.result$) : undefined;
  });
  const wake$ = state<ReturnType<typeof createDeferredPromise<void>> | null>(
    null,
  );
  const notify$ = command(({ get }) => {
    const wake = get(wake$);
    if (wake && !wake.settled()) {
      wake.resolve();
    }
  });

  return { session$, segments$, result$, wake$, notify$, resetSession$ };
}

type TranscriptionState = ReturnType<typeof createTranscriptionState>;

function createInitialization(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, segments$, result$, resetSession$ } = state;
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
    await Promise.allSettled([get(result$)]);
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
        createSegment(
          session.recording,
          segment,
          restored.at(-1),
          recording.sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE,
          session.signal,
        ),
      );
    }
    set(session$, session);
    set(segments$, restored);
  });

  return initialize$;
}

function prepareSegments(
  recording: VoiceDraftTranscriptionRecording,
  existing: readonly VoiceDraftTranscriptionSegment[],
  sampleCount: number,
  finished: boolean,
  signal: AbortSignal,
): readonly VoiceDraftTranscriptionSegment[] {
  const entries = [...existing];
  let previousEndSample = entries.at(-1)?.segment?.endSample ?? 0;
  const totalDurationSeconds = sampleCount / VOICE_DRAFT_PCM_SAMPLE_RATE;
  while (previousEndSample < sampleCount) {
    const segment = nextVoiceDraftSegment(
      sampleCount,
      previousEndSample,
      finished,
    );
    if (!segment) {
      break;
    }
    entries.push(
      createSegment(
        recording,
        segment,
        entries.at(-1),
        totalDurationSeconds,
        signal,
      ),
    );
    previousEndSample = segment.endSample;
  }
  if (finished && !isFinalSegment(entries.at(-1))) {
    entries.push(
      createSegment(
        recording,
        undefined,
        entries.at(-1),
        totalDurationSeconds,
        signal,
      ),
    );
  }
  return entries;
}

function createSegmentPreparation(
  options: VoiceDraftTranscriptionOptions,
  state: TranscriptionState,
) {
  const { session$, segments$, notify$ } = state;
  // PCM writes only prepare boundaries. Encoding and HTTP belong to each
  // segment's computed, so recording continues while transcription waits.
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
      const segments = prepareSegments(
        session.recording,
        existing,
        recording.sampleCount,
        finished,
        session.signal,
      );
      set(segments$, segments);
      set(notify$);
    },
  );

  return append$;
}

function createCheckpointRetry(state: TranscriptionState) {
  const { session$, segments$ } = state;
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
        createSegment(
          session.recording,
          entry.segment,
          retried.at(-1),
          entry.totalDurationSeconds,
          session.signal,
        ),
      );
    }
    set(segments$, retried);
  });

  return retry$;
}

/** Stable segment computeds form a chain; only the last result needs awaiting. */
export function createVoiceDraftTranscriptionSignals(
  options: VoiceDraftTranscriptionOptions,
) {
  const state = createTranscriptionState();
  const { session$, segments$, result$, wake$, resetSession$ } = state;
  const initialize$ = createInitialization(options, state);
  const append$ = createSegmentPreparation(options, state);
  const retry$ = createCheckpointRetry(state);
  const transcribe$ = command(async ({ get, set }, signal: AbortSignal) => {
    const current = get(session$);
    const previous =
      current && !current.signal.aborted && get(segments$).length > 0
        ? Promise.allSettled([get(result$)])
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
    const result = await get(result$);
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
    await Promise.allSettled([get(result$)]);
    signal.throwIfAborted();
    if (get(session$) === session) {
      set(session$, null);
      set(segments$, []);
    }
  });

  // This observer starts newly appended computeds and owns their background
  // lifetime. Request ordering is entirely expressed by predecessor dependencies.
  const watch$ = command(({ get, set }, signal: AbortSignal) => {
    let wake = createDeferredPromise<void>(signal);
    set(wake$, wake);
    setLoop(
      async (loopSignal) => {
        const notified = Promise.allSettled([wake.promise]);
        if (get(segments$).length > 0) {
          const [outcome] = await Promise.allSettled([get(result$)]);
          loopSignal.throwIfAborted();
          if (outcome?.status === "fulfilled") {
            if (outcome.value?.kind === "transcribed") {
              set(refreshAudioInputQuota$);
            } else if (!outcome.value) {
              await set(openAudioInputQuotaRecovery$, loopSignal);
            }
          }
        }
        await notified;
        loopSignal.throwIfAborted();
        // `setLoop` yields after this callback, so arm the next notification
        // first to retain appends that arrive between iterations.
        wake = createDeferredPromise<void>(loopSignal);
        set(wake$, wake);
        return false;
      },
      0,
      signal,
      { retryTransientErrors: false },
    );
  });
  return { initialize$, append$, transcribe$, watch$, cancel$ };
}
