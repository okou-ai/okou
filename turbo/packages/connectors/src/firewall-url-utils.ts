const ASCII_CONTROL_MAX = 0x20;
const ASCII_DELETE = 0x7f;
const UNICODE_HIGH_SURROGATE_MIN = 0xd800;
const UNICODE_HIGH_SURROGATE_MAX = 0xdbff;
const UNICODE_LOW_SURROGATE_MIN = 0xdc00;
const UNICODE_LOW_SURROGATE_MAX = 0xdfff;

function trimTrailingDots(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 46) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function stripHostnameTrailingDot(host: string): string {
  const portStart = host.startsWith("[") ? -1 : host.lastIndexOf(":");
  if (portStart === -1) {
    return trimTrailingDots(host);
  }

  const hostname = trimTrailingDots(host.slice(0, portStart));
  return `${hostname}${host.slice(portStart)}`;
}

export function normalizeFirewallFixedHost(host: string): string | null {
  const trimmedHost = host.trim();
  if (trimmedHost.length === 0) {
    return null;
  }

  try {
    const url = trimmedHost.includes("://")
      ? new URL(trimmedHost)
      : new URL(`https://${trimmedHost}`);
    return stripHostnameTrailingDot(url.host.toLowerCase());
  } catch {
    return stripHostnameTrailingDot(trimmedHost.toLowerCase());
  }
}

export function hasRawWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (
      char === " " ||
      char === "\t" ||
      char === "\n" ||
      char === "\r" ||
      char === "\f" ||
      char === "\v"
    ) {
      return true;
    }
  }
  return false;
}

export function hasUnsafeUrlCodepoint(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const codeUnit = value.charCodeAt(i);
    if (codeUnit < ASCII_CONTROL_MAX || codeUnit === ASCII_DELETE) {
      return true;
    }
    if (
      UNICODE_HIGH_SURROGATE_MIN <= codeUnit &&
      codeUnit <= UNICODE_HIGH_SURROGATE_MAX
    ) {
      const nextCodeUnit = value.charCodeAt(i + 1);
      if (!(
        UNICODE_LOW_SURROGATE_MIN <= nextCodeUnit &&
        nextCodeUnit <= UNICODE_LOW_SURROGATE_MAX
      )) {
        return true;
      }
      i += 1;
      continue;
    }
    if (
      UNICODE_LOW_SURROGATE_MIN <= codeUnit &&
      codeUnit <= UNICODE_LOW_SURROGATE_MAX
    ) {
      return true;
    }
  }
  return false;
}
