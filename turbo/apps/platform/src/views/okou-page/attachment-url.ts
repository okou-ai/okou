import { fetchResource } from "../../lib/resource-fetch.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { rewritePlatformHostname } from "@okouai/core/platform-service-origin";

import { resolvePlatformOriginForTarget } from "../../signals/api-base.ts";
import { isAllowedDevArtifactFetchUrl } from "../../lib/dev-artifact-fetch-url.ts";
import { resolvePublicArtifactsBaseUrl } from "../../lib/platform-host.ts";
import { i18n } from "../../i18n/index.ts";
import { logger } from "../../signals/log.ts";
import { throwIfAbort } from "../../signals/utils.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";

const log = logger("okou-attachment-url");

const LEGACY_FILE_PATH_PATTERN = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)$/;
const ARTIFACT_FILE_PATH_PATTERN = /^\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/;
const CLERK_USER_ID_PREFIX = "user_";
const DEV_ARTIFACT_FETCH_PROXY_PATH = "/__okou-dev-artifact-fetch";

export function attachmentFilenameFromUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  return last && last.length > 0 ? last : "image";
}

function publicArtifactsBaseUrl(): string | null {
  return resolvePublicArtifactsBaseUrl();
}

function hasExplicitUrlOrigin(url: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(url);
}

function browserOrigin(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.location.origin;
}

function addOrigin(origins: Set<string>, baseUrl: string | null) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }
  origins.add(new URL(baseUrl).origin);
}

function addPlatformOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }

  const parsed = new URL(baseUrl);
  origins.add(parsed.origin);

  for (const target of ["api", "www"] as const) {
    const variant = new URL(parsed);
    variant.hostname = rewritePlatformHostname(variant.hostname, target);
    origins.add(variant.origin);
  }
}

function platformFileOrigins(): Set<string> {
  const origins = new Set<string>();

  addPlatformOriginVariants(origins, browserOrigin());
  addPlatformOriginVariants(origins, resolvePlatformOriginForTarget("api"));
  addOrigin(origins, publicArtifactsBaseUrl());

  return origins;
}

function isPlatformFileUrlHost(parsed: URL, sourceUrl: string): boolean {
  return (
    !hasExplicitUrlOrigin(sourceUrl) || platformFileOrigins().has(parsed.origin)
  );
}

function storageUserIdSegmentFromFileUrlSegment(userIdSegment: string): string {
  if (
    userIdSegment === "user" ||
    userIdSegment.startsWith(CLERK_USER_ID_PREFIX) ||
    userIdSegment.startsWith("user-")
  ) {
    return userIdSegment;
  }
  return `${CLERK_USER_ID_PREFIX}${userIdSegment}`;
}

