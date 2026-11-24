import { domainToASCII } from "node:url";
import { parse } from "tldts";

const RESERVED = Object.freeze([
  "okou.app",
  "okou.ai",
  "okou.io",
  "vm0.io",
  "vm7.io",
  "localhost",
  "local",
  "internal",
  "test",
  "invalid",
  "example",
]);
export function normalizeHostedSiteHostname(input: string): string | null {
  const source = input.trim();
  if (!source) {
    return null;
  }
  if (/[\s/:?#@%[\]\\]/u.test(source)) {
    return null;
  }
  const hostname = domainToASCII(source).toLowerCase().replace(/\.$/u, "");
  // The independent TXT record also has to fit the DNS name length limit.
  if (
    !hostname ||
    hostname.length > 237 ||
    hostname.split(".").some((label) => {
      return !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label);
    })
  ) {
    return null;
  }
  if (
    RESERVED.some((domain) => {
      return hostname === domain || hostname.endsWith(`.${domain}`);
    })
  ) {
    return null;
  }
  const parsed = parse(hostname, { allowPrivateDomains: true });
  return parsed.domain && !parsed.isIp && (parsed.isIcann || parsed.isPrivate)
    ? hostname
    : null;
}

export function hostedSiteApexHostname(hostname: string) {
  return parse(hostname, { allowPrivateDomains: true }).domain === hostname;
}
