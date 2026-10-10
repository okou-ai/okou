import {
  ARTIFACT_OG_BRAND,
  artifactOgHtml,
  normalizeArtifactImageUrls,
} from "@okouai/core/artifact-og";
import type { ArtifactOgTarget } from "@okouai/api-contracts/contracts/artifact-og";
import { artifactOgMetadataSchema } from "@okouai/api-contracts/contracts/artifact-og-metadata";

/** Metadata is optional; its failure must not interrupt already-authorized site delivery. */
export async function withArtifactOg(
  request: Request,
  response: Response,
  origin: string | undefined,
  target: ArtifactOgTarget,
): Promise<Response> {
  if (
    !origin ||
    request.method !== "GET" ||
    response.status !== 200 ||
    !response.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("text/html") ||
    response.headers
      .get("Content-Disposition")
      ?.toLowerCase()
      .startsWith("attachment") ||
    response.headers.has("Content-Encoding") ||
    Number(response.headers.get("Content-Length")) > 4 * 1024 * 1024
  )
    return response;
  const url = new URL("/api/artifact-og/metadata", origin);
  url.search = new URLSearchParams(target).toString();
  let metadata;
  try {
    const result = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
    });
    if (!result.ok)
      throw new Error(`Artifact metadata returned ${result.status}`);
    metadata = artifactOgMetadataSchema.parse(await result.json());
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.error("Artifact OG metadata unavailable", error);
    return response;
  }
  const canonical = new URL(request.url);
  canonical.search = "";
  canonical.hash = "";
  const original = await response.text();
  // Delivery was authorized before this wrapper; unavailable OG reveals no artifact metadata.
  const html = metadata.available
    ? artifactOgHtml(
        normalizeArtifactImageUrls(original, request.url),
        { ...metadata, url: canonical.href },
        false,
      )
    : artifactOgHtml(
        original,
        { ...ARTIFACT_OG_BRAND, url: canonical.href },
        "social",
      );
  const headers = new Headers(response.headers);
  headers.delete("ETag");
  headers.delete("Content-Length");
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  return new Response(html, { status: response.status, headers });
}
