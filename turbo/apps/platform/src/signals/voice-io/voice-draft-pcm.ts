import { timeout } from "signal-timers";
import {
  bestEffort,
  createChildAbortController,
  createDeferredPromise,
  onRejection,
  withCleanup,
} from "../utils";

export const VOICE_DRAFT_PCM_SAMPLE_RATE = 16_000;

const PCM_WORKLET_PROCESSOR_NAME = "okou-voice-draft-pcm-capture";
const SAFARI_CAPTURE_START_TIMEOUT_MS = 5000;
const PCM_WORKLET_SOURCE = `
const TARGET_SAMPLE_RATE = 16000;
const OUTPUT_BATCH_SAMPLES = 4096;

class VoiceDraftPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputIndex = 0;
    this.nextOutputAt = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
    this.output = new Float32Array(OUTPUT_BATCH_SAMPLES);
    this.outputLength = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data !== "stop" || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage("done");
    };
  }

  append(value) {
    this.output[this.outputLength] = value;
    this.outputLength += 1;
    if (this.outputLength === this.output.length) this.flush();
  }

  flush() {
    if (this.outputLength === 0) return;
    const batch = this.output.slice(0, this.outputLength);
    this.port.postMessage(batch.buffer, [batch.buffer]);
    this.outputLength = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frameCount = channels[0]?.length ?? 0;
    const inputSamplesPerOutput = sampleRate / TARGET_SAMPLE_RATE;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[frame] ?? 0;
      mixed /= channels.length;

      if (!this.hasPreviousSample) {
        this.previousSample = mixed;
        this.hasPreviousSample = true;
      }
      while (this.nextOutputAt <= this.inputIndex) {
        const previousIndex = Math.max(0, this.inputIndex - 1);
        const fraction = Math.max(
          0,
          Math.min(1, this.nextOutputAt - previousIndex),
        );
        this.append(
          this.previousSample + (mixed - this.previousSample) * fraction,
        );
        this.nextOutputAt += inputSamplesPerOutput;
      }
      this.previousSample = mixed;
      this.inputIndex += 1;
    }
    return true;
  }
}

registerProcessor(
  "${PCM_WORKLET_PROCESSOR_NAME}",
  VoiceDraftPcmCaptureProcessor,
);
`;

interface VoiceDraftPcmCapture {
  readonly cancel: () => void;
  readonly finish: (signal: AbortSignal) => Promise<void>;
}

export interface VoiceDraftPcmPersistence {
  readonly append: (samples: Float32Array, sequence: number) => Promise<void>;
  readonly fail: (error: unknown) => void;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

export function encodeVoiceDraftPcmWav(samples: Float32Array): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_DRAFT_PCM_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_DRAFT_PCM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767),
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function decodeVoiceDraftPcmWav(
  buffer: ArrayBuffer,
): Float32Array | null {
  if (buffer.byteLength < 44) {
    return null;
  }
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    return null;
  }

  let validFormat = false;
  let dataOffset: number | undefined;
  let dataSize: number | undefined;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkName = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const chunkEnd = chunkDataOffset + chunkSize;
    if (chunkEnd > buffer.byteLength) {
      return null;
    }
    if (chunkName === "fmt " && chunkSize >= 16) {
      validFormat =
        view.getUint16(chunkDataOffset, true) === 1 &&
        view.getUint16(chunkDataOffset + 2, true) === 1 &&
        view.getUint32(chunkDataOffset + 4, true) ===
          VOICE_DRAFT_PCM_SAMPLE_RATE &&
        view.getUint16(chunkDataOffset + 14, true) === 16;
    }
    if (chunkName === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  if (
    !validFormat ||
    dataOffset === undefined ||
    dataSize === undefined ||
    dataSize % 2 !== 0
  ) {
    return null;
  }

  const samples = new Float32Array(dataSize / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(dataOffset + index * 2, true) / 32_768;
  }
  return samples;
}

function disconnectCaptureGraph(
  source: MediaStreamAudioSourceNode,
  worklet: AudioWorkletNode,
): void {
  source.disconnect(worklet);
}

function createVoiceDraftSampleWriter(
  persistence: VoiceDraftPcmPersistence,
  signal: AbortSignal,
) {
  let sequence = 0;
  let pendingWrite = Promise.allSettled([Promise.resolve()]);
  let writeFailed = false;
  return {
    append(batch: Float32Array): void {
      const previous = pendingWrite;
      const chunkSequence = sequence++;
      pendingWrite = Promise.allSettled([
        (async () => {
          const [written] = await previous;
          if (written?.status === "rejected") {
            throw written.reason;
          }
          signal.throwIfAborted();
          await onRejection(
            persistence.append(batch, chunkSequence),
            (error) => {
              signal.throwIfAborted();
              if (!writeFailed) {
                writeFailed = true;
                persistence.fail(error);
              }
            },
          );
        })(),
      ]);
    },
    async finish(): Promise<void> {
      const [written] = await pendingWrite;
      if (written?.status === "rejected") {
        throw written.reason;
      }
      signal.throwIfAborted();
    },
  };
}

