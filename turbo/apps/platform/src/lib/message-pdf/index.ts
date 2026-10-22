import boldFontUrl from "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Bold.otf?url";
import regularFontUrl from "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf?url";
import type { Root } from "hast";

import { createDeferredPromise, withCleanup } from "../../signals/utils.ts";
import { preparePdfAssets } from "./assets.ts";
import { parseMessagePdfTree } from "./document.ts";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./types.ts";
import { readPdfResource } from "./urls.ts";

async function loadFont(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await readPdfResource(url, "default", signal);
  return response.arrayBuffer();
}

/** Export independently parsed Markdown responses. Invoke only from the export command. */
export async function generateMessagePdfBlob(
  contents: readonly string[],
  imageUrls: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  // Reference labels belong to each message, not the combined document.
  const tree: Root = {
    type: "root",
    children: contents.flatMap((content) => {
      return parseMessagePdfTree(content).children;
    }),
  };
  const worker = new Worker(
    new URL("./message-pdf-worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  const result = createDeferredPromise<Blob>(signal);
  const onMessage = (event: MessageEvent<PdfWorkerResponse>) => {
    if (result.settled()) {
      return;
    }
    if (event.data.ok) {
      result.resolve(event.data.blob);
    } else {
      result.reject(new Error(event.data.message));
    }
  };
  const onError = () => {
    if (!result.settled()) {
      result.reject(new Error("PDF export worker could not complete"));
    }
  };
  const onAbort = () => {
    worker.terminate();
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onError);
  signal.addEventListener("abort", onAbort, { once: true });
  return await withCleanup(
    (async () => {
      const [assets, regularFont, boldFont] = await Promise.all([
        preparePdfAssets(tree, imageUrls, signal),
        loadFont(regularFontUrl, signal),
        loadFont(boldFontUrl, signal),
      ]);
      signal.throwIfAborted();
      const request: PdfWorkerRequest = {
        baseUrl: location.href,
        tree,
        assets,
        regularFont,
        boldFont,
      };
      worker.postMessage(request, [regularFont, boldFont]);
      return result.promise;
    })(),
    () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      // A preparation failure must also release the deferred's abort listener.
      if (!result.settled()) {
        result.reject(
          new Error("PDF export stopped before document generation"),
        );
      }
    },
  );
}
