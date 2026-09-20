import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const scriptPath = join(
  __dirname,
  "..",
  "scripts",
  "update-desktop-release-manifest.mjs",
);
const zipUrl =
  "https://github.com/okou-ai/okou/releases/download/test/Okou-darwin-arm64-1.2.3.zip";

function temporaryManifestPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "desktop-manifest-"));
  temporaryDirectories.push(directory);
  return join(directory, "manifest.json");
}

function runManifestUpdate(
  manifestPath: string,
  assetUrl = zipUrl,
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--manifest",
      manifestPath,
      "--version",
      "1.2.3",
      "--zip-url",
      assetUrl,
      "--pub-date",
      "2026-08-11T00:00:00.000Z",
    ],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("update desktop release manifest", () => {
  it("creates the canonical Okou manifest", () => {
    const manifestPath = temporaryManifestPath();
    const result = runManifestUpdate(manifestPath);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual({
      schemaVersion: 1,
      product: "okou",
      channels: { stable: { latest: "1.2.3", blocked: [] } },
      releases: {
        "1.2.3": {
          version: "1.2.3",
          name: "Okou 1.2.3",
          notes: "",
          pubDate: "2026-08-11T00:00:00.000Z",
          platforms: { darwin: { arm64: { url: zipUrl } } },
        },
      },
    });
  });

  it("preserves release metadata, blocked versions and other platform assets", () => {
    const manifestPath = temporaryManifestPath();
    const previousRelease = { version: "1.2.2", notes: "Previous release" };
    const otherAsset = { url: "https://example.test/other.zip" };
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        product: "okou",
        channels: {
          stable: { latest: "1.2.2", blocked: ["1.2.1"] },
          beta: { latest: "1.3.0", blocked: [] },
        },
        releases: {
          "1.2.2": previousRelease,
          "1.2.3": {
            name: "Release title",
            notes: "Release notes",
            platforms: { darwin: { other: otherAsset } },
          },
        },
      }),
    );
    const result = runManifestUpdate(manifestPath);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
      product: "okou",
      channels: {
        stable: { latest: "1.2.3", blocked: ["1.2.1"] },
        beta: { latest: "1.3.0", blocked: [] },
      },
      releases: {
        "1.2.2": previousRelease,
        "1.2.3": {
          name: "Release title",
          notes: "Release notes",
          platforms: { darwin: { arm64: { url: zipUrl }, other: otherAsset } },
        },
      },
    });
  });

  it.each([
    { schemaVersion: 1, channels: {}, releases: {} },
    { product: "unexpected" },
    { product: null },
    null,
    [],
  ])(
    "rejects an existing manifest without canonical product identity: %j",
    (manifest) => {
      const manifestPath = temporaryManifestPath();
      const original = JSON.stringify(manifest);
      writeFileSync(manifestPath, original);
      const result = runManifestUpdate(manifestPath);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Desktop update manifest product mismatch",
      );
      expect(readFileSync(manifestPath, "utf8")).toBe(original);
    },
  );

  it("rejects malformed JSON without overwriting the existing manifest", () => {
    const manifestPath = temporaryManifestPath();
    writeFileSync(manifestPath, "{malformed");
    expect(runManifestUpdate(manifestPath).status).toBe(1);
    expect(readFileSync(manifestPath, "utf8")).toBe("{malformed");
  });

  it.each(["Other-darwin-arm64-1.2.3.zip", "Okou-darwin-arm64-1.2.2.zip"])(
    "rejects a mismatched artifact %s",
    (asset) => {
      const result = runManifestUpdate(
        temporaryManifestPath(),
        `https://example.test/${asset}`,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Desktop update asset must be Okou-darwin-arm64-1.2.3.zip",
      );
    },
  );
});
