import type { Element, Root, RootContent } from "hast";

import { resolvePlatformEnvironment } from "../platform-host.ts";
import { fetchAppAsset } from "../resource-fetch.ts";
import {
  platformMessagePdfFontUrls,
  platformPreviewMessagePdfFontUrls,
} from "../static-assets.ts";
import { preparePdfAssets } from "./assets.ts";
import { parseMessagePdfTree } from "./document.ts";
import type { PdfWorkerRequest } from "./types.ts";
import { readPdfResource } from "./urls.ts";
import { runDocumentExportWorker } from "./worker-client.ts";

async function loadFont(
  url: string,
  production: boolean,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (production) {
    return (await readPdfResource(url, "default", signal)).arrayBuffer();
  }
  // The preview gateway serves the bundled font at the same asset path.
  const asset = new URL(url, location.href);
  const response = await fetchAppAsset(
    `${asset.pathname}${asset.search}`,
    signal,
  );
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

/** Use the same document tree for font selection and rendering of file labels. */
function linkFileCards(
  parent: Root | Element,
  fileCards: ReadonlyMap<string, string>,
  insideLink = false,
): void {
  for (const node of parent.children) {
    if (node.type !== "element") {
      continue;
    }
    const { src, alt } = node.properties;
    const filename =
      node.tagName === "img" && typeof src === "string"
        ? fileCards.get(src)
        : undefined;
    if (filename !== undefined) {
      // An enclosing Markdown link retains its authored destination. Otherwise
      // link the original artifact reference, never its temporary storage URL.
      node.tagName = insideLink ? "span" : "a";
      node.properties = insideLink ? {} : { href: src };
      node.children = [
        {
          type: "text",
          value: typeof alt === "string" && alt.trim() ? alt : filename,
        },
      ];
    } else {
      linkFileCards(node, fileCards, insideLink || node.tagName === "a");
    }
  }
}

/** Export independently parsed Markdown responses. Invoke only from the export command. */
export async function generateMessagePdfBlob(
  contents: readonly string[],
  resources: {
    readonly imageUrls: ReadonlyMap<string, string>;
    readonly fileCards?: ReadonlyMap<string, string>;
  },
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
  if (resources.fileCards?.size) {
    linkFileCards(tree, resources.fileCards);
  }
  const needed = requiredExtraFonts(tree);
  const production = resolvePlatformEnvironment() === "production";
  const fontUrls = production
    ? platformMessagePdfFontUrls
    : platformPreviewMessagePdfFontUrls;
  const readFont = (url: string) => {
    return loadFont(url, production, signal);
  };
  const [assets, regularFont, boldFont, italicFont, boldItalicFont, emojiFont] =
    await Promise.all([
      preparePdfAssets(tree, resources.imageUrls, signal),
      readFont(fontUrls.regular),
      readFont(fontUrls.bold),
      needed.italic ? readFont(fontUrls.italic) : undefined,
      needed.boldItalic ? readFont(fontUrls.boldItalic) : undefined,
      needed.emoji ? readFont(fontUrls.emoji) : undefined,
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
