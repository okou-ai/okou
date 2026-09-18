import type { SharedThreadArtifactPolicy } from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { safeUriComponentDecode } from "../signals/utils";

const SHARED_THREAD_ARTIFACT_AUTHOR_PREFIX = "shared-thread-artifact:";

export const SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX = "shared-thread:";

/**
 * Shared-thread snapshots are stored as the previous API's known `file` kind,
 * but under an owner namespace that its exact-owner catalog query cannot see.
 * The new API projects these compatibility rows back to `shared-thread`.
 */
export function sharedThreadArtifactAuthorUserId(userId: string): string {
  return `${SHARED_THREAD_ARTIFACT_AUTHOR_PREFIX}${userId}`;
}

export function sharedThreadArtifactLogicalKey(id: string): string {
  return `${SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX}${id}`;
}

export function isSharedThreadArtifactLogicalKey(logicalKey: string): boolean {
  return logicalKey.startsWith(SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX);
}

export function sharedThreadHostedSnapshotFile(
  target: Extract<
    SharedThreadArtifactPolicy["resources"][string],
    { kind: "html" }
  >,
  previewPath: string | undefined,
) {
  const pathname = safeUriComponentDecode(
    new URL(previewPath ?? "/", "https://preview.invalid").pathname,
  );
  if (pathname === undefined) {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  if (
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    return null;
  }
  const path = segments.length ? `/${segments.join("/")}` : "/index.html";
  const file = target.manifest.files[path];
  if (file) {
    return file;
  }
  // Match the hosted viewer's navigation fallback without inventing assets.
  return target.manifest.spaFallback &&
    !/\.[A-Za-z0-9]+$/u.test(path) &&
    !path.startsWith("/assets/")
    ? (target.manifest.files["/index.html"] ?? null)
    : null;
}
