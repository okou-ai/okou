import { command, computed, state } from "ccstate";
import { now } from "../../lib/time.ts";
import { createChildAbortController, settle, withCleanup } from "../utils.ts";
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

interface VoiceDraftCapture {
  readonly pcm: Awaited<ReturnType<typeof startVoiceDraftPcmCapture>>;
  readonly monitor: Awaited<ReturnType<typeof startAudioActivityMonitor>>;
  readonly controller: AbortController;
  readonly startedAt: number;
}

export function createVoiceDraftCaptureSignals() {
  const resource$ = state<VoiceDraftCapture | null>(null);
  const samples$ = state<readonly VoiceLevelSample[]>([]);
  const acquisition$ = state<AbortController | null>(null);
  const capture$ = computed((get) => {
    return get(resource$);
  });
  const voiceLevelSamples$ = computed((get) => {
    return get(samples$);
  });

  const cancel$ = command(({ get, set }) => {
    get(acquisition$)?.abort();
    set(acquisition$, null);
    set(resource$, null);
  });

  const start$ = command(
    async (
      { get, set },
      persistence: VoiceDraftPcmPersistence,
      parentSignal: AbortSignal,
    ): Promise<boolean> => {
      if (get(acquisition$)) {
        return false;
      }
      // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
      const controller = createChildAbortController(parentSignal);
      const signal = controller.signal;
      set(acquisition$, controller);
      set(
        samples$,
        Array.from({ length: VOICE_LEVEL_SAMPLE_COUNT }, (_, id) => {
          return { id, level: 0 };
        }),
      );
      signal.addEventListener(
        "abort",
        () => {
          if (get(acquisition$) === controller) {
            set(acquisition$, null);
            set(resource$, null);
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
          const pcm = await startVoiceDraftPcmCapture(
            stream,
            persistence,
            signal,
          );
          signal.throwIfAborted();
          const startedAt = now();
          const monitored = await settle(
            startAudioActivityMonitor(
              stream,
              () => {},
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
            controller,
            startedAt,
          };
        })(),
        signal,
      );
      if (!started.ok || !started.value) {
        controller.abort();
        parentSignal.throwIfAborted();
        if (!started.ok) {
          throw started.error;
        }
        return false;
      }
      set(resource$, started.value);
      return true;
    },
  );

  const finish$ = command(async ({ get, set }, signal: AbortSignal) => {
    const capture = get(resource$);
    if (!capture) {
      return false;
    }
    // Taking the resource makes repeated Stop events harmless, without another
    // boolean or Promise atom mirroring the command's execution.
    set(resource$, null);
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
        return capture.controller.abort();
      },
    );
    signal.throwIfAborted();
    return true;
  });

  return { capture$, voiceLevelSamples$, start$, finish$, cancel$ };
}
