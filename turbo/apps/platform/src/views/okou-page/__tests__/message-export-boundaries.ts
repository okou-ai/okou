import { readFileSync } from "node:fs";
import { HttpResponse } from "msw";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderMessagePdf } from "../../../lib/message-pdf/render.ts";
import type { PdfWorkerRequest } from "../../../lib/message-pdf/types.ts";
import { platformMessagePdfFontUrls } from "../../../lib/static-assets.ts";
import { chatThreadPdfFilenameContract } from "@okouai/api-contracts/contracts/chat-thread-pdf-filename";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
export function pdfServices(
  context: TestContext,
  filename: string | Promise<string>,
) {
  context.mocks.api(
    chatThreadPdfFilenameContract.generate,
    async ({ respond }) => {
      return respond(200, await filename);
    },
  );
  const fonts = {
    regular: "NotoSansCJKsc-Regular.otf",
    bold: "NotoSansCJKsc-Bold.otf",
    italic: "sarasa-gothic-sc-italic.ttf",
    boldItalic: "sarasa-gothic-sc-bolditalic.ttf",
    emoji: "noto-emoji-emoji-400-normal.woff",
  } as const;
  for (const key of Object.keys(fonts) as (keyof typeof fonts)[]) {
    context.mocks.http.get(platformMessagePdfFontUrls[key], () => {
      return new HttpResponse(
        Uint8Array.from(
          readFileSync(
            new URL(
              "../../../../test-fixtures/message-pdf-fonts/" + fonts[key],
              import.meta.url,
            ),
          ),
        ),
      );
    });
  }
  context.mocks.browser.dedicatedWorker(async (request) => {
    return {
      ok: true,
      blob: await renderMessagePdf(request as PdfWorkerRequest),
    };
  });
  return context.mocks.browser.blobDownload();
}

export async function readSavedPdf(blob: Blob) {
  const reader = getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    useSystemFonts: false,
    disableFontFace: true,
    fontExtraProperties: true,
  });
  try {
    const pdf = await reader.promise;
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      await page.getOperatorList();
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) => {
        if (!("str" in item) || item.str.trim() === "") {
          return [];
        }
        const font = page.commonObjs.get(item.fontName) as { name: string };
        return [
          {
            text: item.str,
            x: item.transform[4] as number,
            width: item.width,
            font: font.name,
          },
        ];
      });
      pages.push({
        items,
        width: page.getViewport({ scale: 1 }).width,
        text: items
          .map((item) => {
            return item.text;
          })
          .join(" "),
      });
    }
    return pages;
  } finally {
    await reader.destroy();
  }
}
