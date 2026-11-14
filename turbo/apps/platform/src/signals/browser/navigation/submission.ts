import { parse as parseDomain } from "tldts";

// Chromium's desktop handled protocols, plus its explicit mailto allowance.
// OS/profile-registered external handlers are not available to this web input.
const browserSchemes = Object.freeze([
  "http",
  "https",
  "ws",
  "wss",
  "file",
  "about",
  "blob",
  "filesystem",
  "chrome",
  "chrome-untrusted",
  "chrome-search",
  "chrome-extension",
  "chrome-distiller",
  "devtools",
  "isolated-app",
  "data",
  "javascript",
  "view-source",
  "mailto",
]);

function knownSuffix(host: string): boolean {
  if (!host.includes(".")) {
    return false;
  }
  const domain = parseDomain(host, {
    allowPrivateDomains: false,
    extractHostname: false,
    validateHostname: false,
  });
  // A registry identifier such as co.uk is not itself a registered domain.
  return domain.isIcann === true && domain.domain !== null;
}

function localHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    ["example", "test", "local", "internal"].some((suffix) => {
      return host.endsWith("." + suffix);
    })
  );
}

interface ParsedAddress {
  readonly url: URL;
  readonly authority: string;
  readonly path: string;
  readonly hostPort: boolean;
  readonly explicit: boolean;
}

function inputScheme(
  value: string,
  authority: string,
  hostPort: boolean,
): string | null {
  const match = /^([a-z][a-z\d+.-]*):/i.exec(value);
  if (!match || hostPort || match[1]!.includes(".")) {
    return null;
  }
  const scheme = match[1]!.toLowerCase();
  if (browserSchemes.includes(scheme)) {
    return scheme;
  }
  const userInfo = authority.slice(0, authority.lastIndexOf("@"));
  if (
    authority.includes("@") &&
    userInfo.includes(":") &&
    !/\s/u.test(userInfo)
  ) {
    return null;
  }
  return scheme;
}

