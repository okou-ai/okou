import { okouAppWorkerPreviewJobRef } from "@okouai/core/platform-service-origin";

const VERCEL_PROTECTION_BYPASS_NAME = "x-vercel-protection-bypass";
const PREVIEW_BYPASS_COOKIE_MAX_AGE_SECONDS = 60 * 60;
const PREVIEW_API_ROOT_DOMAIN = "vm6.ai";
const OKOU_PREVIEW_ROOT_DOMAIN = "omby.ai";
const APP_SERVICE_SUFFIX = "-app";
const BYPASS_TARGET_SERVICE_SUFFIX = "-api";

interface PreviewBypassCookieLocation {
  readonly hostname: string;
  readonly protocol: string;
  readonly search: string;
}

function isHostnameWithin(hostname: string, rootDomain: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === rootDomain || normalized.endsWith(`.${rootDomain}`);
}

function hostnameBeforeRoot(hostname: string, rootDomain: string): string {
  return hostname.slice(0, -(rootDomain.length + 1));
}

function isCorrespondingPreviewService(
  sourceHostname: string,
  targetHostname: string,
): boolean {
  const workerPreviewJobRef = okouAppWorkerPreviewJobRef(sourceHostname);
  const target = hostnameBeforeRoot(targetHostname, PREVIEW_API_ROOT_DOMAIN);
  if (workerPreviewJobRef) {
    return target === `${workerPreviewJobRef}${BYPASS_TARGET_SERVICE_SUFFIX}`;
  }

  const source = hostnameBeforeRoot(sourceHostname, OKOU_PREVIEW_ROOT_DOMAIN);
  if (!source.endsWith(APP_SERVICE_SUFFIX)) {
    return false;
  }
  const prefix = source.slice(0, -APP_SERVICE_SUFFIX.length);
  return target === `${prefix}${BYPASS_TARGET_SERVICE_SUFFIX}`;
}

function cookieValue(cookieHeader: string, name: string): string | null {
  for (const segment of cookieHeader.split(";")) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (segment.slice(0, separatorIndex).trim() !== name) {
      continue;
    }
    return decodeURIComponent(segment.slice(separatorIndex + 1).trim());
  }
  return null;
}

type PreviewBypassTarget = string | URL | Request;

function targetUrl(target: PreviewBypassTarget): URL {
  const value = target instanceof Request ? target.url : target.toString();
  return new URL(value);
}

function previewBypassForTarget(
  target: PreviewBypassTarget,
  location: PreviewBypassCookieLocation,
  cookieHeader: string,
): string | null {
  const targetHostname = targetUrl(target).hostname.toLowerCase();
  if (
    (!isHostnameWithin(location.hostname, OKOU_PREVIEW_ROOT_DOMAIN) &&
      okouAppWorkerPreviewJobRef(location.hostname) === null) ||
    !isHostnameWithin(targetHostname, PREVIEW_API_ROOT_DOMAIN) ||
    !isCorrespondingPreviewService(
      location.hostname.toLowerCase(),
      targetHostname,
    )
  ) {
    return null;
  }
  return (
    new URLSearchParams(location.search).get(VERCEL_PROTECTION_BYPASS_NAME) ??
    cookieValue(cookieHeader, VERCEL_PROTECTION_BYPASS_NAME)
  );
}

export function appendPreviewBypassToUrl(
  url: URL,
  location: PreviewBypassCookieLocation,
  cookieHeader: string,
): void {
  url.searchParams.delete(VERCEL_PROTECTION_BYPASS_NAME);
  const bypass = previewBypassForTarget(url, location, cookieHeader);
  if (bypass) {
    url.searchParams.set(VERCEL_PROTECTION_BYPASS_NAME, bypass);
  }
}

export function appendCapturedPreviewBypassToUrl(url: URL): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  appendPreviewBypassToUrl(url, window.location, document.cookie);
}

export function getCapturedPreviewBypassForTarget(
  target: PreviewBypassTarget,
): string | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  return previewBypassForTarget(target, window.location, document.cookie);
}

export function buildPreviewBypassCookie(
  location: PreviewBypassCookieLocation,
): string | null {
  const bypass = new URLSearchParams(location.search).get(
    VERCEL_PROTECTION_BYPASS_NAME,
  );
  if (!bypass) {
    return null;
  }

  const segments = [
    `${VERCEL_PROTECTION_BYPASS_NAME}=${encodeURIComponent(bypass)}`,
    "Path=/",
    `Max-Age=${PREVIEW_BYPASS_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (location.protocol === "https:") {
    segments.push("Secure");
  }
  return segments.join("; ");
}

export function writePreviewBypassCookie(
  location: PreviewBypassCookieLocation,
  setCookie: (cookie: string) => void,
): boolean {
  const cookie = buildPreviewBypassCookie(location);
  if (!cookie) {
    return false;
  }
  setCookie(cookie);
  return true;
}

export function capturePreviewBypassCookieFromLocation(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  writePreviewBypassCookie(window.location, (cookie) => {
    // oxlint-disable-next-line unicorn/no-document-cookie -- must synchronously set the shared preview cookie before the first API request.
    document.cookie = cookie;
  });
}
