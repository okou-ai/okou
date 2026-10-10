import { PutObjectCommand } from "@aws-sdk/client-s3";
import { expect } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";

/** Observe the archive emitted by one ordinary publication request. */
export function readPublishedArchive(context: TestContext, start: number) {
  const archives = context.mocks.s3.send.mock.calls
    .slice(start)
    .flatMap(([command]) => {
      if (
        !(command instanceof PutObjectCommand) ||
        !command.input.Key?.endsWith("/archive.tar.gz")
      ) {
        return [];
      }
      return [command.input];
    });
  expect(archives).toHaveLength(1);
  const archive = archives[0];
  if (!archive?.Key || !(archive.Body instanceof Uint8Array)) {
    throw new Error("Expected one uploaded publication archive");
  }
  const versionId = archive.Key.split("/").at(-2);
  expect(versionId).toMatch(/^[a-f0-9]{64}$/);
  if (!versionId) {
    throw new Error("Expected a published storage version");
  }
  return { versionId, archiveSize: archive.Body.byteLength };
}
