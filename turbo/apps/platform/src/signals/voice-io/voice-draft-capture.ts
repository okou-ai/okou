import { command, computed, state } from "ccstate";
import { now } from "../../lib/time.ts";
import { resetSignal, settle, withCleanup } from "../utils.ts";
import {
  openMedia,
  startAudioActivityMonitor,
  stopAudioActivityMonitorAndWait,
  waitForBrowserPaint,
} from "./voice-io-stt.ts";
import {
  startVoiceDraftPcmCapture,
  type VoiceDraftPcmPersistence,
} from "./voice-draft-pcm.ts";

export interface VoiceLevelSample {
  readonly id: number;
  readonly level: number;
}

const VOICE_LEVEL_SAMPLE_COUNT = 40;
const INITIAL_VOICE_LEVEL_SAMPLES: readonly VoiceLevelSample[] = Array.from(
  { length: VOICE_LEVEL_SAMPLE_COUNT },
  (_, id) => {
    return { id, level: 0 };
  },
);

interface VoiceDraftCapture {
  readonly pcm: Awaited<ReturnType<typeof startVoiceDraftPcmCapture>>;
  readonly monitor: Awaited<ReturnType<typeof startAudioActivityMonitor>>;
  readonly startedAt: number;
}

interface VoiceDraftAcquisition {
  readonly signal: AbortSignal;
  readonly capture: VoiceDraftCapture | null;
}

export function createVoiceDraftCaptureSignals() {
  const samples$ = state<readonly VoiceLevelSample[]>([]);
  const acquisition$ = state<VoiceDraftAcquisition | null>(null);
  const resetAcquisition$ = resetSignal();
  const resetStartupWait$ = resetSignal();
  const capture$ = computed((get) => {
    return get(acquisition$)?.capture ?? null;
  });
  const voiceLevelSamples$ = computed((get) => {
    return get(samples$);
  });

  const cancel$ = command(({ set }) => {
    set(resetAcquisition$);
    set(acquisition$, null);
  });

  const start$ = command(
    async (
      { get, set },
      persistence: VoiceDraftPcmPersistence,
      parentSignal: AbortSignal,
    ): Promise<boolean> => {
      parentSignal.throwIfAborted();
      if (get(acquisition$)) {
        return false;
      }
      const signal = set(resetAcquisition$, parentSignal);
      set(acquisition$, { signal, capture: null });
      set(samples$, INITIAL_VOICE_LEVEL_SAMPLES);
      signal.addEventListener(
        "abort",
        () => {
          if (get(acquisition$)?.signal === signal) {
            set(acquisition$, null);
          }
        },
        { once: true },
      );
      const started = await settle(
        (async () => {
          await waitForBrowserPaint(signal);
          signal.throwIfAborted();
          const stream = await openMedia(signal);
          signal.throwIfAborted();
          if (!stream) {
            return null;
          }
          const startupSignal = set(resetStartupWait$, signal);
          const pcm = await withCleanup(
            startVoiceDraftPcmCapture(
              stream,
              persistence,
              startupSignal,
              signal,
            ),
            () => {
              if (get(acquisition$)?.signal === signal) {
                set(resetStartupWait$);
              }
            },
          );
          signal.throwIfAborted();
          const startedAt = now();
          const monitored = await settle(
            startAudioActivityMonitor(
              stream,
              (level) => {
                set(samples$, (samples) => {
                  return [
                    ...samples.slice(1),
                    { id: (samples.at(-1)?.id ?? 0) + 1, level },
                  ];
                });
              },
              signal,
            ),
            signal,
          );
          signal.throwIfAborted();
          return {
            pcm,
            monitor: monitored.ok ? monitored.value : null,
            startedAt,
          };
        })(),
        signal,
      );
      if (!started.ok || !started.value) {
        if (get(acquisition$)?.signal === signal) {
          set(resetAcquisition$);
        }
        parentSignal.throwIfAborted();
        if (!started.ok) {
          throw started.error;
        }
        return false;
      }
      signal.throwIfAborted();
      set(acquisition$, { signal, capture: started.value });
      return true;
    },
  );

  const finish$ = command(async ({ get, set }, signal: AbortSignal) => {
    const acquisition = get(acquisition$);
    if (!acquisition?.capture) {
      return false;
    }
    const capture = acquisition.capture;
    // Taking the resource makes repeated Stop events harmless, without another
    // boolean or Promise atom mirroring the command's execution.
    set(acquisition$, { ...acquisition, capture: null });
    await withCleanup(
      (async () => {
        if (capture.monitor) {
          await stopAudioActivityMonitorAndWait(capture.monitor);
          signal.throwIfAborted();
        }
        await capture.pcm.finish(signal);
        signal.throwIfAborted();
      })(),
      () => {
        if (get(acquisition$)?.signal === acquisition.signal) {
          set(resetAcquisition$);
        }
      },
    );
    signal.throwIfAborted();
    return true;
  });

  return { capture$, voiceLevelSamples$, start$, finish$, cancel$ };
}
