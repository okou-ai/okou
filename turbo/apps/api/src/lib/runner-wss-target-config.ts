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
  return `wss://${hostname}:443`;
}

function releaseParts(value: string): readonly [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** A version floor is not configured until #37027 identifies a mandatory-listener release. */
export const wssMinimumRunnerVersionSchema = z
  .string()
  .max(128)
  .refine((value) => {
    return releaseParts(value) !== null;
  }, "Expected a release MAJOR.MINOR.PATCH");

export function supportsMandatoryWssListener(
  version: string,
  minimumVersion: string,
): boolean {
  const parts = releaseParts(version);
  const floor = releaseParts(minimumVersion);
  if (!parts || !floor || parts[0] !== floor[0]) {
    return false;
  }
  return parts[1] > floor[1] || (parts[1] === floor[1] && parts[2] >= floor[2]);
}
