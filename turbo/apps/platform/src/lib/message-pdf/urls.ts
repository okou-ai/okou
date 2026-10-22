import { fetchResource } from "../resource-fetch.ts";

/** Preserve the authored destination, but never emit executable PDF actions. */
export function pdfLink(source: string, baseUrl: string): string | undefined {
  if (source.startsWith("#") || !URL.canParse(source, baseUrl)) {
    return undefined;
  }
  const url = new URL(source, baseUrl);
  return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url.href
    : undefined;
}

export function imageResourceUrl(source: string): URL {
  const url = new URL(source, location.href);
  const imageData =
    /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml);/iu.test(source);
  const localBlob = url.protocol === "blob:" && url.origin === location.origin;
  if (
    url.username ||
    url.password ||
    !(["https:", "http:"].includes(url.protocol) || imageData || localBlob)
  ) {
    throw new Error("PDF image URL uses an unsupported or unsafe scheme");
  }
  return url;
}

export async function readPdfResource(
  url: string | URL,
  cache: RequestCache,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetchResource(
    url,
    { cache, mode: "cors", referrerPolicy: "no-referrer", redirect: "error" },
    signal,
  );
  if (!response.ok) {
    // Resource URLs may contain short-lived private credentials. Do not echo them.
    throw new Error(`PDF resource could not be loaded (${response.status})`);
  }
  return response;
}
