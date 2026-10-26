import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const publisher = fileURLToPath(
  new URL(
    "../../../desktop/scripts/update-desktop-release-manifest.mjs",
    import.meta.url,
  ),
);
const pubDate = "2026-10-12T00:00:00.000Z";
function release(version) {
  return {
    version,
    name: `Okou ${version}`,
    notes: "Retained release notes",
    pubDate,
    platforms: {
      darwin: {
        arm64: {
          url: `https://github.com/okou-ai/okou/releases/download/okou-desktop-v${version}/Okou-darwin-arm64-${version}.zip`,
        },
      },
    },
  };
}
function fixture(t, manifest) {
  const directory = mkdtempSync(join(tmpdir(), "native-desktop-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  if (manifest) writeFileSync(path, JSON.stringify(manifest));
  return path;
}
function publish(path, version, date = pubDate) {
  execFileSync(
    process.execPath,
    [
      publisher,
      "--manifest",
      path,
      "--version",
      version,
      "--zip-url",
      release(version).platforms.darwin.arm64.url,
      ...(date ? ["--pub-date", date] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(readFileSync(path, "utf8"));
}
test("publishing Native metadata preserves Native history and blocklists while pruning Electron records", (t) => {
  const historical = {
    "0.49.75": release("0.49.75"),
    "0.50.0": release("0.50.0"),
    "0.52.2": release("0.52.2"),
    "0.53.1": release("0.53.1"),
  };
  const preview = { latest: "0.53.1", blocked: ["0.53.1"] };
  const path = fixture(t, {
    schemaVersion: 1,
    product: "okou",
    channels: {
      stable: { latest: "0.53.1", blocked: ["0.49.75", "0.53.1", "0.54.0"] },
      preview,
    },
    releases: historical,
  });
  const result = publish(path, "0.53.2");
  assert.deepEqual(Object.keys(result.releases).sort(), [
    "0.50.0",
    "0.52.2",
    "0.53.1",
    "0.53.2",
  ]);
  for (const version of ["0.50.0", "0.52.2", "0.53.1"])
    assert.deepEqual(result.releases[version], historical[version]);
  assert.deepEqual(result.channels.stable, {
    latest: "0.53.2",
    blocked: ["0.53.1", "0.54.0"],
  });
  assert.deepEqual(result.channels.preview, preview);
  assert.deepEqual(result.releases["0.53.2"], {
    ...release("0.53.2"),
    notes: "",
  });
  assert.deepEqual(publish(path, "0.53.2", null), result);
});
test("publishing the first Native release creates a compatible manifest", (t) => {
  const path = fixture(t);
  const result = publish(path, "0.50.0");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.product, "okou");
  assert.deepEqual(result.channels.stable, { latest: "0.50.0", blocked: [] });
  assert.equal(
    result.releases["0.50.0"].platforms.darwin.arm64.url,
    release("0.50.0").platforms.darwin.arm64.url,
  );
});
test("an Electron publication fails before modifying an existing manifest", (t) => {
  const path = fixture(t, {
    schemaVersion: 1,
    product: "okou",
    channels: { stable: { latest: "0.52.2", blocked: [] } },
    releases: { "0.52.2": release("0.52.2") },
  });
  const before = readFileSync(path, "utf8");
  assert.throws(() => publish(path, "0.49.75"), /requires Native 0\.50\.0/u);
  assert.equal(readFileSync(path, "utf8"), before);
});
test("inconsistent release identity fails without changing the manifest", (t) => {
  const path = fixture(t, {
    schemaVersion: 1,
    product: "okou",
    channels: { stable: { latest: "0.53.1", blocked: [] } },
    releases: { "0.53.1": release("0.49.75") },
  });
  const before = readFileSync(path, "utf8");
  assert.throws(() => publish(path, "0.53.2"), /does not match its key/u);
  assert.equal(readFileSync(path, "utf8"), before);
});
