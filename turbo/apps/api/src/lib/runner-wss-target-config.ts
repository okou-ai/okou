import { z } from "zod";

// The official Runner's inventory_hostname is the configured public WSS DNS
// name. The claim contract accepts arbitrary text, so validate the persisted
// snapshot before interpolating it into a browser-facing URL.
const publicRunnerHostnameSchema = z
  .string()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
  )
  .refine((name) => {
    const localSuffixes = [
      ".localhost",
      ".local",
      ".internal",
      ".home.arpa",
      ".invalid",
      ".test",
      ".example",
    ];
    return (
      !localSuffixes.some((suffix) => {
        return name.endsWith(suffix);
      }) && !/^\d+(?:\.\d+){3}$/.test(name)
    );
  });

/** A well-formed address, not proof of DNS, TLS, Caddy or live reachability. */
export function wssOriginFromRunnerHostname(hostname: string): string | null {
  if (!publicRunnerHostnameSchema.safeParse(hostname).success) {
    return null;
  }
  const origin = `wss://${hostname}:443`;
  // Browsers canonicalize abbreviated, hex and octal IPv4 hosts (for
  // example, 127.1 becomes 127.0.0.1). Never return a different authority
  // than the validated hostname supplied by the official Runner.
  if (!URL.canParse(origin) || new URL(origin).hostname !== hostname) {
    return null;
  }
  return origin;
}
