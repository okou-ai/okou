import { Silero } from "@ricky0123/vad-web/dist/models/silero.js";
import * as ort from "onnxruntime-web/wasm";
import { platformStaticAssetUrl } from "../static-assets.ts";
import { fetchResource } from "../resource-fetch.ts";
import { waitLoopUntil, withCleanup } from "../../signals/utils.ts";

export const VOICE_ACTIVITY_POLICY_VERSION = "silero-v5-conservative-1";
const FRAME_SAMPLES = 512;
// Only consistently low probabilities may suppress an upload. A short onset,
// weak voice, or any ambiguous frame passes through unchanged.
const NO_SPEECH_MAX_PROBABILITY = 0.1;
const SPEECH_MIN_PROBABILITY = 0.5;
const ASSET_PATH = "voice-io/vad/";

export type VoiceActivityDecision = "speech" | "uncertain" | "no_speech";

/** Inspect existing PCM without opening a second microphone or changing audio. */
export async function analyzeVoiceActivity(
  samples: Float32Array,
  signal: AbortSignal,
): Promise<VoiceActivityDecision> {
  signal.throwIfAborted();
  if (
    samples.length === 0 ||
    samples.some((sample) => {
      return !Number.isFinite(sample);
    })
  ) {
    throw new Error("Voice activity detection received invalid PCM");
  }
  // Digital silence is unambiguous and needs no model download.
  if (
    samples.every((sample) => {
      return sample === 0;
    })
  ) {
    return "no_speech";
  }
  // Less than one complete frame is not enough evidence to reject a short word.
  if (samples.length < FRAME_SAMPLES) {
    return "uncertain";
  }
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: platformStaticAssetUrl(
      `${ASSET_PATH}ort-wasm-simd-threaded-1.23.2-90a557d15c02.mjs`,
    ),
    wasm: platformStaticAssetUrl(
      `${ASSET_PATH}ort-wasm-simd-threaded-1.23.2-45eaee27761a.wasm`,
    ),
  };
  const model = await Silero.new(ort, async () => {
    const response = await fetchResource(
      platformStaticAssetUrl(`${ASSET_PATH}silero-vad-v5-2623a2953f6f.onnx`),
      {},
      signal,
    );
    if (!response.ok) {
      throw new Error("Voice activity model could not be loaded");
    }
    return await response.arrayBuffer();
  });
  // Each analysis has fresh recurrent state. Separate composers cannot corrupt
  // one another, and cancellation still releases a session created in flight.
  return await withCleanup(
    (async (): Promise<VoiceActivityDecision> => {
      signal.throwIfAborted();
      let offset = 0;
      let decision: VoiceActivityDecision = "no_speech";
      // WASM inference can resolve synchronously. Process bounded batches so
      // the owner loop yields to UI/cancellation without an inference worker.
      await waitLoopUntil(
        async () => {
          const batchEnd = Math.min(
            samples.length,
            offset + 16 * FRAME_SAMPLES,
          );
          for (; offset < batchEnd; offset += FRAME_SAMPLES) {
            const frame = new Float32Array(FRAME_SAMPLES);
            frame.set(samples.subarray(offset, offset + FRAME_SAMPLES));
            const { isSpeech } = await model.process(frame);
            signal.throwIfAborted();
            if (!Number.isFinite(isSpeech) || isSpeech < 0 || isSpeech > 1) {
              throw new Error(
                "Voice activity model returned invalid probabilities",
              );
            }
            if (isSpeech > NO_SPEECH_MAX_PROBABILITY) {
              decision =
                isSpeech >= SPEECH_MIN_PROBABILITY ? "speech" : "uncertain";
              return true;
            }
          }
          return offset >= samples.length;
        },
        0,
        signal,
        { testIntervalMs: 0, retryTransientErrors: false },
      );
      signal.throwIfAborted();
      return decision;
    })(),
    async () => {
      await model.release();
    },
  );
}
