import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { readContentBundle } from "@okouai/core/content-bundle";

/** Inspect bytes published to the external S3 boundary using the claimed reference. */
export function readClaimedContentBundle(
  objects: ReadonlyMap<string, Buffer>,
  reference: ContentBundle & { readonly downloadUrl: string },
): ReadonlyMap<string, Buffer> {
  const key = `bundles/v1/${reference.sha256}.tar.gz`;
  const url = new URL(reference.downloadUrl);
  expect(url.protocol).toBe("https:");
  expect(url.searchParams.get("object")?.endsWith(`/${key}`)).toBeTruthy();
  const archive = objects.get(key);
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
