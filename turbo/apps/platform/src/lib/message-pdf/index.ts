import boldFontUrl from "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Bold.otf?url";
import regularFontUrl from "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf?url";
import italicFontUrl from "@fontpkg/sarasa-gothic-sc/sarasa-gothic-sc-italic.ttf?url";
import boldItalicFontUrl from "@fontpkg/sarasa-gothic-sc/sarasa-gothic-sc-bolditalic.ttf?url";
import emojiFontUrl from "@fontsource/noto-emoji/files/noto-emoji-emoji-400-normal.woff?url";
import type { Root, RootContent } from "hast";

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

function requiredExtraFonts(tree: Root) {
  const needed = { italic: false, boldItalic: false, emoji: false };
  const visit = (node: RootContent, bold: boolean, italic: boolean): void => {
    if (node.type === "text") {
      // Whitespace runs retain their emphasis during PDF font measurement.
      if (node.value) {
        needed.italic ||= italic && !bold;
        needed.boldItalic ||= italic && bold;
        needed.emoji ||= /[\p{Emoji_Presentation}\uFE0F\u20E3]/u.test(
          node.value,
        );
      }
    } else if (node.type === "element") {
      for (const child of node.children) {
        visit(
          child,
          bold || /^(b|strong|th|h[1-6])$/u.test(node.tagName),
          italic || /^(i|em)$/u.test(node.tagName),
        );
      }
    }
  };
  for (const child of tree.children) {
    visit(child, false, false);
  }
  return needed;
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
  const needed = requiredExtraFonts(tree);
  const [assets, regularFont, boldFont, italicFont, boldItalicFont, emojiFont] =
    await Promise.all([
      preparePdfAssets(tree, imageUrls, signal),
      loadFont(regularFontUrl, signal),
      loadFont(boldFontUrl, signal),
      needed.italic ? loadFont(italicFontUrl, signal) : undefined,
      needed.boldItalic ? loadFont(boldItalicFontUrl, signal) : undefined,
      needed.emoji ? loadFont(emojiFontUrl, signal) : undefined,
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
    italicFont,
    boldItalicFont,
    emojiFont,
  };
  const fonts = [
    regularFont,
    boldFont,
    italicFont,
    boldItalicFont,
    emojiFont,
  ].filter((font): font is ArrayBuffer => {
    return font !== undefined;
  });
  worker.postMessage(request, fonts);
  return result.promise;
}
