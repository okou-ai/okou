import { readFile, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import {
  MessageChannel as NativeMessageChannel,
  MessagePort as NativeMessagePort,
} from "node:worker_threads";
import { expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createDeferredPromise,
  detach,
  Reason,
} from "../../../signals/utils.ts";
import {
  entry,
  listing,
  filesButton,
  type FilesRequest,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

/** The external browser sink runs the actual worker and saves real temp files. */
export async function downloadBrowser(
  context: TestContext,
  options: {
    readonly holdWrite?: boolean;
    readonly holdNavigation?: boolean;
    readonly registration?: Promise<void>;
    readonly staleWorker?: boolean;
  } = {},
) {
  const source = await readFile(
    path.resolve(
      import.meta.dirname,
      "../../../../public/sandbox-file-download-sw.js",
    ),
    "utf8",
  );
  const root = await mkdtemp(path.join(tmpdir(), "activity-download-"));
  const outcome = createDeferredPromise<{
    readonly saved: boolean;
    readonly file: string;
    readonly headers: Headers;
  }>(context.signal);
  const firstChunk = createDeferredPromise<void>(context.signal);
  const navigationRequested = createDeferredPromise<void>(context.signal);
  const registered = createDeferredPromise<void>(context.signal);
  const writeGate = createDeferredPromise<void>(context.signal);
  const listeners = new Map<string, (event: unknown) => void>();
  vi.stubGlobal("MessageChannel", NativeMessageChannel);
  vi.stubGlobal("MessagePort", NativeMessagePort);
  runInNewContext(source, {
    self: {
      location: new URL("https://app.okou.ai/sandbox-file-download-sw.js"),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
    },
    Map,
    Promise,
    ArrayBuffer: structuredClone(new ArrayBuffer(0)).constructor,
    Uint8Array,
    ReadableStream,
    Response,
    URL,
    TextEncoder,
    Error,
  });
  context.mocks.browser.serviceWorker();
  vi.stubGlobal("isSecureContext", true);
  const worker = Object.assign(new EventTarget(), {
    state: "activated",
    scriptURL: options.staleWorker
      ? "https://app.okou.ai/sandbox-file-download-stale-sw.js"
      : "https://app.okou.ai/sandbox-file-download-sw.js",
    postMessage(data: unknown, transfer: Transferable[] = []) {
      const transferred = structuredClone(
        { data, ports: transfer },
        { transfer },
      );
      const port = transferred.ports[0];
      if (transferred.ports.length === 0) {
        listeners.get("message")?.({
          data: transferred.data,
          ports: [],
          source: {
            type: "window",
            id: "page",
            url: "https://app.okou.ai/activities/run",
          },
        });
        return;
      }
      if (!(port instanceof NativeMessagePort)) {
        throw new Error("Expected a transferred MessagePort");
      }
      listeners.get("message")?.({
        data: transferred.data,
        ports: [port],
        source: {
          type: "window",
          id: "page",
          url: "https://app.okou.ai/activities/run",
        },
      });
    },
  });
  let registrations = 0;
  Object.assign(navigator.serviceWorker, {
    async register(script: string) {
      if (script !== "/sandbox-file-download-sw.js") {
        return { active: null };
      }
      if (!registered.settled()) {
        registered.resolve();
      }
      if (registrations++ === 0) {
        await options.registration;
      }
      return { active: worker };
    },
  });
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const request = (input: Request) => {
    const result = createDeferredPromise<Response>(context.signal);
    listeners.get("fetch")?.({
      request: input,
      respondWith(response: Response) {
        result.resolve(response);
      },
      waitUntil(work: Promise<void>) {
        detach(work, Reason.Deferred, "browser worker lifetime");
      },
    });
    return result.promise;
  };
  const consume = async (frame: HTMLIFrameElement) => {
    if (!navigationRequested.settled()) {
      navigationRequested.resolve();
    }
    if (options.holdNavigation) {
      await writeGate.promise;
    }
    const file = path.join(root, "download.bin");
    if (!frame.isConnected) {
      if (!outcome.settled()) {
        outcome.resolve({ saved: false, file, headers: new Headers() });
      }
      return;
    }
    const response = await request(new Request(frame.src));
    const temporary = path.join(root, "download.partial");
    const handle = await open(temporary, "w");
    const reader = response.body?.getReader();
    if (reader) {
      readers.add(reader);
    }
    let received = 0n;
    try {
      if (response.status !== 200) {
        throw new Error("Download response failed");
      }
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        await handle.write(chunk.value);
        received += BigInt(chunk.value.byteLength);
        if (!firstChunk.settled()) {
          firstChunk.resolve();
        }
        if (options.holdWrite) {
          await writeGate.promise;
        }
        context.signal.throwIfAborted();
      }
      if (received !== BigInt(response.headers.get("Content-Length") ?? "-1")) {
        throw new Error("Incomplete download");
      }
      await handle.close();
      await rename(temporary, file);
      if (!outcome.settled()) {
        outcome.resolve({ saved: true, file, headers: response.headers });
      }
    } catch {
      await handle.close();
      if (!outcome.settled()) {
        outcome.resolve({ saved: false, file, headers: response.headers });
      }
    } finally {
      if (reader) {
        readers.delete(reader);
        reader.releaseLock();
      }
    }
  };
  const seen = new Set<string>();
  const observer = new MutationObserver(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="/sandbox-file-downloads/"]',
    )) {
      if (seen.has(frame.src)) {
        continue;
      }
      seen.add(frame.src);
      detach(consume(frame), Reason.Deferred, "native browser download");
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  context.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      for (const reader of readers) {
        detach(reader.cancel(), Reason.Deferred, "browser teardown");
      }
      detach(
        rm(root, { recursive: true, force: true }),
        Reason.Deferred,
        "download fixture files",
      );
    },
    { once: true },
  );
  return {
    outcome: outcome.promise,
    firstChunk: firstChunk.promise,
    navigationRequested: navigationRequested.promise,
    registered: registered.promise,
    request,
    partialFile: path.join(root, "download.partial"),
    async cancelDownload() {
      for (const reader of readers) {
        await reader.cancel();
      }
      if (!writeGate.settled()) {
        writeGate.resolve();
      }
    },
    releaseWrite() {
      if (!writeGate.settled()) {
        writeGate.resolve();
      }
    },
  };
}

