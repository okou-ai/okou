import { z } from "zod";
import type { SandboxChannelPeer } from "@okouai/core/sandbox-channel-peer";
import { sandboxFileOffsetSchema } from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import {
  createDeferredPromise,
  onRejection,
  withCleanup,
  type DeferredPromise,
} from "../signals/utils.ts";

const SCRIPT = __OKOU_FILE_DOWNLOAD_WORKER_PATH__;
const SCOPE = "/sandbox-file-downloads/v1/";
const IDLE_MS = 30_000;
const messageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    version: z.literal(1),
    id: z.uuid(),
  }),
  z.strictObject({
    type: z.literal("pull"),
    offset: sandboxFileOffsetSchema,
    length: z.int().min(1).max(32_768),
  }),
  z.strictObject({
    type: z.literal("complete"),
  }),
  z.strictObject({
    type: z.literal("cancelled"),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.enum(["unavailable", "updateRequired"]),
  }),
]);
type DownloadMessage = z.infer<typeof messageSchema>;

export class FileDownloadError extends Error {
  constructor(readonly code: "unavailable" | "updateRequired" | "cancelled") {
    super(`File download ${code}`);
  }
}

export function canStreamSandboxDownload(): boolean {
  return (
    globalThis.isSecureContext &&
    typeof navigator.serviceWorker?.register === "function" &&
    typeof MessageChannel === "function" &&
    typeof ReadableStream === "function"
  );
}

export async function downloadWorker(
  signal: AbortSignal,
): Promise<ServiceWorker> {
  signal.throwIfAborted();
  if (!canStreamSandboxDownload()) {
    throw new FileDownloadError("unavailable");
  }
  const registration = await navigator.serviceWorker.register(SCRIPT, {
    scope: SCOPE,
    updateViaCache: "none",
  });
  signal.throwIfAborted();
  const worker =
    registration.active ?? registration.installing ?? registration.waiting;
  if (!worker || worker.scriptURL !== new URL(SCRIPT, location.origin).href) {
    throw new FileDownloadError("updateRequired");
  }
  if (worker.state === "activated") {
    return worker;
  }
  const ready = createDeferredPromise<ServiceWorker>(
    AbortSignal.any([signal, AbortSignal.timeout(IDLE_MS)]),
  );
  const inspect = () => {
    if (ready.settled()) {
      return;
    }
    if (worker.state === "activated") {
      ready.resolve(worker);
    } else if (worker.state === "redundant") {
      ready.reject(new FileDownloadError("updateRequired"));
    }
  };
  worker.addEventListener("statechange", inspect);
  inspect();
  return await withCleanup(ready.promise, () => {
    worker.removeEventListener("statechange", inspect);
  });
}

/** One bounded port queue; a failed consumer closes its dedicated WSS source. */
export class SandboxFileDownload {
  readonly id = crypto.randomUUID();
  readonly url = new URL(SCOPE + this.id, location.origin).href;
  private readonly channel: MessageChannel;
  private pending: DeferredPromise<DownloadMessage> | null = null;
  private queued: DownloadMessage | null = null;
  private closed = false;
  failure: FileDownloadError | null = null;

  constructor(
    private readonly peer: SandboxChannelPeer,
    private readonly signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.channel = new MessageChannel();
    this.channel.port1.addEventListener("message", this.receive);
    this.channel.port1.addEventListener("messageerror", this.messageError);
    signal.addEventListener("abort", this.abort, { once: true });
    this.channel.port1.start();
  }

  async prepare(
    worker: ServiceWorker,
    size: string,
    name: string,
  ): Promise<string> {
    this.signal.throwIfAborted();
    worker.postMessage(
      { type: "prepare", version: 1, id: this.id, size, name },
      [this.channel.port2],
    );
    const result = await this.next();
    this.signal.throwIfAborted();
    if (this.failure || this.closed) {
      throw this.failure ?? new FileDownloadError("unavailable");
    }
    if (result.type !== "ready" || result.id !== this.id) {
      throw new FileDownloadError("updateRequired");
    }
    return this.url;
  }

  async next(): Promise<DownloadMessage> {
    this.signal.throwIfAborted();
    if (this.failure) {
      throw this.failure;
    }
    if (this.queued) {
      const value = this.queued;
      this.queued = null;
      return value;
    }
    if (this.closed || this.pending) {
      throw new FileDownloadError("unavailable");
    }
    const deadline = AbortSignal.timeout(IDLE_MS);
    const pending = createDeferredPromise<DownloadMessage>(
      AbortSignal.any([this.signal, deadline]),
    );
    this.pending = pending;
    return await onRejection(pending.promise, () => {
      if (deadline.aborted) {
        this.fail(new FileDownloadError("unavailable"));
      }
    });
  }

  chunk(offset: string, data: Uint8Array<ArrayBuffer>, final: boolean): void {
    this.signal.throwIfAborted();
    if (this.closed || this.failure) {
      throw this.failure ?? new FileDownloadError("unavailable");
    }
    this.channel.port1.postMessage(
      { type: "chunk", offset, data: data.buffer, final },
      [data.buffer],
    );
  }

  fail(error: FileDownloadError): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    this.close();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.channel.port1.postMessage({ type: "abort" });
    this.channel.port1.removeEventListener("message", this.receive);
    this.channel.port1.removeEventListener("messageerror", this.messageError);
    this.channel.port1.close();
    this.channel.port2.close();
    this.signal.removeEventListener("abort", this.abort);
    this.peer.close();
    if (this.pending && !this.pending.settled()) {
      this.pending.reject(
        this.failure ?? new DOMException("Download closed", "AbortError"),
      );
    }
    this.pending = null;
    this.queued = null;
  }

  private readonly abort = () => {
    return this.close();
  };
  private readonly messageError = () => {
    return this.fail(new FileDownloadError("unavailable"));
  };
  private readonly receive = (event: MessageEvent<unknown>) => {
    if (this.closed) {
      return;
    }
    const result = messageSchema.safeParse(event.data);
    if (!result.success) {
      this.fail(new FileDownloadError("unavailable"));
      return;
    }
    const value = result.data;
    if (value.type === "error" || value.type === "cancelled") {
      this.fail(
        new FileDownloadError(
          value.type === "cancelled" ? "cancelled" : value.code,
        ),
      );
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending && !pending.settled()) {
      pending.resolve(value);
    } else if (this.queued) {
      this.fail(new FileDownloadError("unavailable"));
    } else {
      this.queued = value;
    }
  };
}
