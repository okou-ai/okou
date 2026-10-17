import { createHmac, timingSafeEqual } from "node:crypto";
import { command } from "ccstate";
import sharp from "sharp";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { env } from "../../lib/env";
import {
  SLACK_PREVIEW_IMAGE_HEIGHT,
  SLACK_PREVIEW_IMAGE_WIDTH,
  SLACK_PREVIEW_IMAGE_MAX_BYTES,
  SLACK_PREVIEW_IMAGE_MAX_PIXELS,
} from "../../lib/slack-preview-image";
import { fetchSlackPreviewImage } from "../external/slack-preview-image";
import { settleIncludingAbort } from "../utils";

// An unavailable source must never redirect Slack back to an unbounded image.
const EMPTY_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
  "base64",
);

function signature(url: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("slack-preview-image:v1\0")
    .update(url)
    .digest();
}

export function slackPreviewImageUrl(source: string): string | null {
  if (source.length > 2048) {
    return null;
  }
  const origin = apiBackendUrl();
  if (!origin) {
    throw new Error("API origin is not configured");
  }
  const url = new URL("/api/artifact-og/slack.png", origin);
  const sourceUrl = new URL(source);
  // Do not nest thumbnail requests if a page republishes a Slack image URL.
  if (sourceUrl.origin === url.origin && sourceUrl.pathname === url.pathname) {
    return null;
  }
  url.search = new URLSearchParams({
    url: source,
    signature: signature(source).toString("hex"),
  }).toString();
  return url.href.length <= 3000 ? url.href : null;
}

async function thumbnail(source: string, signal: AbortSignal) {
  const bytes = await fetchSlackPreviewImage(new URL(source), signal);
  if (!bytes) {
    return null;
  }
  const image = sharp(bytes, {
    limitInputPixels: SLACK_PREVIEW_IMAGE_MAX_PIXELS,
    failOn: "warning",
  });
  const metadata = await image.metadata();
  signal.throwIfAborted();
  if (
    !metadata.format ||
    !["png", "jpeg", "webp", "gif", "avif", "heif"].includes(metadata.format)
  ) {
    return null;
  }
  const output = await image
    .rotate()
    .resize({
      width: SLACK_PREVIEW_IMAGE_WIDTH,
      height: SLACK_PREVIEW_IMAGE_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .timeout({ seconds: 5 })
    .png()
    .toBuffer();
  signal.throwIfAborted();
  return output.length <= SLACK_PREVIEW_IMAGE_MAX_BYTES ? output : null;
}

export const slackPreviewImage$ = command(
  async (
    _,
    query: { readonly url: string; readonly signature: string },
    signal: AbortSignal,
  ) => {
    const actual = Buffer.from(query.signature, "hex");
    const expected = signature(query.url);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return null;
    }
    const result = await settleIncludingAbort(thumbnail(query.url, signal));
    signal.throwIfAborted();
    return result.ok && result.value ? result.value : EMPTY_IMAGE;
  },
);