function parseAddress(
  text: string,
  completeHost: boolean,
): ParsedAddress | null {
  const value = text.replace(/^(https?|wss?|file|about|chrome);/i, "$1:");
  const withoutPrefix = value.startsWith("//") ? value.slice(2) : value;
  const authority = withoutPrefix.split(/[/?#\\]/, 1)[0]!;
  const path = withoutPrefix.slice(authority.length).split(/[?#]/, 1)[0]!;
  const port = /^[^:]+:(\d+)$/.exec(authority)?.[1];
  const hostPort = port !== undefined && Number(port) <= 65_535;
  const scheme = inputScheme(value, authority, hostPort);
  if (scheme && !browserSchemes.includes(scheme)) {
    return null;
  }
  // Chrome searches JavaScript-prefixed text that does not look like code.
  if (scheme === "javascript" && /^javascript:[^;=()."]*$/i.test(value)) {
    return null;
  }
  const candidate = scheme
    ? value
    : "http:" + (value.startsWith("//") ? value : "//" + value);
  let url: URL | null = null;
  if (completeHost) {
    url = completedURL(candidate);
  } else if (URL.canParse(candidate)) {
    url = new URL(candidate);
  }
  return url
    ? {
        url,
        authority,
        path,
        hostPort,
        explicit: scheme !== null || value.startsWith("//"),
      }
    : null;
}

function normalizeHost(url: URL): string | null {
  // FixupHost removes leading dots and retains at most one trailing dot.
  const host = url.hostname.replace(/^\.+/, "").replace(/\.{2,}$/, ".");
  if (
    !host ||
    host.includes("..") ||
    (!host.startsWith("[") && !/^[a-z\d_.-]+$/i.test(host))
  ) {
    return null;
  }
  url.hostname = host;
  return host.replace(/\.$/, "");
}

function originalHost(input: ParsedAddress): string {
  return input.authority
    .slice(input.authority.lastIndexOf("@") + 1)
    .replace(/:\d+$/, "");
}

function ipIntent(input: ParsedAddress, host: string): boolean | null {
  if (host.startsWith("[")) {
    return true;
  }
  if (!/^\d+(?:\.\d+){3}$/.test(host)) {
    return null;
  }
  // Chrome does not navigate source-only 0.x.x.x addresses, except 0.0.0.0.
  if (host.startsWith("0.") && host !== "0.0.0.0") {
    return false;
  }
  return (
    input.explicit ||
    /[/\\]$/.test(input.path) ||
    /^\d{1,3}(?:\.\d{1,3}){3}\.?$/.test(originalHost(input))
  );
}

function nonHostComponents(input: ParsedAddress): number {
  const { url, path, hostPort } = input;
  return (
    Number(Boolean(url.username)) +
    Number(Boolean(url.password)) +
    Number(hostPort || Boolean(url.port)) +
    Number(Boolean(path)) +
    Number(url.search.length > 1) +
    Number(url.hash.length > 1)
  );
}

function navigationIntent(input: ParsedAddress, host: string): boolean {
  if (host === "invalid" || host.endsWith(".invalid")) {
    return false;
  }
  const ip = ipIntent(input, host);
  if (ip !== null) {
    return ip;
  }
  if (input.explicit) {
    return true;
  }
  const userInfo = input.authority.slice(0, input.authority.lastIndexOf("@"));
  if (input.authority.includes("@") && /\s/u.test(userInfo)) {
    return false;
  }
  if (/[/\\]$/.test(input.path) || nonHostComponents(input) > 1) {
    return true;
  }
  if (input.url.username || input.url.password) {
    return false;
  }
  return Boolean(input.url.port) || knownSuffix(host) || localHost(host);
}

function completedURL(candidate: string): URL | null {
  const parts = /^(https?|wss?):[/\\]*([^/\\?#]*)(.*)$/i.exec(candidate);
  if (!parts) {
    return null;
  }
  const authority = parts[2]!;
  const userEnd = authority.lastIndexOf("@") + 1;
  const hostPort = authority.slice(userEnd);
  if (hostPort.startsWith("[")) {
    return URL.canParse(candidate) ? new URL(candidate) : null;
  }
  const port = /:\d*$/.exec(hostPort);
  const original = port ? hostPort.slice(0, port.index) : hostPort;
  const domain = original.replace(
    /^[.\u3002\uff0e\uff61]+|[.\u3002\uff0e\uff61]+$/gu,
    "",
  );
  if (!domain) {
    return null;
  }
  // Qualify before URL canonicalization can coerce numeric text into an IP or
  // reject it as an overflowing IP. URLFixer applies the desired TLD first too.
  const qualified =
    parts[1]! +
    "://" +
    authority.slice(0, userEnd) +
    domain +
    ".com" +
    (port?.[0] ?? "") +
    parts[3]!;
  if (!URL.canParse(qualified)) {
    return null;
  }
  const url = new URL(qualified);
  const host = url.hostname.slice(0, -".com".length);
  if (knownSuffix(host)) {
    url.hostname = host + (/[.\u3002\uff0e\uff61]$/u.test(original) ? "." : "");
  } else if (!url.hostname.startsWith("www.")) {
    url.hostname = "www." + url.hostname;
  }
  return url;
}

/** Mirror the profile-independent URL intent rules in Chromium AutocompleteInput. */
function addressURL(text: string, completeHost: boolean): URL | null {
  const input = parseAddress(text, completeHost);
  if (!input) {
    return null;
  }
  const { url } = input;
  if (
    !url.hostname ||
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol)
  ) {
    return completeHost ? null : url;
  }
  const host = normalizeHost(url);
  if (!host) {
    return null;
  }
  if (completeHost) {
    return url;
  }
  return navigationIntent(input, host) ? url : null;
}

function submittedText(input: string): string | null {
  const text = input.trim();
  if (
    !text ||
    text.startsWith("\\") ||
    (text.startsWith("/") && !text.startsWith("//")) ||
    text.startsWith("///")
  ) {
    return null;
  }
  for (const char of text) {
    if (char < " " || char === "\u007f") {
      return null;
    }
  }
  return text;
}

/** Classify submission without querying history, DNS, or suggestion providers. */
export function addressSubmission(input: string): {
  readonly kind: "navigate" | "search";
  readonly url: string;
} | null {
  const text = submittedText(input);
  if (!text) {
    return null;
  }
  const forceQuery = text.startsWith("?");
  const url = forceQuery ? null : addressURL(text, false);
  if (url) {
    // HTTPS upgrading and fallback belong to Chrome's native navigation stack.
    return { kind: "navigate", url: url.href };
  }
  const query = forceQuery ? text.slice(1).trimStart() : text;
  if (!query) {
    return null;
  }
  const searchUrl = new URL("https://www.google.com/search");
  searchUrl.searchParams.set("q", query);
  return { kind: "search", url: searchUrl.href };
}

/** Ctrl+Enter asks for a .com URL, without accepting a suggestion or changing tabs. */
export function completeAddressHost(input: string): string | null {
  const text = submittedText(input);
  return text && !text.startsWith("?")
    ? (addressURL(text, true)?.href ?? null)
    : null;
}
