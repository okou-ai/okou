import pdfMake from "pdfmake/build/pdfmake";

import { buildMessagePdfDocument } from "./document.ts";
import { createPdfMathRenderer } from "./math.ts";
import type { PdfWorkerRequest } from "./types.ts";

function fontBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x80_00) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x80_00)));
  }
  return btoa(parts.join(""));
}

export async function renderMessagePdf(
  request: PdfWorkerRequest,
): Promise<Blob> {
  pdfMake.addVirtualFileSystem({
    "NotoSans-Regular.otf": fontBase64(request.regularFont),
    "NotoSans-Bold.otf": fontBase64(request.boldFont),
  });
  for (const [name, buffer] of [
    ["Sarasa-Italic.ttf", request.italicFont],
    ["Sarasa-BoldItalic.ttf", request.boldItalicFont],
    ["NotoEmoji.woff", request.emojiFont],
  ] as const) {
    if (buffer) {
      pdfMake.addVirtualFileSystem({ [name]: fontBase64(buffer) });
    }
  }
  pdfMake.addFonts({
    NotoSans: {
      normal: "NotoSans-Regular.otf",
      bold: "NotoSans-Bold.otf",
      italics: "Sarasa-Italic.ttf",
      bolditalics: "Sarasa-BoldItalic.ttf",
    },
    NotoEmoji: {
      normal: "NotoEmoji.woff",
      bold: "NotoEmoji.woff",
      italics: "NotoEmoji.woff",
      bolditalics: "NotoEmoji.woff",
    },
  });
  const definition = buildMessagePdfDocument(
    request.tree,
    request.assets,
    createPdfMathRenderer(),
    request.baseUrl,
  );
  // PDFKit embeds only used glyphs from the CJK OpenType fonts.
  return await pdfMake.createPdf(definition).getBlob();
}
