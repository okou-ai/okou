import { isIP } from "node:net";

/** Syntax only. Exact selected-tailnet assigned-peer membership is a native gate. */
export function canonicalTailscaleDestination(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (!value || value.length > 253 || /[^a-z0-9.:-]/u.test(value)) {
    return null;
  }
  const version = isIP(value);
  if (version === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 100 &&
      second !== undefined &&
      second >= 64 &&
      second <= 127
      ? value
      : null;
  }
  if (version === 6) {
    const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
    return canonical.startsWith("fd7a:115c:a1e0:") ? canonical : null;
  }
  if (
    value.includes(":") ||
    /^[0-9.]+$/u.test(value) ||
    /^0x[0-9a-f]+$/u.test(value)
  ) {
    return null;
  }
  const host = value.endsWith(".") ? value.slice(0, -1) : value;
  return host.split(".").every((label) => {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label);
  })
    ? host
    : null;
}