function artifactCdnUrl(args: {
  userIdSegment: string;
  idSegment: string;
  filenameSegment: string;
  hash: string;
}): string | null {
  const baseUrl = publicArtifactsBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/artifacts/${args.userIdSegment}/${args.idSegment}/${args.filenameSegment}${args.hash}`;
}

function parseFileUrl(url: string): URL | null {
  const baseUrl = browserOrigin() ?? undefined;
  if (!URL.canParse(url, baseUrl)) {
    return null;
  }
  return new URL(url, baseUrl);
}

function normalizedLegacyFileUrl(url: string): string | null {
  const parsed = parseFileUrl(url);
  if (!parsed) {
    return null;
  }
  if (!isPlatformFileUrlHost(parsed, url)) {
    return null;
  }
  const match = parsed.pathname.match(LEGACY_FILE_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const [, userIdSegment, idSegment, filenameSegment] = match;
  return artifactCdnUrl({
    userIdSegment: storageUserIdSegmentFromFileUrlSegment(userIdSegment),
    idSegment,
    filenameSegment,
    hash: parsed.hash,
  });
}

function normalizedArtifactFileUrl(url: string): string | null {
  const parsed = parseFileUrl(url);
  if (!parsed) {
    return null;
  }
  if (!isPlatformFileUrlHost(parsed, url)) {
    return null;
  }
  const match = parsed.pathname.match(ARTIFACT_FILE_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const [, userIdSegment, idSegment, filenameSegment] = match;
  return artifactCdnUrl({
    userIdSegment,
    idSegment,
    filenameSegment,
    hash: parsed.hash,
  });
}

export function publicAttachmentUrl(url: string): string {
  return normalizedLegacyFileUrl(url) ?? normalizedArtifactFileUrl(url) ?? url;
}

function comparableArtifactPreviewUrl(value: string): string | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const pathname = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
}

export function artifactPreviewUrlsMatch(
  artifactUrl: string,
  previewUrl: string,
): boolean {
  if (artifactUrl === previewUrl) {
    return true;
  }
  const comparableArtifactUrl = comparableArtifactPreviewUrl(artifactUrl);
  const comparablePreviewUrl = comparableArtifactPreviewUrl(previewUrl);
  return (
    comparableArtifactUrl !== null &&
    comparableArtifactUrl === comparablePreviewUrl
  );
}

function canUseDevArtifactFetchProxy(): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }
  return ["app.vm7.ai", "localhost", "127.0.0.1"].includes(
    window.location.hostname,
  );
}

export function readableAttachmentResourceUrl(url: string): string {
  if (!canUseDevArtifactFetchProxy() || !URL.canParse(url)) {
    return url;
  }
  const parsed = new URL(url);
  if (!isAllowedDevArtifactFetchUrl(parsed)) {
    return url;
  }
  return `${DEV_ARTIFACT_FETCH_PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  triggerAnchorDownload(blobUrl, filename);
  URL.revokeObjectURL(blobUrl);
}

function triggerAnchorDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Fetch the asset as a blob so downloads are delivered from a same-origin
// object URL. Cross-origin `<a download>` is intentionally avoided because
// browsers ignore it for CDN image URLs and open the asset instead.
async function fetchBlobForDownload(
  url: string,
  signal: AbortSignal,
  cache: RequestCache,
): Promise<Blob | null> {
  const fetchUrl = publicAttachmentUrl(url);
  // The catch branch reports network/CORS failures without falling back to
  // cross-origin anchor navigation, which would open images instead.
  // eslint-disable-next-line no-restricted-syntax -- fetch/CORS failures should surface as download failures
  try {
    const res = await fetchResource(fetchUrl, { cache, mode: "cors" }, signal);
    if (!res.ok) {
      throw new Error(`fetch failed: ${String(res.status)}`);
    }
    return await res.blob();
  } catch (error) {
    throwIfAbort(error);
    log.warn("downloadUrl: fetch failed", error);
    return null;
  }
}

export async function downloadAttachmentUrl(
  url: string,
  signal: AbortSignal,
  filename: string,
  mode: "blob" | "native",
  cache: RequestCache = "reload",
): Promise<void> {
  if (mode === "native") {
    signal.throwIfAborted();
    // Generic files intentionally use native browser delivery. Previewable
    // media keeps the blob path so a download cannot replace the chat page.
    triggerAnchorDownload(publicAttachmentUrl(url), filename);
    return;
  }
  const blob = await fetchBlobForDownload(url, signal, cache);
  if (blob !== null) {
    triggerBlobDownload(blob, filename);
    return;
  }
  toast.error(
    i18n.t(($) => {
      return $.artifacts.toasts.downloadFailed;
    }),
  );
}

export async function copyAttachmentLinkToClipboard(
  url: string,
  toastId?: string | number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const copied = await writeToClipboard(publicAttachmentUrl(url));
  signal?.throwIfAborted();
  if (copied) {
    toast.success(
      i18n.t(($) => {
        return $.artifacts.toasts.linkCopied;
      }),
      { id: toastId },
    );
    return;
  }
  toast.error(
    i18n.t(($) => {
      return $.artifacts.toasts.copyLinkFailed;
    }),
    { id: toastId },
  );
}
