import { now as currentTimeMs } from "../../lib/time.ts";
import { command, computed, state } from "ccstate";
import {
  voiceIoQuotaContract,
  type AudioInputQuotaResponse,
} from "@okouai/api-contracts/contracts/voice-io-quota";
import { pageSignal$ } from "../page-signal.ts";
import { isOrgAdmin$ } from "../org.ts";
import { apiClient$ } from "../api-client.ts";
import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "../okou-page/billing.ts";
import { setBillingSubPage$ } from "../okou-page/settings/workspace-settings-state.ts";
import { openSettingsDialogAt$ } from "../okou-page/settings/settings-dialog.ts";
import { logger } from "../log.ts";
import {
  bestEffort,
  createDeferredPromise,
  settle,
  withCleanup,
} from "../utils.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../../lib/accept.ts";
import { resolveAudioConfig } from "../../lib/voice-io/audio-config.ts";
import { i18n } from "../../i18n/index.ts";

const L = logger("VoiceIO:STT");
const VOICE_LEVEL_SAMPLE_INTERVAL_MS = 100;

const audioInputQuotaReload$ = state(0);

// ---------------------------------------------------------------------------
// Public computed
// ---------------------------------------------------------------------------

export const audioInputAvailable$ = computed(() => {
  const hasMic =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  return hasMic;
});

/**
 * Async-loaded audio input quota for the current user/org.
 * Re-fetches whenever `refreshAudioInputQuota$` is invoked (e.g., after a
 * successful STT call or a 402 response).
 */
export const audioInputQuota$ = computed(
  async (get): Promise<AudioInputQuotaResponse> => {
    get(audioInputQuotaReload$);
    const createClient = get(apiClient$);
    const client = createClient(voiceIoQuotaContract);
    const result = await accept(client.get(), [200]);
    return result.body;
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stopAllTracks(stream: MediaStream | null) {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

const VOICE_ACTIVITY_RMS_THRESHOLD = 0.025;
const AUDIO_INPUT_QUOTA_TOAST_ID = "voice-input-quota-limit";

function microphoneAccessDeniedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.microphoneAccessDenied;
  });
}

function audioInputQuotaLimitMessage(
  tier: BillingTier,
  isAdmin: boolean,
): string {
  if (tier === "team" || tier === "custom") {
    return i18n.t(($) => {
      return $.chat.voice.inputLimitReachedReset;
    });
  }
  if (tier === "pro") {
    return isAdmin
      ? i18n.t(($) => {
          return $.chat.voice.inputLimitReachedPro;
        })
      : i18n.t(($) => {
          return $.chat.voice.inputLimitReachedProMember;
        });
  }
  return isAdmin
    ? i18n.t(($) => {
        return $.chat.voice.inputLimitReached;
      })
    : i18n.t(($) => {
        return $.chat.voice.inputLimitReachedMember;
      });
}

interface AudioActivityMonitor {
  readonly audioContext: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly samples: Float32Array<ArrayBuffer>;
  readonly cancelFrame: (handle: number) => void;
  frameId: number | null;
  stopped: boolean;
  closePromise: Promise<void> | null;
}

function audioActivityNow(): number {
  return typeof performance !== "undefined"
    ? performance.now()
    : currentTimeMs();
}

export function waitForBrowserPaint(signal: AbortSignal): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function" ||
    typeof window.cancelAnimationFrame !== "function"
  ) {
    return Promise.resolve();
  }

  const deferred = createDeferredPromise<void>(signal);
  let firstFrameId: number | null = null;
  let secondFrameId: number | null = null;

  function cleanup(): void {
    signal.removeEventListener("abort", handleAbort);
  }

  function finish(): void {
    cleanup();
    if (!deferred.settled()) {
      deferred.resolve(undefined);
    }
  }

  function handleAbort(): void {
    if (firstFrameId !== null) {
      window.cancelAnimationFrame(firstFrameId);
    }
    if (secondFrameId !== null) {
      window.cancelAnimationFrame(secondFrameId);
    }
    finish();
  }

  signal.addEventListener("abort", handleAbort, { once: true });
  firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(finish);
  });
  return deferred.promise;
}

function rms(samples: Float32Array<ArrayBufferLike>): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function voiceActivityLevel(value: number): number {
  if (value < VOICE_ACTIVITY_RMS_THRESHOLD) {
    return 0;
  }
  if (value < 0.055) {
    return 1;
  }
  if (value < 0.095) {
    return 2;
  }
  return 3;
}

async function closeAudioContextQuietly(
  audioContext: AudioContext,
): Promise<void> {
  await bestEffort(audioContext.close());
}

