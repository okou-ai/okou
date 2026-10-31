import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  DESKTOP_UPDATE_LINE_OKOU,
  type DesktopUpdateArchitecture,
  type DesktopUpdateChannel,
  type DesktopUpdatePlatform,
} from "@okouai/api-contracts/contracts/desktop-updates";
import { DESKTOP_PRODUCT_OKOU } from "@okouai/api-contracts/contracts/client-headers";
import { delay } from "signal-timers";
import {
  array,
  iso,
  literal,
  object,
  record,
  string,
  url,
  type infer as zInfer,
} from "zod";

import { logger } from "../../lib/log";
import { desktopVersionIsSupported } from "../../lib/desktop-version";
import { testOverride } from "../../lib/singleton";
import { now } from "../../lib/time";
import { settle } from "../utils";

const L = logger("DesktopUpdates");

/**
 * Shared identity for the structured events this path emits.
 *
 * An unreadable release host is routine and self-correcting, so it is reported
 * as a classified outcome rather than an unhandled request error. Keeping the
 * type and provider in one place lets the three outcomes — `retry_recovered`,
 * `served_stale`, `unavailable` — be queried as one family.
 */
export const DESKTOP_UPDATE_MANIFEST_LOG_TYPE =
  "desktop_update_manifest_upstream";
export const DESKTOP_UPDATE_MANIFEST_PROVIDER = "cloudflare_r2";

const DESKTOP_RELEASE_DOWNLOAD_URL_PREFIX =
  "https://github.com/okou-ai/okou/releases/download";
const DESKTOP_RELEASE_PAGE_URL_PREFIX =
  "https://github.com/okou-ai/okou/releases/tag";
const DESKTOP_UPDATE_MANIFEST_URL =
  "https://static.okou.io/desktop-updates/okou/manifest.json";
// 0.50.0 is the first Native release, independent of Computer Use admission.
const MIN_NATIVE_DESKTOP_VERSION = "0.50.0";

const DESKTOP_UPDATE_MANIFEST_CACHE_TTL_MS = 60_000;

/**
 * How long a manifest may still answer requests while the upstream host is
 * unreachable, measured from the moment it was fetched.
 *
 * The manifest describes releases that already exist, so serving a slightly
 * old copy hands an updater a real artifact instead of an error. The window is
 * bounded because a stale manifest also keeps serving a version that a later
 * publish may have blocked, and that must not outlive a short outage. It is
 * anchored to the fetch, never to the last stale hit, so a long outage expires
 * the copy instead of renewing it: past this age the routes answer `503` and
 * sustained unavailability stays visible.
 *
 * One desktop poll interval. A client that receives a stale manifest re-asks
 * within that interval, so the worst case is one skipped update check.
 */
const DESKTOP_UPDATE_MANIFEST_STALE_MAX_AGE_MS = 30 * 60_000;

/**
 * Attempts and spacing for one request's manifest fetch.
 *
 * A desktop updater polls on its own schedule, so the retry budget only has to
 * absorb a single-instance blip; anything longer is the caller's next poll or
 * the stale window above, not more attempts inside this request.
 */
const DESKTOP_UPDATE_MANIFEST_FETCH_ATTEMPTS = 3;
const DESKTOP_UPDATE_MANIFEST_RETRY_DELAY_MS = 200;

/**
 * The upstream manifest could not be read and no usable copy was cached.
 *
 * Distinct from every other manifest failure: it means "try again", not "a
 * human has to fix the manifest", so the routes answer `503` instead of `500`.
 * `providerStatus` is the upstream status when there was one, and `null` when
 * the attempt never got a response (connection failure or the per-attempt
 * deadline).
 */
export interface DesktopUpdateManifestUnavailable {
  readonly providerStatus: number | null;
  readonly attempts: number;
}

class DesktopUpdateManifestUnavailableError
  extends Error
  implements DesktopUpdateManifestUnavailable
{
  constructor(
    readonly providerStatus: number | null,
    readonly attempts: number,
    options?: { readonly cause?: unknown },
  ) {
    super("Desktop update manifest is temporarily unavailable", options);
    this.name = "DesktopUpdateManifestUnavailableError";
  }
}

