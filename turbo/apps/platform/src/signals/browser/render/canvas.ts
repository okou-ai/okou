import { detach, Reason } from "../../utils.ts";

import { CdpFault } from "../cdp/errors.ts";
import type { BrowserByteArrayConstructor } from "../native-types.ts";
import {
  maximumEncodedFrameLength,
  maximumFrameArea,
  maximumFrameDimension,
} from "../display/limits.ts";
import type { Viewport } from "../display/geometry.ts";

export interface FrameSink {
  push(
    data: string,
    painted: (raster: Viewport) => void,
    failed: (error: CdpFault) => void,
    accept?: (raster: Viewport) => boolean,
  ): void;
  invalidate(): void;
  reset(): void;
  dispose(): void;
}

export interface DecodedFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

type Decode = (data: string) => Promise<DecodedFrame>;
interface QueuedFrame {
  data: string;
  generation: number;
  painted: (raster: Viewport) => void;
  failed: (error: CdpFault) => void;
  accept: ((raster: Viewport) => boolean) | undefined;
}

async function decodeImage(data: string): Promise<DecodedFrame> {
  const bytes = (Uint8Array as BrowserByteArrayConstructor).fromBase64(data);
  // Decode actual bytes: late frames may still use the previous capture format.
  const image = await createImageBitmap(new Blob([bytes]));
  return {
    source: image,
    width: image.width,
    height: image.height,
    close: () => {
      return image.close();
    },
  };
}

function frameRaster(image: DecodedFrame): Viewport {
  if (
    image.width < 1 ||
    image.height < 1 ||
    image.width > maximumFrameDimension ||
    image.height > maximumFrameDimension ||
    image.width * image.height > maximumFrameArea
  ) {
    throw new CdpFault("frame", "The browser sent invalid frame dimensions.");
  }
  return { width: image.width, height: image.height };
}

/** One active decode and one latest queued frame; no semantic viewer state. */
export function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  decode: Decode = decodeImage,
): FrameSink {
  const acquired = canvas.getContext("2d", { alpha: false });
  if (!acquired) {
    throw new CdpFault("frame", "Canvas 2D is unavailable.");
  }
  const context = acquired;
  let generation = 0;
  let queued: QueuedFrame | null = null;
  let decoding = false;
  let disposed = false;

  function push(
    data: string,
    painted: (raster: Viewport) => void,
    failed: (error: CdpFault) => void,
    accept?: (raster: Viewport) => boolean,
  ): void {
    if (disposed) {
      return;
    }
    if (data.length > maximumEncodedFrameLength) {
      failed(new CdpFault("frame", "The browser sent an oversized frame."));
      return;
    }
    queued = { data, generation, painted, failed, accept };
    if (!decoding) {
      const startedGeneration = generation;
      detach(
        (async () => {
          const [reply] = await Promise.allSettled([drain()]);
          if (
            reply.status === "rejected" &&
            !disposed &&
            startedGeneration === generation
          ) {
            failed(
              new CdpFault("frame", "The live frame could not be rendered."),
            );
          }
        })(),
        Reason.DomCallback,
        "browser frame rendering",
      );
    }
  }

  function invalidate(): void {
    generation++;
    queued = null;
  }

  function reset(): void {
    invalidate();
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function dispose(): void {
    disposed = true;
    reset();
  }

  /** Decoding, validation and painting fail as one frame; images close here. */
  async function render(frame: QueuedFrame): Promise<void> {
    const image = await decode(frame.data);
    using _image = {
      [Symbol.dispose]: () => {
        return image.close();
      },
    };
    if (disposed || frame.generation !== generation) {
      return;
    }
    const raster = frameRaster(image);
    if (frame.accept && !frame.accept(raster)) {
      return;
    }
    // Admission can synchronously invalidate or dispose this sink.
    if (disposed || frame.generation !== generation) {
      return;
    }
    if (canvas.width !== image.width) {
      canvas.width = image.width;
    }
    if (canvas.height !== image.height) {
      canvas.height = image.height;
    }
    context.drawImage(image.source, 0, 0);
    frame.painted(raster);
  }

  async function drain(): Promise<void> {
    decoding = true;
    // Native decode ownership must end even if a resource or callback throws.
    using _decoding = {
      [Symbol.dispose]: () => {
        decoding = false;
      },
    };
    while (queued && !disposed) {
      const frame = queued;
      queued = null;
      const [rendered] = await Promise.allSettled([render(frame)]);
      if (
        rendered.status === "rejected" &&
        !disposed &&
        frame.generation === generation
      ) {
        frame.failed(
          rendered.reason instanceof CdpFault
            ? rendered.reason
            : new CdpFault("frame", "The browser frame could not be decoded."),
        );
      }
    }
  }

  return { push, invalidate, reset, dispose };
}
