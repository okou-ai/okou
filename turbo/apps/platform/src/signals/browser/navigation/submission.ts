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

function inputScheme(value: string, hostPort: boolean): string | null {
  const match = /^([a-z][a-z\d+.-]*):/i.exec(value);
  if (!match || hostPort || match[1]!.includes(".")) {
    return null;
  }
  return match[1]!.toLowerCase();
}

function hasUserAndPassword(authority: string): boolean {
  const userEnd = authority.lastIndexOf("@");
  const userInfo = authority.slice(0, userEnd);
  const separator = userInfo.indexOf(":");
  return (
    userEnd !== -1 &&
    separator > 0 &&
    separator < userInfo.length - 1 &&
    !userInfo.includes(" ")
  );
}

function parseAddress(
  text: string,
  completeHost: boolean,
): ParsedAddress | null {
  const value = text.replace(/^(https?|wss?|file|about|chrome);/i, "$1:");
  const withoutPrefix = value.startsWith("//") ? value.slice(2) : value;
  const authorityHint = withoutPrefix.split(/[/?#\\]/, 1)[0]!;
  const port = /^[^:]+:(\d+)$/.exec(authorityHint)?.[1];
  const hostPort = port !== undefined && Number(port) <= 65_535;
  let scheme = inputScheme(value, hostPort);
  let credentials = false;
  if (scheme && !browserSchemes.includes(scheme)) {
    if (!hasUserAndPassword(authorityHint)) {
      return null;
    }
    // Chromium retries unknown-scheme username:password input as explicit HTTP.
    scheme = null;
    credentials = true;
  }
  // Chrome searches JavaScript-prefixed text that does not look like code.
  if (scheme === "javascript" && /^javascript:[^;=()."]*$/i.test(value)) {
    return null;
  }
  const candidate = scheme
    ? value
    : "http:" + (value.startsWith("//") ? value : "//" + value);
  const network = /^(https?|wss?):[/\\]*([^/\\?#]*)(.*)$/i.exec(candidate);
  const authority = network ? network[2]! : authorityHint;
  const path = network ? network[3]!.split(/[?#]/, 1)[0]! : "";
  let url: URL | null;
  if (network) {
    url = fixedNetworkURL(network[1]!, authority, network[3]!, completeHost);
  } else if (URL.canParse(candidate)) {
    url = new URL(candidate);
  } else {
    url = null;
  }
  return url
    ? {
        url,
        authority,
        path,
        hostPort: /:\d+$/.test(authority),
        explicit: credentials || scheme !== null || value.startsWith("//"),
      }
    : null;
}

function normalizeHost(url: URL): string | null {
  const host = url.hostname.replace(/\.$/, "");
  if (
    !host ||
    host.startsWith(".") ||
    host.includes("..") ||
    (!host.startsWith("[") && !/^[a-z\d_.-]+$/i.test(host))
  ) {
    return null;
  }
  return host;
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
  const source = originalHost(input)
    .replace(/[\u3002\uff0e\uff61]/gu, ".")
    .replace(/\.$/, "");
  const parts = source.split(".");
  const components = parts.every((part) => {
    return part.length > 0;
  })
    ? parts.length
    : 0;
  // Source-only 0.x.x.x addresses are queries, except an explicit four-part zero.
  if (host.startsWith("0.") && (host !== "0.0.0.0" || components !== 4)) {
    return false;
  }
  if (components === 4 || input.explicit || /[/\\]$/.test(input.path)) {
    return true;
  }
  // Short dotted IPs imply a query. Single-component IPs still use port/component
  // intent below, rather than becoming navigations merely through coercion.
  return components > 1 ? false : null;
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
  if (host.length > 253) {
    return false;
  }
  const labels = host.split(".");
  if (
    labels.some((label) => {
      return label.length > 63;
    }) ||
    !/^[a-z\d]/i.test(labels[labels.length - 1]!)
  ) {
    return false;
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
  if (input.url.username) {
    return false;
  }
  return Boolean(input.url.port) || knownSuffix(host) || localHost(host);
}

function fixedNetworkURL(
  scheme: string,
  authority: string,
  rest: string,
  completeHost: boolean,
): URL | null {
  const candidate = scheme + "://" + authority + rest;
  const userEnd = authority.lastIndexOf("@") + 1;
  const hostPort = authority.slice(userEnd);
  if (hostPort.startsWith("[")) {
    return URL.canParse(candidate) ? new URL(candidate) : null;
  }
  const port = /:\d*$/.exec(hostPort);
  const original = port ? hostPort.slice(0, port.index) : hostPort;
  const domain = original.replace(
    /[.\u3002\uff0e\uff61]+/gu,
    (dots, offset: number) => {
      if (offset === 0) {
        return "";
      }
      return offset + dots.length === original.length ? "." : dots;
    },
  );
  if (!domain) {
    return null;
  }
  // Fix host dots and the desired TLD before native IP canonicalization, as
  // URLFixer does. Keep raw authority components for the later intent checks.
  const fixed =
    scheme +
    "://" +
    authority.slice(0, userEnd) +
    (completeHost ? domain.replace(/\.$/, "") + ".com" : domain) +
    (port?.[0] ?? "") +
    rest;
  if (!URL.canParse(fixed)) {
    return null;
  }
  const url = new URL(fixed);
  if (!completeHost) {
    return url;
  }
  const host = url.hostname.slice(0, -".com".length);
  if (knownSuffix(host)) {
    url.hostname = host + (domain.endsWith(".") ? "." : "");
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
  if (!completeHost && ["ws:", "wss:"].includes(url.protocol)) {
    return url;
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