export function desktopUpdateManifestUnavailable(
  error: unknown,
): DesktopUpdateManifestUnavailable | null {
  return error instanceof DesktopUpdateManifestUnavailableError ? error : null;
}

/**
 * Upstream statuses that describe the host, not the manifest.
 *
 * A `404` is excluded on purpose: the manifest asset is published by our own
 * release pipeline, so its absence is a broken release, not an outage.
 */
function isTransientManifestStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Every artifact this service can still name belongs to the Okou desktop
 * product. #31475 removed the Zero line, so the artifact name and release tag
 * prefix are no longer derived per line.
 */
const DESKTOP_ARTIFACT_NAME = "Okou";
const DESKTOP_RELEASE_TAG_PREFIX = "okou-desktop-v";

/**
 * Only the current Okou update line resolves release artifacts. The routes
 * reject retired product lines before calling this service.
 */
type ResolvableDesktopUpdateLine = typeof DESKTOP_UPDATE_LINE_OKOU;

const desktopUpdateAssetSchema = object({
  url: url(),
});

const desktopUpdateReleaseSchema = object({
  version: string().min(1),
  name: string().optional(),
  notes: string().optional(),
  pubDate: iso.datetime(),
  platforms: record(string(), record(string(), desktopUpdateAssetSchema)),
});

const desktopUpdateChannelSchema = object({
  latest: string().min(1),
  blocked: array(string().min(1)).optional(),
});

const desktopUpdateManifestSchema = object({
  schemaVersion: literal(1),
  product: literal(DESKTOP_PRODUCT_OKOU),
  channels: record(string(), desktopUpdateChannelSchema),
  releases: record(string(), desktopUpdateReleaseSchema),
});

type DesktopUpdateManifest = zInfer<typeof desktopUpdateManifestSchema>;

interface DesktopUpdateFeedRequest {
  readonly line: ResolvableDesktopUpdateLine;
  readonly channel: DesktopUpdateChannel;
  readonly platform: DesktopUpdatePlatform;
  readonly arch: DesktopUpdateArchitecture;
}

/**
 * `freshUntil` and `staleUntil` are both derived from `fetchedAt` when the
 * entry is written, and an entry is only ever written after a successful
 * fetch. A failed fetch therefore cannot extend either deadline, and neither
 * can a stale hit.
 */
interface DesktopUpdateManifestCacheEntry {
  readonly fetchedAt: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
  readonly manifest: DesktopUpdateManifest;
}

const desktopUpdateManifestCache = testOverride<
  Partial<Record<ResolvableDesktopUpdateLine, DesktopUpdateManifestCacheEntry>>
>(() => {
  return {};
});

function compareDesktopVersions(left: string, right: string): number {
  const leftParts = left.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];
  const rightParts = right.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];

  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return left.localeCompare(right);
}

function compareDesktopVersionsDesc(left: string, right: string): number {
  return compareDesktopVersions(right, left);
}

function assetForRelease(
  release: DesktopUpdateManifest["releases"][string],
  request: DesktopUpdateFeedRequest,
): { readonly url: string } | null {
  const asset = release.platforms[request.platform]?.[request.arch];
  if (!asset) {
    return null;
  }

  const expectedAssetName = `${DESKTOP_ARTIFACT_NAME}-${request.platform}-${request.arch}-${release.version}.zip`;
  const actualAssetName = decodeURIComponent(
    new URL(asset.url).pathname.split("/").at(-1) ?? "",
  );
  return actualAssetName === expectedAssetName ? asset : null;
}

export interface DesktopUpdateRelease {
  readonly version: string;
  readonly name: string;
  readonly notes: string;
  readonly pubDate: string;
  readonly url: string;
}

function desktopUpdateRelease(
  release: DesktopUpdateManifest["releases"][string],
  asset: { readonly url: string },
): DesktopUpdateRelease {
  return {
    version: release.version,
    name: release.name ?? `${DESKTOP_ARTIFACT_NAME} ${release.version}`,
    pubDate: release.pubDate,
    url: asset.url,
    notes: release.notes ?? "",
  };
}

