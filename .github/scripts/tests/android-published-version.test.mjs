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

async function withUpdates(body, action) {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/android/updates");
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(body?.httpStatus ?? (body === undefined ? 404 : 200), {
      "content-type": "application/json",
      ...(body?.location ? { location: body.location } : {}),
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    await action({
      updatesUrl: `http://127.0.0.1:${server.address().port}/api/android/updates`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function discovery(version = "0.10.0") {
  return {
    minimumSupportedVersion: null,
    release: {
      version,
      minimumSdk: 24,
      size: 1234,
      sha256: "a".repeat(64),
      url: `https://static.okou.io/android-updates/releases/${version}/${"a".repeat(64)}.apk`,
      notes: "A published update",
    },
  };
}

function cli(options) {
  return run(process.execPath, [script], {
    env: {
      ...process.env,
      GH_TOKEN: "fixture-token",
      ANDROID_UPDATES_URL: options.updatesUrl,
    },
  });
}

test("publication availability cannot advance beyond the R2-backed discovery feed", async () => {
  const data = discovery("0.9.0");
  await withUpdates(data, async (options) => {
    assert.equal(await publishedAndroidVersion(options), "0.9.0");
    data.release = discovery("0.10.0").release;
    assert.equal(await publishedAndroidVersion(options), "0.10.0");
  });
});

test("the compatibility floor cannot substitute for an available release", async () => {
  const data = discovery();
  data.minimumSupportedVersion = "0.11.0";
  await withUpdates(data, async (options) =>
    assert.equal(await publishedAndroidVersion(options), "0.10.0"),
  );
});

test("the CI command prints only the released version", async () => {
  await withUpdates(discovery(), async (options) => {
    const result = await cli(options);
    assert.equal(result.stdout, "0.10.0\n");
    assert.equal(result.stderr, "");
  });
});

test("missing discovery or unavailable R2 publication leaves the CI version unset", async () => {
  for (const body of [undefined, { httpStatus: 503 }]) {
    await withUpdates(body, async (options) => {
      const result = await cli(options);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /No Android release is available/u);
    });
  }
});

test("failed, redirected or malformed discovery cannot prove availability", async () => {
  for (const body of [
    { httpStatus: 403 },
    { httpStatus: 500 },
    { httpStatus: 302, location: "/api/android/updates" },
    "not json",
  ]) {
    await withUpdates(body, async (options) => {
      const result = await cli(options);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Published Android version unavailable/u);
    });
  }
});

test("invalid release versions cannot prove a floor", async () => {
  for (const version of [
    null,
    "development",
    "0.10",
    "0.10.0-beta",
    "0.10.0\n",
    "1".repeat(65) + ".0.0",
  ]) {
    await withUpdates(discovery(version), async (options) => {
      await assert.rejects(
        publishedAndroidVersion(options),
        /no stable release version/u,
      );
    });
  }
});

test("bounds discovery bytes while accepting canonical supplementary Unicode notes", async () => {
  const data = discovery();
  data.release.notes = "🚀".repeat(8_000);
  await withUpdates(data, async (options) => {
    assert.equal(await publishedAndroidVersion(options), "0.10.0");
    data.release.notes = "a".repeat(65_536);
    await assert.rejects(
      publishedAndroidVersion(options),
      /exceeds its limit/u,
    );
  });
});

test("public discovery requires HTTPS outside the local fixture", async () => {
  await assert.rejects(
    publishedAndroidVersion({
      updatesUrl: "http://example.com/api/android/updates",
    }),
    /HTTPS/u,
  );
});
