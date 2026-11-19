import { command } from "ccstate";
import type { Root } from "hast";
import { visit } from "unist-util-visit";

import { preparePdfAssets } from "../../lib/message-pdf/assets.ts";
import { parseMessagePdfTree } from "../../lib/message-pdf/document.ts";
import { generateMarkdownDocxBlob } from "../../lib/markdown-docx.ts";
import { generateMessagePdfBlob } from "../../lib/message-pdf/index.ts";
import { fetchResource } from "../../lib/resource-fetch.ts";
import { triggerBlobDownload } from "../../views/okou-page/attachment-url.ts";
import { attachmentDownloadSource$ } from "../attachment-download-source.ts";

const MAX_MARKDOWN_EXPORT_BYTES = 5 * 1024 * 1024;

type MarkdownArtifactExportFormat = "pdf" | "docx";
type ResourceResolver = (
  url: string,
  signal: AbortSignal,
) => Promise<{ readonly resourceUrl: string }>;

interface MarkdownArtifactExportInput {
  readonly filename: string;
  readonly url: string;
  readonly format: MarkdownArtifactExportFormat;
}

function exportFilename(
  filename: string,
  format: MarkdownArtifactExportFormat,
): string {
  const safeBase = filename.trim().replace(/[\\/]/g, "-");
  const base =
    safeBase.replace(/\.[^/.]+$/u, "").replace(/^\.+/u, "") || "document";
  return `${base}.${format}`;
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_MARKDOWN_EXPORT_BYTES
  ) {
    throw new Error("Markdown file is too large to export");
  }
  if (!response.body) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    received += chunk.byteLength;
    if (received > MAX_MARKDOWN_EXPORT_BYTES) {
      throw new Error("Markdown file is too large to export");
    }
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function readMarkdownSource(
  url: string,
  resolveResource: ResourceResolver,
  signal: AbortSignal,
): Promise<{ source: string; baseUrl: string }> {
  const resource = await resolveResource(url, signal);
  signal.throwIfAborted();
  const response = await fetchResource(
    resource.resourceUrl,
    {
      cache: "no-store",
      mode: "cors",
      referrerPolicy: "no-referrer",
      redirect: "error",
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`Markdown source could not be loaded (${response.status})`);
  }
  return {
    source: await readResponseText(response, signal),
    baseUrl: resource.resourceUrl,
  };
}

function imageSources(tree: Root): string[] {
  const sources = new Set<string>();
  visit(tree, "element", (node) => {
    if (node.tagName === "img" && typeof node.properties.src === "string") {
      sources.add(node.properties.src);
    }
  });
  return [...sources];
}

function safeHttpUrl(value: string, baseUrl: string): string | undefined {
  if (!URL.canParse(value, baseUrl)) {
    return undefined;
  }
  const url = new URL(value, baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return undefined;
  }
  return url.href;
}

async function resolveImageUrls(
  sources: readonly string[],
  baseUrl: string,
  resolveResource: ResourceResolver,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const imageUrls = new Map<string, string>();
  for (const source of sources) {
    signal.throwIfAborted();
    const url = safeHttpUrl(source, baseUrl);
    if (!url) {
      // Data URLs are read directly by the renderer. Other schemes are passed
      // to its URL validator, which rejects them without making a request.
      imageUrls.set(source, source);
      continue;
    }
    const resource = await resolveResource(url, signal);
    imageUrls.set(source, resource.resourceUrl);
  }
  return imageUrls;
}

export const downloadMarkdownArtifact$ = command(
  async (
    { set },
    input: MarkdownArtifactExportInput,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const resolveResource: ResourceResolver = (url, resourceSignal) => {
      return set(attachmentDownloadSource$, url, "app", resourceSignal);
    };
    const { source, baseUrl } = await readMarkdownSource(
      input.url,
      resolveResource,
      signal,
    );
    const tree = parseMessagePdfTree(source);
    const imageUrls = await resolveImageUrls(
      imageSources(tree),
      baseUrl,
      resolveResource,
      signal,
    );
    signal.throwIfAborted();
    const blob =
      input.format === "pdf"
        ? await generateMessagePdfBlob([source], imageUrls, signal, baseUrl)
        : await generateMarkdownDocxBlob(
            source,
            await preparePdfAssets(tree, imageUrls, signal),
            baseUrl,
            signal,
          );
    triggerBlobDownload(
      blob,
      exportFilename(input.filename, input.format),
      signal,
    );
  },
);
