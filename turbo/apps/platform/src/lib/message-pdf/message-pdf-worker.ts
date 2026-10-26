import { renderMessagePdf } from "./render.ts";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./types.ts";

interface PdfWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PdfWorkerRequest>) => Promise<void>,
  ): void;
  postMessage(message: PdfWorkerResponse): void;
}

// This module has a worker-only Vite entry; the app's tsconfig includes DOM,
// not WebWorker globals, so describe only the messaging surface we actually use.
const scope = globalThis as unknown as PdfWorkerScope;
scope.addEventListener("message", async (event) => {
  // This is the serialization/error boundary: errors must reach the owner so
  // it can reject the export and terminate this single-use worker.
  const [result] = await Promise.allSettled([renderMessagePdf(event.data)]);
  if (result.status === "fulfilled") {
    scope.postMessage({ ok: true, blob: result.value });
  } else {
    // Vendor exceptions can contain authored text or private asset URLs.
    // Send only the outcome; the owning UI localizes the failure message.
    scope.postMessage({ ok: false });
  }
});
