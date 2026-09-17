import { createHash } from "node:crypto";

const MAX_DNS_LABEL_LENGTH = 63;
const PUBLIC_SLUG_HASH_LENGTH = 4;
const PUBLIC_SLUG_HASH_SPACE = 36 ** PUBLIC_SLUG_HASH_LENGTH;
const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

function shortPublicSlugHash(
  orgId: string,
  site: string,
  scopeKey: string,
  attempt: number,
): string {
  const value = createHash("sha256")
    .update(`${orgId}\0${site}\0${scopeKey}\0${attempt}`)
    .digest()
    .readUInt32BE(0);
  return (value % PUBLIC_SLUG_HASH_SPACE)
    .toString(36)
    .padStart(PUBLIC_SLUG_HASH_LENGTH, "0");
}

function isImmutableDeploymentHostLabel(value: string): boolean {
  return IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(value);
}

export function publicSlugCandidate(
  site: string,
  orgId: string,
  scopeKey: string,
  attempt: number,
): string {
  if (attempt === 0 && !isImmutableDeploymentHostLabel(site)) {
    return site;
  }
  const hashAttempt = isImmutableDeploymentHostLabel(site)
    ? attempt
    : attempt - 1;
  const base = site.slice(
    0,
    MAX_DNS_LABEL_LENGTH - PUBLIC_SLUG_HASH_LENGTH - 1,
  );
  return `${base}-${shortPublicSlugHash(orgId, site, scopeKey, hashAttempt)}`;
}
