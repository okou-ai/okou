import { resolveApiBase } from "../signals/api-base.ts";

// URL.canParse is unavailable on iOS Safari < 17. Instead of relying on it (or
// on try/catch, which this repo's ESLint forbids), feature-detect it and fall
// back to a structural validation before constructing a URL. Mirrors the
// pattern used in signals/auth.ts parseUrl(): the host must match a hostname
// shape with an in-range optional port, so malformed absolute URLs (for
// example "https://exa%mple.com") return null instead of throwing on old
// browsers. Remove together with support for URL.canParse-less browsers.
const LEGACY_HTTP_URL_REGEX = /^https?:\/\/([^/?#\s]+)([/?#][^\s]*)?$/i;
const LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i;
const MAX_URL_PORT = 65_535;
const PROTOCOL_RELATIVE_URL_REGEX = /^\/\/([^/?#\s]+)([/?#][^\s]*)?$/;

function isLegacyUrlHostValid(host: string | undefined): host is string {
  if (!host) {
    return false;
  }
  const hostMatch = LEGACY_HOST_WITH_OPTIONAL_PORT_REGEX.exec(host);
  const port = hostMatch?.[2];
  return Boolean(hostMatch && (!port || Number(port) <= MAX_URL_PORT));
}

export function tryParseUrl(input: string, base?: string): URL | null {
  if (typeof URL.canParse === "function") {
    return URL.canParse(input, base) ? new URL(input, base) : null;
  }

  if (/\s/u.test(input)) {
    return null;
  }

  const absoluteMatch = LEGACY_HTTP_URL_REGEX.exec(input);
  if (absoluteMatch) {
    if (!isLegacyUrlHostValid(absoluteMatch[1])) {
      return null;
    }
    return new URL(input);
  }

  if (base && input.startsWith("/")) {
    if (input.startsWith("//")) {
      const protocolRelativeMatch = PROTOCOL_RELATIVE_URL_REGEX.exec(input);
      if (
        !protocolRelativeMatch ||
        !isLegacyUrlHostValid(protocolRelativeMatch[1])
      ) {
        return null;
      }
    }
    return new URL(input, base);
  }
  return null;
}

/** Only a file URL on the active app or API origin identifies an authenticated upload. */
export function authenticatedWebFile(value: string) {
  if (
    !value.includes("/api/web/file-url?") ||
    typeof location === "undefined" ||
    value.startsWith("//") ||
    /[\s\\]/u.test(value)
  ) {
    return null;
  }
  const url = tryParseUrl(value, location.origin);
  if (
    !url ||
    url.pathname !== "/api/web/file-url" ||
    url.username ||
    url.password ||
    (url.origin !== location.origin && url.origin !== resolveApiBase())
  ) {
    return null;
  }
  const id = url.searchParams.get("file_id");
  return id ? { id, filename: url.searchParams.get("filename") } : null;
}
