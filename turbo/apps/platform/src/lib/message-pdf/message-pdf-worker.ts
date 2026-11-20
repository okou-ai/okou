import "../../polyfill.ts";
import "@formatjs/intl-segmenter/polyfill.js";

import { renderMarkdownDocx } from "../markdown-docx/render.ts";
import { renderMessagePdf } from "./render.ts";
import type {
  DocumentExportRequest,
  DocumentExportWorkerReadyMessage,
  PdfWorkerResponse,
} from "./types.ts";

interface DocumentExportScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => Promise<void>,
  ): void;
  postMessage(
    message: PdfWorkerResponse | DocumentExportWorkerReadyMessage,
  ): void;
}

// This module has a worker-only Vite entry; the app's tsconfig includes DOM,
// not WebWorker globals, so describe only the messaging surface we actually use.
const scope = globalThis as unknown as DocumentExportScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isDocumentExportRequest(
  value: unknown,
): value is DocumentExportRequest {
  if (!isRecord(value)) {
    return false;
  }
  if ("kind" in value) {
    return (
      value.kind === "docx" &&
      isRecord(value.input) &&
      typeof value.input.source === "string" &&
      isRecord(value.input.assets) &&
      typeof value.input.baseUrl === "string"
    );
  }
  return (
    typeof value.baseUrl === "string" &&
    isRecord(value.tree) &&
    isRecord(value.assets) &&
    isArrayBuffer(value.regularFont) &&
    isArrayBuffer(value.boldFont)
  );
}

scope.addEventListener("message", async (event) => {
  if (!isDocumentExportRequest(event.data)) {
    scope.postMessage({ ok: false, failure: "message_decode" });
    return;
  }
  // This is the serialization/error boundary: errors must reach the owner so
  // it can reject the export and terminate this single-use worker.
  const request = event.data;
  const [result] = await Promise.allSettled([
    "kind" in request
      ? renderMarkdownDocx(request.input)
      : renderMessagePdf(request),
  ]);
  if (result.status === "fulfilled") {
    scope.postMessage({ ok: true, blob: result.value });
  } else {
    // Vendor exceptions can contain authored text or private asset URLs.
    // Send only a fixed failure stage; the owning UI localizes the error.
    scope.postMessage({ ok: false, failure: "render_rejection" });
  }
});

// The owner uses this signal only to distinguish bootstrap from runtime errors.
scope.postMessage({ ready: true });
