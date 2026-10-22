import boldFontUrl from "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Bold.otf?url";
import regularFontUrl from "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf?url";
import type { Root } from "hast";

import { createDeferredPromise } from "../../signals/utils.ts";
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
  const [assets, regularFont, boldFont] = await Promise.all([
    preparePdfAssets(tree, imageUrls, signal),
    loadFont(regularFontUrl, signal),
    loadFont(boldFontUrl, signal),
  ]);
  signal.throwIfAborted();
  const worker = new Worker(
    new URL("./message-pdf-worker.ts", import.meta.url),
    {
      type: "module",
    },
  );
  const result = createDeferredPromise<Blob>(signal);
  worker.addEventListener(
    "message",
    (event: MessageEvent<PdfWorkerResponse>) => {
      if (result.settled()) {
        return;
      }
      if (event.data.ok) {
        result.resolve(event.data.blob);
      } else {
        result.reject(new Error("PDF export worker could not complete"));
      }
    },
    { signal },
  );
  const onError = () => {
    if (!result.settled()) {
      result.reject(new Error("PDF export worker could not complete"));
    }
  };
  worker.addEventListener("error", onError, { signal });
  worker.addEventListener("messageerror", onError, { signal });
  signal.addEventListener(
    "abort",
    () => {
      worker.terminate();
    },
    { once: true },
  );
  const request: PdfWorkerRequest = {
    baseUrl: location.href,
    tree,
    assets,
    regularFont,
    boldFont,
  };
  worker.postMessage(request, [regularFont, boldFont]);
  return result.promise;
}
