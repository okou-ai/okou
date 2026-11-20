import { createDeferredPromise } from "../../signals/utils.ts";
import type {
  DocumentExportFailurePhase,
  DocumentExportFormat,
  DocumentExportRequest,
  DocumentExportWorkerReadyMessage,
  PdfWorkerResponse,
} from "./types.ts";

export class DocumentExportWorkerError extends Error {
  constructor(
    readonly format: DocumentExportFormat,
    readonly phase: DocumentExportFailurePhase,
  ) {
    super(
      `Document export worker could not complete (format=${format}, phase=${phase})`,
    );
    this.name = "DocumentExportWorkerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReadyMessage(
  value: unknown,
): value is DocumentExportWorkerReadyMessage {
  return isRecord(value) && value.ready === true;
}

function isWorkerResponse(value: unknown): value is PdfWorkerResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return value.blob instanceof Blob;
  }
  return (
    value.ok === false &&
    (value.failure === undefined ||
      value.failure === "message_decode" ||
      value.failure === "render_rejection")
  );
}

export async function runDocumentExportWorker(
  request: DocumentExportRequest,
  signal: AbortSignal,
  transfer: ArrayBuffer[] = [],
): Promise<Blob> {
  signal.throwIfAborted();
  const format: DocumentExportFormat =
    "kind" in request && request.kind === "docx" ? "docx" : "pdf";
  const result = createDeferredPromise<Blob>({ rejection: "owner" }, signal);
  let worker: Worker | undefined;
  let ready = false;
  let terminated = false;
  const stopWorker = () => {
    if (terminated) {
      return;
    }
    terminated = true;
    signal.removeEventListener("abort", stopWorker);
    worker?.terminate();
  };
  const fail = (phase: DocumentExportFailurePhase) => {
    if (!result.settled()) {
      result.reject(new DocumentExportWorkerError(format, phase));
      stopWorker();
    }
  };
  const onError = () => {
    fail(ready ? "native_error" : "bootstrap");
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    if (isReadyMessage(event.data)) {
      ready = true;
      return;
    }
    if (!isWorkerResponse(event.data)) {
      fail("message_decode");
    } else if (event.data.ok) {
      if (!result.settled()) {
        result.resolve(event.data.blob);
        stopWorker();
      }
    } else {
      fail(
        event.data.failure === "message_decode"
          ? "message_decode"
          : "render_rejection",
      );
    }
  };
  signal.addEventListener("abort", stopWorker, { once: true });
  if (signal.aborted) {
    stopWorker();
    return await result.promise;
  }

  let phase: DocumentExportFailurePhase = "bootstrap";
  const operation = (async () => {
    worker = new Worker(new URL("./message-pdf-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", onMessage, { signal });
    worker.addEventListener("error", onError, { signal });
    worker.addEventListener(
      "messageerror",
      () => {
        fail("message_decode");
      },
      { signal },
    );
    signal.throwIfAborted();
    phase = "message_decode";
    worker.postMessage(request, transfer);
    const blob = await result.promise;
    return blob;
  })();
  const [completion] = await Promise.allSettled([operation]);
  if (completion?.status === "rejected" && !result.settled()) {
    signal.throwIfAborted();
    fail(phase);
  }
  return await result.promise;
}
