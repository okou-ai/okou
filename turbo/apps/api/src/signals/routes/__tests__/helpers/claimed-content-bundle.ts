import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { readContentBundle } from "@okouai/core/content-bundle";
import { seededSkillBundleArchive } from "../../../../test-fixtures/seeded-skill-bundle-archive";

/** Inspect new or baseline external S3 fixture bytes using the claimed reference. */
export function readClaimedContentBundle(
  objects: ReadonlyMap<string, Buffer>,
  reference: ContentBundle & { readonly downloadUrl: string },
): ReadonlyMap<string, Buffer> {
  const key = `bundles/v1/${reference.sha256}.tar.gz`;
  const url = new URL(reference.downloadUrl);
  expect(url.protocol).toBe("https:");
  // A cached URL can come from a different valid external signer fixture.
  // The object identity is stable; the fixture's query-only URL shape is not.
  const objectPath =
    url.searchParams.get("object") ?? decodeURIComponent(url.pathname);
  expect(objectPath.endsWith(`/${key}`)).toBeTruthy();
  const archive = objects.get(key) ?? seededSkillBundleArchive(key);
  if (!archive) {
    throw new Error("Claimed content bundle was not published to S3");
  }
  expect(archive).toHaveLength(reference.archiveBytes);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(
    reference.sha256,
  );
  return new Map(
    readContentBundle(archive, {
      sha256: reference.sha256,
      archiveBytes: reference.archiveBytes,
    }).map((file) => {
      return [file.path, file.content];
    }),
  );
}
