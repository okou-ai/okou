import { htmlOpenGraphMetadata } from "@okouai/core/artifact-og";
import { settleIncludingAbort } from "../utils";

const MAX_HTML_BYTES = 4 * 1024 * 1024;

async function readPublicHtml(url: URL, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { Accept: "text/html, application/xhtml+xml" },
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    !response.ok ||
    !["text/html", "application/xhtml+xml"].includes(contentType ?? "") ||
    Number(response.headers.get("content-length")) > MAX_HTML_BYTES
  ) {
    return null;
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const html = await readHtmlBody(reader, signal).finally(() => {
    reader.releaseLock();
  });
  return html === null ? null : { html, url: response.url };
}

async function readHtmlBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    signal.throwIfAborted();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_HTML_BYTES) {
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The caller restricts the destination to a supported origin before this anonymous read. */
export async function fetchSlackPageMetadata(url: URL, signal: AbortSignal) {
  // A failed optional page read must not discard previews for sibling links.
  const controller = new AbortController();
  const result = await settleIncludingAbort(
    readPublicHtml(
      url,
      AbortSignal.any([signal, controller.signal, AbortSignal.timeout(5000)]),
    ),
  ).finally(() => {
    // Abort rejected bodies without waiting for a cloned stream to cancel.
    controller.abort();
  });
  signal.throwIfAborted();
  return result.ok && result.value !== null
    ? htmlOpenGraphMetadata(result.value.html, result.value.url)
    : null;
}
