import { isArtifactPublicationFilePath } from "@okouai/api-contracts/contracts/artifact-delivery";

const R2_IMAGE_TRANSFORM_HOSTS = new Set([
  "cdn.vm0.io",
  "a.okou.io",
  "cdn.okou.io",
  "cdn.vm7.io",
  "static.vm0.io",
  "static.okou.io",
]);
const R2_IMAGE_TRANSFORM_PREFIX = "/cdn-cgi/image/";
const R2_IMAGE_TRANSFORM_INPUT_PATH =
  /\.(?:avif|gif|heic|jpe?g|png|svg|webp)$/iu;

// Output quality for Cloudflare Image Resizing. Tuned to stay crisp on
// text-heavy presentation thumbnails while still shrinking payloads.
const R2_IMAGE_TRANSFORM_QUALITY = 85;

export interface R2ImageTransformOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: "cover" | "scale-down";
  readonly quality?: number;
}

function normalizedDimension(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function normalizedQuality(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return R2_IMAGE_TRANSFORM_QUALITY;
  }
  return Math.max(1, Math.min(100, Math.round(value)));
}

function r2ImageTransformDirectives(options: R2ImageTransformOptions): string {
  const directives: string[] = [];
  const width = normalizedDimension(options.width);
  const height = normalizedDimension(options.height);
  const quality = normalizedQuality(options.quality);

  if (width !== null) {
    directives.push(`width=${String(width)}`);
  }
  if (height !== null) {
    directives.push(`height=${String(height)}`);
  }
  directives.push(`fit=${options.fit ?? "scale-down"}`);
  // Negotiate AVIF/WebP from the request Accept header, cap quality, and drop
  // metadata so previews download as little as possible.
  directives.push("format=auto");
  directives.push(`quality=${String(quality)}`);
  directives.push("metadata=none");

  return directives.join(",");
}

function parseAbsoluteUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function r2ImageTransformUrl(
  url: string,
  options: R2ImageTransformOptions,
  remoteImageOrigin?: string,
): string {
  const parsed = parseAbsoluteUrl(url);
  // Unsupported or unknown input formats keep their original URL. A browser
  // can display formats such as BMP that Cloudflare cannot transform.
  if (parsed === null || !R2_IMAGE_TRANSFORM_INPUT_PATH.test(parsed.pathname)) {
    return url;
  }

  if (
    remoteImageOrigin &&
    parsed.protocol === "https:" &&
    parsed.hostname.endsWith(".r2.cloudflarestorage.com") &&
    parsed.searchParams.has("X-Amz-Signature")
  ) {
    // The signature covers the source URL. Preserve its encoded path and query
    // byte for byte instead of reconstructing it with URLSearchParams.
    return `${remoteImageOrigin}${R2_IMAGE_TRANSFORM_PREFIX}${r2ImageTransformDirectives(options)}/${url}`;
  }

  if (
    !R2_IMAGE_TRANSFORM_HOSTS.has(parsed.hostname) ||
    // Cloudflare's image cache cannot enforce a share's current permissions.
    (parsed.hostname === "a.okou.io" &&
      isArtifactPublicationFilePath(parsed.pathname)) ||
    parsed.pathname.startsWith(R2_IMAGE_TRANSFORM_PREFIX)
  ) {
    return url;
  }

  const directives = r2ImageTransformDirectives(options);
  return `${parsed.origin}${R2_IMAGE_TRANSFORM_PREFIX}${directives}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
