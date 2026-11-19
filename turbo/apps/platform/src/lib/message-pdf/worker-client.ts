import { createDeferredPromise } from "../../signals/utils.ts";
import type { DocumentExportRequest, PdfWorkerResponse } from "./types.ts";

export async function runDocumentExportWorker(
  request: DocumentExportRequest,
  signal: AbortSignal,
  transfer: ArrayBuffer[] = [],
): Promise<Blob> {
  signal.throwIfAborted();
  const worker = new Worker(
    new URL("./message-pdf-worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  const result = createDeferredPromise<Blob>({ rejection: "owner" }, signal);
  const stopWorker = () => {
    signal.removeEventListener("abort", stopWorker);
    worker.terminate();
  };
  signal.addEventListener("abort", stopWorker, { once: true });
  const onError = () => {
    if (!result.settled()) {
      result.reject(new Error("Document export worker could not complete"));
      stopWorker();
    }
  };
  worker.addEventListener(
    "message",
    (event: MessageEvent<PdfWorkerResponse>) => {
      if (!result.settled() && event.data.ok) {
        result.resolve(event.data.blob);
        stopWorker();
      } else {
        onError();
      }
    },
    { signal },
  );
  worker.addEventListener("error", onError, { signal });
  worker.addEventListener("messageerror", onError, { signal });
  worker.postMessage(request, transfer);
  return await result.promise;
}