async function waitForSafariCaptureStart(
  ready: ReturnType<typeof createDeferredPromise<void>>,
  signal: AbortSignal,
): Promise<void> {
  // Safari can initially supply only zeros after capture has started.
  // Bound the extra wait so a quiet room still becomes ready.
  // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
  const startupController = createChildAbortController(signal);
  timeout(
    () => {
      if (!ready.settled()) {
        ready.resolve();
      }
    },
    SAFARI_CAPTURE_START_TIMEOUT_MS,
    { signal: startupController.signal },
  );
  await withCleanup(ready.promise, () => {
    startupController.abort();
  });
  signal.throwIfAborted();
}

export async function startVoiceDraftPcmCapture(
  stream: MediaStream,
  persistence: VoiceDraftPcmPersistence,
  signal: AbortSignal,
): Promise<VoiceDraftPcmCapture> {
  signal.throwIfAborted();
  const audioContext = new AudioContext({
    sampleRate: VOICE_DRAFT_PCM_SAMPLE_RATE,
  });
  let closePromise: Promise<void> | undefined;

  const closeAudioContext = (): Promise<void> => {
    closePromise ??= bestEffort(audioContext.close());
    return closePromise;
  };

  return await onRejection(
    (async (): Promise<VoiceDraftPcmCapture> => {
      const moduleUrl = URL.createObjectURL(
        new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }),
      );
      await withCleanup(
        (async () => {
          await audioContext.audioWorklet.addModule(moduleUrl);
        })(),
        () => {
          URL.revokeObjectURL(moduleUrl);
        },
      );
      signal.throwIfAborted();

      await audioContext.resume();
      signal.throwIfAborted();
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(
        audioContext,
        PCM_WORKLET_PROCESSOR_NAME,
        {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
        },
      );
      const finished = createDeferredPromise<void>(signal);
      const firstBatch = createDeferredPromise<void>(signal);
      const userAgent = navigator.userAgent;
      const isSafari =
        /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent) &&
        !/\b(?:Chrome|CriOS|Chromium|Edg|OPR|FxiOS)\//.test(userAgent);
      const safariReady = isSafari ? createDeferredPromise<void>(signal) : null;
      const samples = createVoiceDraftSampleWriter(persistence, signal);
      let stopped = false;
      worklet.port.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          if (event.data instanceof ArrayBuffer) {
            const batch = new Float32Array(event.data);
            if (batch.length > 0 && !signal.aborted) {
              samples.append(batch);
              if (!firstBatch.settled()) {
                firstBatch.resolve();
              }
              if (
                safariReady &&
                !safariReady.settled() &&
                batch.some((sample) => {
                  return sample !== 0;
                })
              ) {
                safariReady.resolve();
              }
            }
          } else if (event.data === "done" && !finished.settled()) {
            finished.resolve();
          }
        },
      );
      worklet.port.start();

      const capture: VoiceDraftPcmCapture = {
        cancel(): void {
          if (stopped) {
            return;
          }
          stopped = true;
          worklet.port.postMessage("stop");
          disconnectCaptureGraph(source, worklet);
          worklet.port.close();
          closePromise = closeAudioContext();
        },
        async finish(finishSignal: AbortSignal): Promise<void> {
          if (stopped) {
            throw new Error("Voice draft PCM capture has already stopped");
          }
          stopped = true;
          return await withCleanup(
            (async () => {
              worklet.port.postMessage("stop");
              await finished.promise;
              finishSignal.throwIfAborted();
              return await samples.finish();
            })(),
            async () => {
              disconnectCaptureGraph(source, worklet);
              worklet.port.close();
              await closeAudioContext();
            },
          );
        },
      };
      signal.addEventListener("abort", capture.cancel, { once: true });
      return await onRejection(
        (async () => {
          source.connect(worklet);
          // Connected nodes do not prove the microphone is supplying samples.
          // Keep every batch in the normal write queue, including startup silence.
          await firstBatch.promise;
          signal.throwIfAborted();
          if (safariReady && !safariReady.settled()) {
            await waitForSafariCaptureStart(safariReady, signal);
          }
          return capture;
        })(),
        capture.cancel,
      );
    })(),
    async () => {
      await closeAudioContext();
    },
  );
}