function desktopReleasePageUrl(
  release: DesktopUpdateManifest["releases"][string],
): string {
  const tagName = `${DESKTOP_RELEASE_TAG_PREFIX}${release.version}`;
  return `${DESKTOP_RELEASE_PAGE_URL_PREFIX}/${encodeURIComponent(tagName)}`;
}

function desktopDmgDownloadUrl(
  release: DesktopUpdateManifest["releases"][string],
  request: DesktopUpdateFeedRequest,
): string {
  const tagName = `${DESKTOP_RELEASE_TAG_PREFIX}${release.version}`;
  const assetName = `${DESKTOP_ARTIFACT_NAME}-${request.platform}-${request.arch}-${release.version}.dmg`;
  return `${DESKTOP_RELEASE_DOWNLOAD_URL_PREFIX}/${encodeURIComponent(
    tagName,
  )}/${encodeURIComponent(assetName)}`;
}

function selectDesktopRelease(
  manifest: DesktopUpdateManifest,
  request: DesktopUpdateFeedRequest,
) {
  const channel = manifest.channels[request.channel];
  if (!channel) {
    return null;
  }

  const blocked = new Set(channel.blocked ?? []);
  const latest = manifest.releases[channel.latest];
  if (
    latest &&
    desktopVersionIsSupported(latest.version, MIN_NATIVE_DESKTOP_VERSION) &&
    !blocked.has(latest.version)
  ) {
    const latestAsset = assetForRelease(latest, request);
    if (latestAsset) {
      return { release: latest, asset: latestAsset };
    }
  }

  const [fallback] = Object.values(manifest.releases)
    .filter((release) => {
      return (
        desktopVersionIsSupported(
          release.version,
          MIN_NATIVE_DESKTOP_VERSION,
        ) &&
        !blocked.has(release.version) &&
        compareDesktopVersions(release.version, channel.latest) <= 0 &&
        assetForRelease(release, request)
      );
    })
    .sort((left, right) => {
      return compareDesktopVersionsDesc(left.version, right.version);
    });
  if (!fallback) {
    return null;
  }

  const asset = assetForRelease(fallback, request);
  if (!asset) {
    return null;
  }

  return { release: fallback, asset };
}

/**
 * One manifest read. A retryable outage is returned so the caller can decide
 * whether any attempts remain; every other failure throws, because no number
 * of retries will fix it.
 */
type DesktopUpdateManifestFetchResult =
  | { readonly ok: true; readonly manifest: DesktopUpdateManifest }
  | {
      readonly ok: false;
      readonly providerStatus: number | null;
      readonly cause: unknown;
    };

async function fetchDesktopUpdateManifestOnce(
  signal: AbortSignal,
): Promise<DesktopUpdateManifestFetchResult> {
  const fetched = await settle(
    (async () => {
      const acceptedResponse = await settle(
        accept(
          fetch(DESKTOP_UPDATE_MANIFEST_URL, {
            headers: { accept: "application/json" },
          }),
          [200],
        ),
      );
      if (!acceptedResponse.ok) {
        const error = acceptedResponse.error;
        if (error instanceof HttpStatusError && error.status >= 300) {
          return error.response;
        }
        throw error;
      }
      return acceptedResponse.value;
    })(),
    signal,
  );
  if (!fetched.ok) {
    return {
      ok: false,
      providerStatus: null,
      cause: fetched.error,
    };
  }

  const response = fetched.value;
  if (!response.ok) {
    if (isTransientManifestStatus(response.status)) {
      return { ok: false, providerStatus: response.status, cause: undefined };
    }
    throw new Error(
      `Desktop update manifest fetch failed with ${response.status}`,
    );
  }

  const body = await settle(response.json(), signal);
  if (!body.ok) {
    // A body that never arrived intact is an unreadable host. Invalid JSON is
    // the opposite: the bytes did arrive and they are not a manifest, which is
    // a broken release and must stay as loud as a schema failure.
    if (body.error instanceof SyntaxError) {
      throw body.error;
    }
    return { ok: false, providerStatus: null, cause: body.error };
  }

  const manifest = desktopUpdateManifestSchema.parse(body.value);
  return { ok: true, manifest };
}

