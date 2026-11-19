import type { Root, RootContent } from "hast";

import { fetchAppAsset } from "../resource-fetch.ts";
import { platformMessagePdfFontUrls } from "../static-assets.ts";
import { preparePdfAssets } from "./assets.ts";
import { parseMessagePdfTree } from "./document.ts";
import type { PdfWorkerRequest } from "./types.ts";
import { runDocumentExportWorker } from "./worker-client.ts";

async function loadFont(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetchAppAsset(url, signal);
  if (!response.ok) {
    throw new Error(`PDF font could not be loaded (${response.status})`);
  }
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
  baseUrl = location.href,
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
      loadFont(platformMessagePdfFontUrls.regular, signal),
      loadFont(platformMessagePdfFontUrls.bold, signal),
      needed.italic
        ? loadFont(platformMessagePdfFontUrls.italic, signal)
        : undefined,
      needed.boldItalic
        ? loadFont(platformMessagePdfFontUrls.boldItalic, signal)
        : undefined,
      needed.emoji
        ? loadFont(platformMessagePdfFontUrls.emoji, signal)
        : undefined,
    ]);
  const request: PdfWorkerRequest = {
    baseUrl,
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
  return runDocumentExportWorker(request, signal, fonts);
}
