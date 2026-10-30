import { detach, Reason } from "../../utils.ts";

import { CdpFault } from "../cdp/errors.ts";
import type { BrowserByteArrayConstructor } from "../browser.ts";
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

/** One active decode and one latest queued frame; no per-frame React state. */
export class CanvasRenderer implements FrameSink {
  private readonly context: CanvasRenderingContext2D;
  private generation = 0;
  private queued: QueuedFrame | null = null;
  private decoding = false;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly decode: Decode = decodeImage,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new CdpFault("frame", "Canvas 2D is unavailable.");
    }
    this.context = context;
  }

  push(
    data: string,
    painted: (raster: Viewport) => void,
    failed: (error: CdpFault) => void,
    accept?: (raster: Viewport) => boolean,
  ): void {
    if (this.disposed) {
      return;
    }
    if (data.length > maximumEncodedFrameLength) {
      failed(new CdpFault("frame", "The browser sent an oversized frame."));
      return;
    }
    this.queued = {
      data,
      generation: this.generation,
      painted,
      failed,
      accept,
    };
    if (!this.decoding) {
      const generation = this.generation;
      detach(
        (async () => {
          const [reply1] = await Promise.allSettled([this.drain()]);
          if (reply1.status === "fulfilled") {
            return reply1.value;
          }
          if (!this.disposed && generation === this.generation) {
            failed(
              new CdpFault("frame", "The live frame could not be rendered."),
            );
          }

          return;
        })(),
        Reason.DomCallback,
        "browser operation",
      );
    }
  }

  invalidate(): void {
    this.generation++;
    this.queued = null;
  }

  reset(): void {
    this.invalidate();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private async drain(): Promise<void> {
    this.decoding = true;
    while (this.queued && !this.disposed) {
      const frame = this.queued;
      this.queued = null;
      const [rendered] = await Promise.allSettled([this.renderFrame(frame)]);
      if (
        rendered.status === "rejected" &&
        !this.disposed &&
        frame.generation === this.generation
      ) {
        frame.failed(
          rendered.reason instanceof CdpFault
            ? rendered.reason
            : new CdpFault("frame", "The browser frame could not be decoded."),
        );
      }
    }
    this.decoding = false;
  }

  /** Decoded resources remain owned here through validation and painting. */
  private async renderFrame(frame: QueuedFrame): Promise<void> {
    const image = await this.decode(frame.data);
    using _image = {
      [Symbol.dispose]: () => {
        image.close();
      },
    };
    if (this.disposed || frame.generation !== this.generation) {
      return;
    }
    if (
      image.width < 1 ||
      image.height < 1 ||
      image.width > maximumFrameDimension ||
      image.height > maximumFrameDimension ||
      image.width * image.height > maximumFrameArea
    ) {
      throw new CdpFault("frame", "The browser sent invalid frame dimensions.");
    }
    const raster = { width: image.width, height: image.height };
    if (frame.accept && !frame.accept(raster)) {
      return;
    }
    if (this.canvas.width !== image.width) {
      this.canvas.width = image.width;
    }
    if (this.canvas.height !== image.height) {
      this.canvas.height = image.height;
    }
    this.context.drawImage(image.source, 0, 0);
    frame.painted(raster);
  }
}