async function fetchDesktopUpdateManifest(
  line: ResolvableDesktopUpdateLine,
  signal: AbortSignal,
): Promise<DesktopUpdateManifest> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await fetchDesktopUpdateManifestOnce(signal);
    if (result.ok) {
      if (attempt > 1) {
        L.debug("Desktop update manifest fetch recovered on retry", {
          type: DESKTOP_UPDATE_MANIFEST_LOG_TYPE,
          outcome: "retry_recovered",
          provider: DESKTOP_UPDATE_MANIFEST_PROVIDER,
          failure_class: "transient_read",
          attempts: attempt,
          line,
        });
      }
      return result.manifest;
    }
    if (attempt >= DESKTOP_UPDATE_MANIFEST_FETCH_ATTEMPTS) {
      throw new DesktopUpdateManifestUnavailableError(
        result.providerStatus,
        attempt,
        result.cause === undefined ? undefined : { cause: result.cause },
      );
    }
    await delay(DESKTOP_UPDATE_MANIFEST_RETRY_DELAY_MS, { signal });
  }
}

async function loadDesktopUpdateManifest(
  line: ResolvableDesktopUpdateLine,
  signal: AbortSignal,
): Promise<DesktopUpdateManifest> {
  const cache = desktopUpdateManifestCache.get();
  const cacheEntry = cache[line];
  const nowMs = now();
  if (cacheEntry && cacheEntry.freshUntil > nowMs) {
    return cacheEntry.manifest;
  }

  const fetched = await settle(
    fetchDesktopUpdateManifest(line, signal),
    signal,
  );
  if (!fetched.ok) {
    const unavailable = desktopUpdateManifestUnavailable(fetched.error);
    // The bounded retries themselves take time. Re-read the clock after they
    // finish so a cache entry cannot cross the stale deadline while the
    // upstream attempts are in flight and still be served.
    const staleNowMs = now();
    // A missing or invalid manifest is not covered here on purpose: only an
    // unreadable host may be answered from an older copy, so a broken release
    // still surfaces instead of being papered over by the last good manifest.
    if (!unavailable || !cacheEntry || cacheEntry.staleUntil <= staleNowMs) {
      throw fetched.error;
    }

    L.debug("Served a stale desktop update manifest", {
      type: DESKTOP_UPDATE_MANIFEST_LOG_TYPE,
      outcome: "served_stale",
      provider: DESKTOP_UPDATE_MANIFEST_PROVIDER,
      ...(unavailable.providerStatus === null
        ? {}
        : { provider_status: unavailable.providerStatus }),
      failure_class: "transient_read",
      attempts: unavailable.attempts,
      stale_age_ms: staleNowMs - cacheEntry.fetchedAt,
      line,
    });
    return cacheEntry.manifest;
  }

  const fetchedAt = now();
  desktopUpdateManifestCache.set({
    ...cache,
    [line]: {
      fetchedAt,
      freshUntil: fetchedAt + DESKTOP_UPDATE_MANIFEST_CACHE_TTL_MS,
      staleUntil: fetchedAt + DESKTOP_UPDATE_MANIFEST_STALE_MAX_AGE_MS,
      manifest: fetched.value,
    },
  });
  return fetched.value;
}

export async function loadDesktopUpdateRelease(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<DesktopUpdateRelease | null> {
  const manifest = await loadDesktopUpdateManifest(request.line, signal);
  const selected = selectDesktopRelease(manifest, request);
  return selected
    ? desktopUpdateRelease(selected.release, selected.asset)
    : null;
}

export async function loadDesktopReleasePageUrl(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<string | null> {
  const manifest = await loadDesktopUpdateManifest(request.line, signal);
  const selected = selectDesktopRelease(manifest, request);
  return selected ? desktopReleasePageUrl(selected.release) : null;
}

export async function loadDesktopDmgDownloadUrl(
  request: DesktopUpdateFeedRequest,
  signal: AbortSignal,
): Promise<string | null> {
  const manifest = await loadDesktopUpdateManifest(request.line, signal);
  const selected = selectDesktopRelease(manifest, request);
  return selected ? desktopDmgDownloadUrl(selected.release, request) : null;
}
