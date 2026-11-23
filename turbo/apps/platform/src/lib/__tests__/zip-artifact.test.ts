import { zipSync } from "fflate";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { readZipArtifact } from "../zip-artifact.ts";

const context = testContext();
const url = "https://artifacts.example.com/bundle.zip";
const fiveMiB = 5 * 1024 * 1024;

function mockArchiveStream(size: number) {
  const overhead = zipSync(
    { "payload.bin": new Uint8Array() },
    { level: 0 },
  ).length;
  const archive = zipSync(
    { "payload.bin": new Uint8Array(size - overhead) },
    { level: 0 },
  );
  expect(archive.byteLength).toBe(size);
  context.mocks.http.get(url, () => {
    return new HttpResponse(new Blob([archive.slice()]).stream(), {
      headers: { "Content-Type": "application/zip" },
    });
  });
}

test("Allows a 5 MiB archive with no declared length", async () => {
  mockArchiveStream(fiveMiB);
  await expect(
    readZipArtifact(url, undefined, context.signal),
  ).resolves.toStrictEqual([{ path: "payload.bin", preview: null }]);
});

test("Stops reading a ZIP over 5 MiB even without a declared length", async () => {
  mockArchiveStream(fiveMiB + 1);
  await expect(readZipArtifact(url, undefined, context.signal)).rejects.toThrow(
    "ZIP artifact exceeds its preview limit",
  );
});
