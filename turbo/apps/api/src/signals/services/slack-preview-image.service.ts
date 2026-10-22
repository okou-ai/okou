import { createHmac, timingSafeEqual } from "node:crypto";
import { command } from "ccstate";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { env } from "../../lib/env";
import { publicArtifactsBaseUrl } from "../../lib/file-url";
import {
  SLACK_PREVIEW_IMAGE_HEIGHT,
  SLACK_PREVIEW_IMAGE_WIDTH,
} from "../../lib/slack-preview-image";

function signature(url: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("slack-preview-image:v1\0")
    .update(url)
    .digest();
}

/** Unwrap native CF chains, never republishing another signed adapter. */
function originalImageSource(source: string): string | null {
  const origin = apiBackendUrl();
  if (!origin) {
    throw new Error("API origin is not configured");
  }
  const apiOrigin = new URL(origin).origin;
  let current = source;
  while (URL.canParse(current)) {
    const url = new URL(current);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname === "/api/artifact-og/slack.png" ||
      url.pathname.startsWith("/api/artifact-references/") ||
      url.pathname.startsWith("/artifacts/") ||
      (url.pathname.startsWith("/api/artifact-og/") &&
        (url.origin !== apiOrigin || url.pathname !== "/api/artifact-og/image"))
    ) {
      return null;
    }
    const prefix = "/cdn-cgi/image/";
    if (!url.pathname.startsWith(prefix)) {
      // Preserve the literal destination, including signed query encoding.
      return current;
    }
    const start = current.indexOf(prefix) + prefix.length;
    const separator = current.indexOf("/", start);
    if (separator < start) {
      return null;
    }
    const nested = current.slice(separator + 1);
    current = /^https?:\/\//u.test(nested) ? nested : `${url.origin}/${nested}`;
    // Relative CF nesting must make progress rather than reconstruct itself.
    if (current.length >= source.length) {
      return null;
    }
    source = current;
  }
  return null;
}

export function slackPreviewImageUrl(source: string): string | null {
  if (source.length > 2048) {
    return null;
  }
  const original = originalImageSource(source);
  if (!original) {
    return null;
  }
  const options = {
    width: SLACK_PREVIEW_IMAGE_WIDTH,
    height: SLACK_PREVIEW_IMAGE_HEIGHT,
  };
  const direct = r2ImageTransformUrl(
    original,
    options,
    publicArtifactsBaseUrl("current"),
  );
  if (direct !== original) {
    // File grants have their own policy-gated thumbnail path; never wrap it
    // in a native transformation that could bypass its per-request checks.
    return direct.length <= 3000 ? direct : null;
  }
  const origin = apiBackendUrl();
  if (!origin) {
    throw new Error("API origin is not configured");
  }
  const url = new URL("/api/artifact-og/slack.png", origin);
  url.search = new URLSearchParams({
    url: original,
    signature: signature(original).toString("hex"),
  }).toString();
  const transformed = r2ImageTransformUrl(
    url.href,
    {
      authorizedSource: true,
      ...options,
    },
    publicArtifactsBaseUrl("current"),
  );
  return transformed.length <= 3000 ? transformed : null;
}

/** Already-issued HMAC capabilities remain valid, but now resolve originals. */
export const slackPreviewImage$ = command(
  (
    _,
    query: { readonly url: string; readonly signature: string },
    signal: AbortSignal,
  ): string | null => {
    signal.throwIfAborted();
    const actual = Buffer.from(query.signature, "hex");
    const expected = signature(query.url);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return null;
    }
    return originalImageSource(query.url);
  },
);
