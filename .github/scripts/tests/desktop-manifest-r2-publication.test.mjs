import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { currentKey, startS3 } from "./fixtures/desktop-manifest-r2-server.mjs";

const execFileAsync = promisify(execFile);
const publisher = fileURLToPath(
  new URL("../release/publish-desktop-manifest-r2.sh", import.meta.url),
);
const publicationSha = "a".repeat(40);
const version = "0.54.3";
const zipUrl = `https://github.com/okou-ai/okou/releases/download/okou-desktop-v${version}/Okou-darwin-arm64-${version}.zip`;
const previousManifest = {
  schemaVersion: 1,
  product: "okou",
  channels: {
    stable: { latest: "0.54.2", blocked: ["0.54.0"] },
    preview: { latest: "0.54.2", blocked: ["0.54.2"] },
  },
  releases: {
    "0.54.2": {
      version: "0.54.2",
      pubDate: "2026-10-21T07:44:53Z",
      platforms: {
        darwin: {
          arm64: {
            url: "https://github.com/okou-ai/okou/releases/download/okou-desktop-v0.54.2/Okou-darwin-arm64-0.54.2.zip",
          },
        },
      },
    },
  },
};
const previous = Buffer.from(JSON.stringify(previousManifest) + "\n");
const otherPublication = Buffer.from(
  JSON.stringify({
    ...previousManifest,
    channels: {
      ...previousManifest.channels,
      stable: { latest: "0.54.2", blocked: ["0.54.0", "0.54.2"] },
    },
  }) + "\n",
);

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-manifest-r2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "manifest.json");
  const config = join(directory, "aws-config");
  await writeFile(config, "");
  const s3 = await startS3(t, { current: previous, ...options });
  return {
    ...s3,
    path,
    publish() {
      return execFileAsync(
        "bash",
        [
          publisher,
          s3.endpoint,
          "desktop-test",
          path,
          publicationSha,
          version,
          zipUrl,
        ],
        {
          signal: t.signal,
          env: {
            PATH: process.env.PATH,
            TMPDIR: directory,
            AWS_ACCESS_KEY_ID: "test-access-key",
            AWS_SECRET_ACCESS_KEY: "test-secret-key",
            AWS_DEFAULT_REGION: "auto",
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_CONFIG_FILE: config,
            AWS_SHARED_CREDENTIALS_FILE: config,
          },
        },
      );
    },
  };
}

test("publication preserves R2 history and exports verified bytes for the compatibility mirror", async (t) => {
  const s3 = await fixture(t);
  await s3.publish();
  const published = s3.objects.get(currentKey);
  const manifest = JSON.parse(published);
  assert.deepEqual(manifest.channels, {
    ...previousManifest.channels,
    stable: { ...previousManifest.channels.stable, latest: version },
  });
  assert.deepEqual(
    manifest.releases["0.54.2"],
    previousManifest.releases["0.54.2"],
  );
  assert.equal(manifest.releases[version].platforms.darwin.arm64.url, zipUrl);
  assert.deepEqual(await readFile(s3.path), published);
  const snapshots = [...s3.objects].filter(([key]) => key !== currentKey);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0][1], published);
  // A rerun reconciles the existing immutable receipt rather than replacing it.
  await s3.publish();
  assert.equal(s3.objects.size, 2);
  assert.deepEqual(s3.objects.get(currentKey), published);
  assert.deepEqual(s3.objects.get(snapshots[0][0]), published);
  assert.ok(
    s3.requests.every(({ method }) => method === "GET" || method === "PUT"),
  );
});

test("a missing authoritative R2 manifest fails publication", async (t) => {
  const s3 = await fixture(t, { current: undefined });
  await assert.rejects(
    s3.publish(),
    /Cannot read the current Desktop manifest from R2: NoSuchKey/u,
  );
  assert.equal(s3.objects.size, 0);
});

for (const mode of [
  "snapshot-failure",
  "snapshot-corrupt",
  "current-failure",
  "denied",
]) {
  test(`${mode} fails publication while retaining the previous readable object`, async (t) => {
    const s3 = await fixture(t, { mode });
    await assert.rejects(s3.publish());
    assert.deepEqual(s3.objects.get(currentKey), previous);
    if (mode !== "current-failure") {
      assert.ok(
        s3.requests.every(
          ({ method, key }) => method !== "PUT" || key !== currentKey,
        ),
      );
    }
  });
}

test("a lost PUT response is verified without replaying the write", async (t) => {
  const s3 = await fixture(t, { mode: "lost-response" });
  await s3.publish();
  assert.equal(
    JSON.parse(s3.objects.get(currentKey)).channels.stable.latest,
    version,
  );
  assert.deepEqual(await readFile(s3.path), s3.objects.get(currentKey));
  assert.equal(
    s3.requests.filter(
      ({ method, key }) => method === "PUT" && key === currentKey,
    ).length,
    1,
  );
});

test("a change after the source read preserves the concurrent publication and fails", async (t) => {
  const s3 = await fixture(t, {
    mode: "conflict",
    concurrent: otherPublication,
  });
  await assert.rejects(s3.publish());
  assert.deepEqual(s3.objects.get(currentKey), otherPublication);
});

test(
  "cancellation retires the owned upload without starting another write",
  { timeout: 15_000 },
  async (t) => {
    const s3 = await fixture(t, { mode: "cancel" });
    const publication = s3.publish();
    const rejected = assert.rejects(publication, { code: 143 });
    await s3.currentPut;
    publication.child.kill("SIGTERM");
    await rejected;
    await s3.uploadClosed;
    assert.deepEqual(s3.objects.get(currentKey), previous);
  },
);
