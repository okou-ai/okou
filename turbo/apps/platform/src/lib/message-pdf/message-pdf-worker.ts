import pdfMake from "pdfmake/build/pdfmake";

import { buildMessagePdfDocument } from "./document.ts";
import { createPdfMathRenderer } from "./math.ts";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./types.ts";

interface PdfWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PdfWorkerRequest>) => Promise<void>,
  ): void;
  postMessage(message: PdfWorkerResponse): void;
}

function fontBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x80_00) {
    parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x80_00)));
  }
  return btoa(parts.join(""));
}

async function renderPdf(request: PdfWorkerRequest): Promise<Blob> {
  pdfMake.addVirtualFileSystem({
    "NotoSans-Regular.otf": fontBase64(request.regularFont),
    "NotoSans-Bold.otf": fontBase64(request.boldFont),
  });
  pdfMake.addFonts({
    NotoSans: {
      normal: "NotoSans-Regular.otf",
      bold: "NotoSans-Bold.otf",
      italics: "NotoSans-Regular.otf",
      bolditalics: "NotoSans-Bold.otf",
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

// This module has a worker-only Vite entry; the app's tsconfig includes DOM,
// not WebWorker globals, so describe only the messaging surface we actually use.
const scope = globalThis as unknown as PdfWorkerScope;
scope.addEventListener("message", async (event) => {
  // This is the serialization/error boundary: errors must reach the owner so
  // it can reject the export and terminate this single-use worker.
  const [result] = await Promise.allSettled([renderPdf(event.data)]);
  if (result.status === "fulfilled") {
    scope.postMessage({ ok: true, blob: result.value });
  } else {
    // Vendor exceptions can contain authored text or private asset URLs.
    scope.postMessage({
      ok: false,
      message: "PDF generation failed. Check formulas and document content.",
    });
  }
});
