import { CLIENT_TYPE_DESKTOP } from "../contracts/client-headers";
import type { ClientResponseTransform } from "./types";

interface ClientResponseTransformRequest {
  /** The registry to select from; callers inject it rather than reading a global. */
  readonly transforms: readonly ClientResponseTransform[];
  /** The request's `X-Client-Type` header, if any. */
  readonly client: string | undefined;
  /** The request's `X-Client-Version` header, if any. */
  readonly version: string | undefined;
  /** The matched contract route's method and path template. */
  readonly method: string;
  readonly path: string;
  /** The validated response status. */
  readonly status: number;
}

type StableVersion = readonly [number, number, number];

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

function parseStableVersion(value: string): StableVersion | null {
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const version = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const;
  return version.every(Number.isSafeInteger) ? version : null;
}

function compareStableVersions(
  left: StableVersion,
  right: StableVersion,
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Returns the response transforms to apply, in registry order, so that a
 * Desktop build up to each transform's `maxVersion` receives the response shape
 * it was built against. Only `2xx` responses to `X-Client-Type: Desktop`
 * requests with a stable `x.y.z` version are transformed; every other request
 * selects nothing.
 */
export function selectClientResponseTransforms({
  transforms,
  client,
  version,
  method,
  path,
  status,
}: ClientResponseTransformRequest): readonly ClientResponseTransform[] {
  if (
    client !== CLIENT_TYPE_DESKTOP ||
    version === undefined ||
    !isSuccessStatus(status)
  ) {
    return [];
  }
  const clientVersion = parseStableVersion(version);
  if (!clientVersion) {
    return [];
  }

  return transforms.filter((entry) => {
    if (
      entry.method !== method ||
      entry.path !== path ||
      entry.status !== status
    ) {
      return false;
    }
    if (entry.maxVersion === null) {
      return true;
    }
    const maxVersion = parseStableVersion(entry.maxVersion);
    if (!maxVersion) {
      throw new Error(
        `Client response transform ${entry.method} ${entry.path} ${String(entry.status)} has a maxVersion that is not a stable x.y.z version: ${entry.maxVersion}`,
      );
    }
    return compareStableVersions(clientVersion, maxVersion) <= 0;
  });
}