export function fileGuest(
  size: number | bigint,
  options: { readonly failFinish?: boolean; readonly name?: string } = {},
) {
  return (request: FilesRequest): FilesReply => {
    const name = options.name ?? "report.bin";
    switch (request.operation) {
      case "list": {
        return listing([entry(name)]);
      }
      case "open": {
        return {
          result: {
            handle: "file",
            nameToken: entry(name).nameToken,
            displayName: name,
            fileSize: String(size),
            selectedSize: String(size),
            truncated: false,
          },
        };
      }
      case "read": {
        const { offset, length } = request.params;
        if (typeof offset !== "string" || typeof length !== "number") {
          throw new Error("Invalid file request");
        }
        const pattern = Buffer.alloc(251);
        const phase = Number(BigInt(offset) % BigInt(pattern.length));
        for (let index = 0; index < pattern.length; index++) {
          pattern[index] = (phase + index) % pattern.length;
        }
        const data = Buffer.alloc(length, pattern);
        return { result: { offset, length, data: data.toString("base64") } };
      }
      case "finish": {
        return options.failFinish
          ? { error: { code: "file_changed" } }
          : { result: {} };
      }
      default: {
        return { result: {} };
      }
    }
  };
}

export async function readyDownload(
  panel: HTMLElement,
  name = "report.bin",
): Promise<HTMLElement> {
  return await waitFor(() => {
    const control = filesButton(`Download ${name}`, panel);
    expect(control).toBeEnabled();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    return control;
  });
}
