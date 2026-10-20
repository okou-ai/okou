import {
  bestEffort,
  createDeferredPromise,
  detach,
  Reason,
  withCleanup,
} from "../utils";

export const VOICE_DRAFT_PCM_SAMPLE_RATE = 16_000;

const PCM_WORKLET_PROCESSOR_NAME = "okou-voice-draft-pcm-capture";
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
  readonly completed: Promise<void>;
  readonly finish: (signal: AbortSignal) => Promise<void>;
}

export interface VoiceDraftPcmPersistence {
  readonly append: (samples: Float32Array, sequence: number) => Promise<void>;
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

async function persistVoiceDraftSamples(
  samples: ReadableStream<Float32Array>,
  persistence: VoiceDraftPcmPersistence,
  signal: AbortSignal,
): Promise<void> {
  const reader = samples.getReader();
  let sequence = 0;
  while (true) {
    const next = await reader.read();
    signal.throwIfAborted();
    if (next.done) {
      return;
    }
    await persistence.append(next.value, sequence++);
  }
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
  signal.addEventListener(
    "abort",
    () => {
      detach(
        bestEffort(audioContext.close()),
        Reason.DomCallback,
        "close voice draft audio context",
      );
    },
    { once: true },
  );
  const moduleUrl = URL.createObjectURL(
    new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }),
  );
  await withCleanup(audioContext.audioWorklet.addModule(moduleUrl), () => {
    URL.revokeObjectURL(moduleUrl);
  });
  signal.throwIfAborted();

  await audioContext.resume();
  signal.throwIfAborted();
  const source = audioContext.createMediaStreamSource(stream);
  signal.addEventListener(
    "abort",
    () => {
      source.disconnect();
    },
    { once: true },
  );
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
  signal.addEventListener(
    "abort",
    () => {
      worklet.port.close();
    },
    { once: true },
  );
  const firstBatch = createDeferredPromise<void>(signal);
  const samples = new ReadableStream<Float32Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => {
          controller.error(signal.reason);
        },
        { once: true },
      );
      worklet.port.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          if (event.data instanceof ArrayBuffer) {
            const batch = new Float32Array(event.data);
            if (batch.length > 0) {
              controller.enqueue(batch);
              if (!firstBatch.settled()) {
                firstBatch.resolve();
              }
            }
          } else if (event.data === "done") {
            controller.close();
          }
        },
        { signal },
      );
    },
  });
  worklet.port.start();
  source.connect(worklet);
  const completed = persistVoiceDraftSamples(samples, persistence, signal);
  // Capture readiness and persistence share one session. A failed write
  // rejects this session immediately, including before the first batch.
  await Promise.race([firstBatch.promise, completed]);
  signal.throwIfAborted();
  return {
    completed,
    async finish(finishSignal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      worklet.port.postMessage("stop");
      await completed;
      finishSignal.throwIfAborted();
    },
  };
}
