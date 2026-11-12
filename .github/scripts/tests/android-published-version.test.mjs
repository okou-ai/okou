import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { publishedAndroidVersion } from "../checks/android-published-version.mjs";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../checks/android-published-version.mjs", import.meta.url),
);

async function withGithub(evidence, action) {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    const key = request.url.replace("/repos/okou-ai/okou/", "");
    const body = evidence[key];
    response.writeHead(body?.httpStatus ?? (body === undefined ? 404 : 200), {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    await action({
      repository: "okou-ai/okou",
      token: "fixture-token",
      apiUrl: `http://127.0.0.1:${server.address().port}`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function evidence() {
  const versions = ["0.9.0", "0.10.0"];
  const data = {
    "git/matching-refs/tags/android-v": versions.map((version) => ({
      ref: `refs/tags/android-v${version}`,
      object: { type: "tag", sha: "a".repeat(40) },
    })),
  };
  for (const version of versions) {
    data[`releases/tags/android-v${version}`] = {
      tag_name: `android-v${version}`,
      draft: false,
      prerelease: false,
      assets: [{ name: "app-release.apk", state: "uploaded", size: 1234 }],
    };
  }
  return data;
}

function cli(options) {
  return run(process.execPath, [script], {
    env: {
      ...process.env,
      GH_TOKEN: options.token,
      GITHUB_REPOSITORY: options.repository,
      GITHUB_API_URL: options.apiUrl,
    },
  });
}

test("selects the highest stable APK release numerically, including annotated tags", async () => {
  const data = evidence();
  data["git/matching-refs/tags/android-v"].push({
    ref: "refs/tags/android-v1.0.0-beta.1",
    object: { type: "commit", sha: "b".repeat(40) },
  });
  await withGithub(data, async (options) =>
    assert.equal(await publishedAndroidVersion(options), "0.10.0"),
  );
});

test("a bare tag, draft, prerelease or missing completed APK cannot prove a newer floor", async () => {
  for (const invalid of [
    undefined,
    { draft: true },
    { prerelease: true },
    { assets: [] },
    { assets: [{ name: "app-release.aab", state: "uploaded", size: 1234 }] },
    { assets: [{ name: "app-release.apk", state: "starter", size: 1234 }] },
    { assets: [{ name: "app-release.apk", state: "uploaded", size: 0 }] },
  ]) {
    const data = evidence();
    const key = "releases/tags/android-v0.10.0";
    data[key] =
      invalid === undefined ? undefined : { ...data[key], ...invalid };
    await withGithub(data, async (options) =>
      assert.equal(await publishedAndroidVersion(options), "0.9.0"),
    );
  }
});

test("the CI command prints only the released version", async () => {
  await withGithub(evidence(), async (options) => {
    const result = await cli(options);
    assert.equal(result.stdout, "0.10.0\n");
    assert.equal(result.stderr, "");
  });
});

test("no Android publication leaves the CI version unset", async () => {
  await withGithub({}, async (options) => {
    const result = await cli(options);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No published Android GitHub Release/u);
  });
});

test("a GitHub failure leaves the version unset instead of claiming an older release", async () => {
  const data = evidence();
  data["releases/tags/android-v0.10.0"] = { httpStatus: 403 };
  await withGithub(data, async (options) => {
    const result = await cli(options);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Published Android version unavailable:.*403/u);
  });
});