export async function startAudioActivityMonitor(
  stream: MediaStream,
  onLevelSample: (level: number) => void,
  signal: AbortSignal,
): Promise<AudioActivityMonitor | null> {
  const AudioContextConstructor = audioContextConstructor();
  if (!AudioContextConstructor) {
    return null;
  }

  const audioContext = new AudioContextConstructor();
  let audioContextClosePromise: Promise<void> | null = null;
  let monitor: AudioActivityMonitor | null = null;
  let retainedByMonitor = false;
  const stopOnAbort = () => {
    if (monitor) {
      stopAudioActivityMonitor(monitor);
      return;
    }
    audioContextClosePromise ??= closeAudioContextQuietly(audioContext);
  };
  signal.addEventListener("abort", stopOnAbort, { once: true });
  return await withCleanup(
    (async () => {
      signal.throwIfAborted();
      if (
        typeof audioContext.createMediaStreamSource !== "function" ||
        typeof audioContext.createAnalyser !== "function"
      ) {
        return null;
      }

      await audioContext.resume();
      signal.throwIfAborted();

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      const requestFrame = window.requestAnimationFrame.bind(window);
      analyser.fftSize = 1024;
      source.connect(analyser);

      const startedMonitor: AudioActivityMonitor = {
        audioContext,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        cancelFrame: window.cancelAnimationFrame.bind(window),
        frameId: null,
        stopped: false,
        closePromise: null,
      };
      monitor = startedMonitor;

      let nextLevelSampleAt =
        audioActivityNow() + VOICE_LEVEL_SAMPLE_INTERVAL_MS;
      const update = () => {
        if (startedMonitor.stopped) {
          return;
        }
        startedMonitor.analyser.getFloatTimeDomainData(startedMonitor.samples);
        const level = voiceActivityLevel(rms(startedMonitor.samples));
        const currentTime = audioActivityNow();
        if (currentTime >= nextLevelSampleAt) {
          onLevelSample(level);
          nextLevelSampleAt = currentTime + VOICE_LEVEL_SAMPLE_INTERVAL_MS;
        }
        startedMonitor.frameId = requestFrame(update);
      };

      update();
      retainedByMonitor = true;
      return startedMonitor;
    })(),
    async () => {
      if (retainedByMonitor) {
        return;
      }
      signal.removeEventListener("abort", stopOnAbort);
      if (monitor) {
        await stopAudioActivityMonitorAndWait(monitor);
        return;
      }
      audioContextClosePromise ??= closeAudioContextQuietly(audioContext);
      await audioContextClosePromise;
    },
  );
}

function stopAudioActivityMonitor(monitor: AudioActivityMonitor): void {
  if (monitor.stopped) {
    return;
  }

  monitor.stopped = true;
  if (monitor.frameId !== null) {
    monitor.cancelFrame(monitor.frameId);
    monitor.frameId = null;
  }
  monitor.source.disconnect();
  monitor.analyser.disconnect();
  monitor.closePromise = closeAudioContextQuietly(monitor.audioContext);
}

export async function stopAudioActivityMonitorAndWait(
  monitor: AudioActivityMonitor,
): Promise<void> {
  stopAudioActivityMonitor(monitor);
  if (monitor.closePromise) {
    await monitor.closePromise;
  }
}

export const refreshAudioInputQuota$ = command(({ set }) => {
  set(audioInputQuotaReload$, (x) => {
    return x + 1;
  });
});

export const openAudioInputQuotaRecovery$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const isAdmin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    const billingStatus = await get(billingStatusAsync$);
    signal.throwIfAborted();
    const tier = apiTierToBillingTier(billingStatus.tier);
    const waitsForReset = tier === "team" || tier === "custom";
    toast.error(audioInputQuotaLimitMessage(tier, isAdmin), {
      id: AUDIO_INPUT_QUOTA_TOAST_ID,
    });
    set(refreshAudioInputQuota$);
    if (!isAdmin || waitsForReset) {
      return;
    }
    set(setBillingSubPage$, true);
    await set(openSettingsDialogAt$, "billing", get(pageSignal$));
  },
);

interface WindowWithWebkitAudioContext extends Window {
  readonly webkitAudioContext?: typeof AudioContext;
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (
    window.AudioContext ??
    (window as WindowWithWebkitAudioContext).webkitAudioContext
  );
}

export async function openMedia(signal: AbortSignal) {
  const audioConfig = await resolveAudioConfig();
  signal.throwIfAborted();
  // getUserMedia cannot be cancelled. Release a late stream before propagating
  // cancellation, and own every acquired track before recorder setup can fail.
  const opened = await settle(
    navigator.mediaDevices.getUserMedia({ audio: audioConfig.constraints }),
  );
  if (!opened.ok) {
    signal.throwIfAborted();
    L.error("Microphone access denied", opened.error);
    toast.error(microphoneAccessDeniedMessage());
    return;
  }
  if (signal.aborted) {
    stopAllTracks(opened.value);
    signal.throwIfAborted();
  }
  signal.addEventListener(
    "abort",
    () => {
      stopAllTracks(opened.value);
    },
    { once: true },
  );
  return opened.value;
}
