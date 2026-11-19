import type { PdfAssets } from "./message-pdf/types.ts";
import { runDocumentExportWorker } from "./message-pdf/worker-client.ts";

export function generateMarkdownDocxBlob(
  source: string,
  assets: PdfAssets,
  baseUrl: string,
  signal: AbortSignal,
): Promise<Blob> {
  return runDocumentExportWorker(
    { kind: "docx", input: { source, assets, baseUrl } },
    signal,
  );
}
