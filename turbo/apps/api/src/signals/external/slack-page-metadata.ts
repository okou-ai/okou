import { htmlOpenGraphMetadata } from "@okouai/core/artifact-og";
import { settleIncludingAbort } from "../utils";

const MAX_HTML_BYTES = 4 * 1024 * 1024;

async function readPublicHtml(url: URL, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { Accept: "text/html, application/xhtml+xml" },
    credentials: "omit",
    redirect: "manual",
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
    await response.body?.cancel();
    return null;
  }
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  return readHtmlBody(reader, signal).finally(() => {
    reader.releaseLock();
  });
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
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The caller authorizes the exact origin and resource before this anonymous read. */
export async function fetchSlackPageMetadata(url: URL, signal: AbortSignal) {
  // A failed optional page read must not discard previews for sibling links.
  // Never follow redirects out of the caller's checked resource or send auth.
  const result = await settleIncludingAbort(
    readPublicHtml(url, AbortSignal.any([signal, AbortSignal.timeout(5000)])),
  );
  signal.throwIfAborted();
  return result.ok && result.value !== null
    ? htmlOpenGraphMetadata(result.value, url.href)
    : null;
}
