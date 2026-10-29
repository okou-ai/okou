/** Prepare a submitted page address without searches or network discovery. */
export function navigationAddress(input: string): string | null {
  const value = input.trim();
  if (!value) {
    return null;
  }
  for (const char of value) {
    if (char < " " || char === "\u007f") {
      return null;
    }
  }

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1];
  const authority = (value.startsWith("//") ? value.slice(2) : value).split(
    /[/?#]/,
    1,
  )[0]!;
  const hostPort = /^[^:]+:\d+$/.test(authority);
  // Chrome's URL fixer treats dotted prefixes and numeric ports as hosts.
  // Keep unambiguous explicit schemes, including custom hierarchical URLs.
  const explicit =
    scheme !== undefined &&
    (value.slice(scheme.length + 1).startsWith("//") ||
      (!scheme.includes(".") &&
        scheme.toLowerCase() !== "localhost" &&
        !hostPort));
  if (explicit) {
    return URL.canParse(value) ? new URL(value).href : null;
  }
  if (
    value.includes("\\") ||
    (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("///")
  ) {
    return null;
  }
  return hostAddress(value, authority, hostPort);
}

function hostAddress(
  value: string,
  authority: string,
  hostPort: boolean,
): string | null {
  const candidate = value.startsWith("//")
    ? "http:" + value
    : "http://" + value;
  if (!URL.canParse(candidate)) {
    return null;
  }
  const parsed = new URL(candidate);
  const host = parsed.hostname.replace(/\.$/, "");
  if (
    !host ||
    host.startsWith(".") ||
    host.includes("..") ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  // Do not turn short numbers or legacy integer/hex IP spellings into hosts.
  const originalHost = authority.split(":", 1)[0]!;
  if (
    /^\d+(?:\.\d+){3}$/.test(host) &&
    !/^\d{1,3}(?:\.\d{1,3}){3}\.?$/.test(originalHost)
  ) {
    return null;
  }
  if (
    host === "localhost" ||
    host.includes(".") ||
    host.startsWith("[") ||
    hostPort ||
    value.startsWith("//")
  ) {
    return parsed.href;
  }
  return null;
}
