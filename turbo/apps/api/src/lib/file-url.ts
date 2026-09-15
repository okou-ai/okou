import { createHash } from "node:crypto";
import { isArtifactPublicationFilePath } from "@okouai/api-contracts/contracts/artifact-delivery";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { env } from "./env";

const ARTIFACTS_PREFIX = "artifacts";
const ARTIFACTS_PATH_PREFIX = `${ARTIFACTS_PREFIX}/`;
const ARTIFACT_HASH_LENGTH = 10;
const ARTIFACT_HASH_SPACE = 36n ** BigInt(ARTIFACT_HASH_LENGTH);
const CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX = "/cdn-cgi/image/";

// Both origins are durable public URL contracts. New Okou links may use the
// short origin, while previously persisted or externally shared CDN links
// remain valid for the lifetime of their artifacts.
export const OKOU_SHORT_ARTIFACTS_ORIGIN = "https://a.okou.io";
export const OKOU_CDN_ARTIFACTS_ORIGIN = "https://cdn.okou.io";

/**
 * Sanitize a user-supplied filename for use in an artifact object key.
 * Replaces characters that are unsafe or problematic in URLs / object storage
 * (spaces, non-ASCII, etc.) with underscores so the key is stable and
 * predictable across upload, message storage, and retrieval.
 */
export function sanitizeArtifactFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function publicArtifactsBaseUrlForBrand(
  publicBrand: PublicBrand,
): string {
  const configuredUrl =
    publicBrand === "okou"
      ? env("OKOU_PUBLIC_ARTIFACTS_BASE_URL")
      : env("PUBLIC_ARTIFACTS_BASE_URL");
  return configuredUrl.replace(/\/+$/, "");
}

export function buildArtifactKey(
  userId: string,
  id: string,
  filename: string,
): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
}

export function buildArtifactPrefix(userId: string, id: string): string {
  return `${ARTIFACTS_PREFIX}/${encodeURIComponent(userId)}/${id}/`;
}

export function artifactHash(id: string, variant?: string): string {
  const seed = variant === undefined ? id : `${id}\0${variant}`;
  const digestPrefix = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 16);
  return (BigInt(`0x${digestPrefix}`) % ARTIFACT_HASH_SPACE)
    .toString(36)
    .padStart(ARTIFACT_HASH_LENGTH, "0");
}

function artifactExtension(filename: string): string {
  const sanitized = sanitizeArtifactFilename(filename);
  const extension = sanitized.split(".").pop();
  return extension && extension !== sanitized ? extension.toLowerCase() : "bin";
}

export function buildArtifactPrefixV2(id: string, variant?: string): string {
  return `${ARTIFACTS_PREFIX}/${artifactHash(id, variant)}.`;
}

export function buildArtifactKeyV2(
  id: string,
  filename: string,
  variant?: string,
): string {
  return `${buildArtifactPrefixV2(id, variant)}${artifactExtension(filename)}`;
}

export function isArtifactKeyV2(key: string): boolean {
  return /^artifacts\/[0-9a-z]{10}\.[^/]+$/u.test(key);
}

/**
 * Resolve the storage key addressed by Okou's short public artifact domain.
 * The edge maps `/path` to the existing `artifacts/path` object key, including
 * transformed image URLs whose source path follows the transform directives.
 */
export function artifactKeyFromShortOkouUrl(url: URL): string | null {
  if (
    url.origin !== OKOU_SHORT_ARTIFACTS_ORIGIN ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  let pathname = url.pathname;
  if (pathname.startsWith(CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX)) {
    const sourceStart = pathname.indexOf(
      "/",
      CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX.length,
    );
    if (sourceStart === -1) {
      return null;
    }
    pathname = pathname.slice(sourceStart);
  } else if (pathname.startsWith("/cdn-cgi/")) {
    return null;
  }

  const shortPath = pathname.replace(/^\/+/, "");
  if (isArtifactPublicationFilePath(`/${shortPath}`)) {
    return null;
  }
  return shortPath === "" ? null : `${ARTIFACTS_PATH_PREFIX}${shortPath}`;
}

/**
 * Use the CDN form as the canonical catalog identity for both durable public
 * aliases. This is identity normalization rather than a rollout fallback:
 * neither public origin is retired. Existing catalog rows therefore need no
 * migration and completion retries cannot create a second logical artifact.
 */
export function canonicalOkouArtifactCatalogUrl(url: URL): string | null {
  const key = artifactKeyFromShortOkouUrl(url);
  return key === null
    ? null
    : `${OKOU_CDN_ARTIFACTS_ORIGIN}/${key}${url.search}${url.hash}`;
}

export function buildFileUrlFromKey(
  key: string,
  publicBrand: PublicBrand,
): string {
  const baseUrl = publicArtifactsBaseUrlForBrand(publicBrand);
  const normalizedKey = key.replace(/^\/+/, "");
  const publicPath =
    publicBrand === "okou" &&
    baseUrl === OKOU_SHORT_ARTIFACTS_ORIGIN &&
    normalizedKey.startsWith(ARTIFACTS_PATH_PREFIX)
      ? normalizedKey.slice(ARTIFACTS_PATH_PREFIX.length)
      : normalizedKey;
  return `${baseUrl}/${publicPath}`;
}
