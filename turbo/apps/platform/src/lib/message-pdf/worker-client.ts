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
  const onError = () => {
    if (!result.settled()) {
      result.reject(new Error("Document export worker could not complete"));
    }
  };
  worker.addEventListener(
    "message",
    (event: MessageEvent<PdfWorkerResponse>) => {
      if (!result.settled() && event.data.ok) {
        result.resolve(event.data.blob);
      } else {
        onError();
      }
    },
    { signal },
  );
  worker.addEventListener("error", onError, { signal });
  worker.addEventListener("messageerror", onError, { signal });
  try {
    worker.postMessage(request, transfer);
    return await result.promise;
  } finally {
    worker.terminate();
  }
}
