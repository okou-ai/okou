import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
const publication = resolve(
  import.meta.dirname,
  "publish-browser-extension.mjs",
);
const resolution = resolve(
  import.meta.dirname,
  "resolve-browser-extension.mjs",
);
const source = "1".repeat(40);
const version = "0.2.0";
const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";

function extension(version, id = randomUUID()) {
  return { id, name: "Okou Browser", version };
}

async function run(t, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    signal: t.signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return completed(child);
}

function completed(child) {
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function serve(t, handler) {
  const server = createServer(async (request, response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.writeHead(500).end();
      t.diagnostic(String(error));
    }
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readOutputs(file) {
  return Object.fromEntries(
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function readWorkflow() {
  return JSON.parse(
    execFileSync(
      "yq",
      ["-o=json", ".", ".github/workflows/release-please.yml"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  );
}

async function fixture(t) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "browser-extension-release-"),
  );
  t.after(() => {
    return rm(directory, { recursive: true, force: true });
  });
  const artifacts = resolve(directory, "artifacts");
  await mkdir(artifacts);
  await writeFile(
    resolve(directory, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name: "Okou Browser", version }),
  );
  await writeFile(
    resolve(directory, "background.js"),
    "globalThis.fixture = true;\n",
  );
  const name = `browser-extension-${version}.zip`;
  const archive = resolve(artifacts, name);
  execFileSync("zip", ["-q", "-j", archive, "manifest.json", "background.js"], {
    cwd: directory,
  });
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}\n`);
  await writeFile(
    `${archive}.provenance.json`,
    JSON.stringify({
      extension: "browser-extension",
      sourceCommit: source,
      version,
      sha256,
      dirty: false,
    }),
  );
  const output = resolve(directory, "output");
  const state = {
    assets: [],
    contents: new Map(),
    uploads: 0,
    uploadFailure: false,
    lostReply: false,
    superseded: false,
    extensions: [{ id: oldId, name: "Okou Browser", version: "0.1.0" }],
    lookupFailure: false,
    listRequests: [],
    uploadedVersion: version,
    deletions: [],
    deleteFailureId: null,
    lostDeleteReplyId: null,
    missingOnDeleteId: null,
    invalidPage: 0,
    invalidRegistryJson: false,
    events: [],
  };
  let api;
  api = await serve(t, async (request, response) => {
    const url = new URL(request.url, api);
    const payload = await body(request);
    const send = (value, status = 200) => {
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    };
    const prefix = "/repos/okou-ai/okou";
    if (
      url.pathname === `${prefix}/releases/tags/browser-extension-v${version}`
    ) {
      return send({
        id: 1,
        draft: false,
        assets: state.assets,
        upload_url: `${api}/upload{?name}`,
      });
    }
    if (url.pathname === `${prefix}/commits/browser-extension-v${version}`)
      return send({ sha: source });
    if (
      url.pathname === `${prefix}/git/matching-refs/tags/browser-extension-v`
    ) {
      return send([
        {
          ref: `refs/tags/browser-extension-v${state.superseded ? "0.3.0" : version}`,
        },
      ]);
    }
    if (url.pathname.startsWith(`${prefix}/releases/assets/`))
      return response
        .writeHead(200, { "content-type": "application/octet-stream" })
        .end(state.contents.get(Number(url.pathname.split("/").at(-1))));
    if (url.pathname === "/upload") {
      const name = url.searchParams.get("name");
      const id = state.assets.length + 1;
      state.assets.push({ id, name });
      state.contents.set(id, payload);
      state.events.push(name);
      return send({ id }, 201);
    }
    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/api/v4/extensions/")
    ) {
      assert.equal(
        request.headers["x-browser-use-api-key"],
        "provider-fixture-key",
      );
      assert.ok(
        state.assets.some(
          (asset) => asset.name === "browser-extension-upload.json",
        ),
        "cleanup requires a saved upload completion receipt",
      );
      const id = url.pathname.split("/").at(-1);
      state.deletions.push(id);
      if (id === state.deleteFailureId)
        return send({ detail: "unavailable" }, 503);
      const index = state.extensions.findIndex((item) => item.id === id);
      if (index === -1) return send({ detail: "not found" }, 404);
      state.extensions.splice(index, 1);
      if (id === state.lostDeleteReplyId) return response.destroy();
      if (id === state.missingOnDeleteId)
        return send({ detail: "not found" }, 404);
      return response.writeHead(204).end();
    }
    if (url.pathname === "/api/v4/extensions") {
      assert.equal(
        request.headers["x-browser-use-api-key"],
        "provider-fixture-key",
      );
      if (request.method === "GET") {
        const pageNumber = Number(url.searchParams.get("pageNumber"));
        const pageSize = Number(url.searchParams.get("pageSize"));
        state.listRequests.push(pageNumber);
        if (state.invalidRegistryJson)
          return response
            .writeHead(200)
            .end("provider-fixture-key: invalid JSON");
        return send(
          {
            items: state.extensions.slice(
              (pageNumber - 1) * pageSize,
              pageNumber * pageSize,
            ),
            totalItems: state.extensions.length,
            pageNumber: state.invalidPage === pageNumber ? 0 : pageNumber,
            pageSize,
          },
          state.lookupFailure ? 503 : 200,
        );
      }
      state.uploads++;
      state.events.push("provider-upload");
      assert.ok(
        payload.includes(bytes),
        "the uploaded multipart includes the exact verified ZIP bytes",
      );
      if (!state.uploadFailure)
        state.extensions.push(extension(state.uploadedVersion, newId));
      if (state.lostReply) return response.destroy();
      return send(
        { id: newId, name: "Okou Browser", version: state.uploadedVersion },
        state.uploadFailure ? 503 : 201,
      );
    }
    return send({ unhandled: `${request.method} ${url.pathname}` }, 404);
  });
  const env = {
    GITHUB_REPOSITORY: "okou-ai/okou",
    GITHUB_API_URL: api,
    BROWSER_USE_API_URL: api,
    GH_TOKEN: "contents-fixture-token",
    OKOU_BROWSER_USE_API_KEY: "provider-fixture-key",
    RELEASE_TARGET: source,
    BROWSER_EXTENSION_VERSION: version,
    BROWSER_EXTENSION_TAG: `browser-extension-v${version}`,
    EXTENSION_ARTIFACT_DIR: artifacts,
    GITHUB_OUTPUT: output,
  };
  return {
    state,
    archive,
    output,
    async run() {
      await writeFile(output, "");
      return run(t, publication, env);
    },
    async outputs() {
      return readOutputs(output);
    },
    async resolve({ extensionReleased = false, publishedId = "" } = {}) {
      return run(t, resolution, {
        BROWSER_USE_API_URL: api,
        OKOU_BROWSER_USE_API_KEY: "provider-fixture-key",
        BROWSER_EXTENSION_RELEASE_CREATED: String(extensionReleased),
        BROWSER_EXTENSION_ID: publishedId,
      });
    },
  };
}

test("publication preserves artifact identity and reuses a completed upload", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  const outputs = await f.outputs();
  assert.equal(outputs.extension_id, newId);
  assert.deepEqual(f.state.events, [
    `browser-extension-${version}.zip`,
    `browser-extension-${version}.zip.sha256`,
    `browser-extension-${version}.zip.provenance.json`,
    "browser-extension-upload-attempt.json",
    "provider-upload",
    "browser-extension-upload.json",
  ]);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.state.uploads, 1);
  assert.deepEqual(
    new Set(f.state.extensions.map((item) => item.id)),
    new Set([oldId, newId]),
  );
  assert.deepEqual(f.state.deletions, []);
});

test("publication retains the newest five numeric versions across all pages and leaves other extensions intact", async (t) => {
  const f = await fixture(t);
  const previous = [
    "0.1.9",
    "0.1.10",
    "0.1.11",
    "0.1.12",
    "0.1.13",
    "0.1.0",
  ].map((value) => extension(value));
  const others = Array.from({ length: 99 }, () => ({
    id: randomUUID(),
    name: "Other extension",
    version: "99.0.0",
  }));
  f.state.extensions = [previous[0], ...others, ...previous.slice(1)];
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.outputs()).extension_id, newId);
  assert.deepEqual(f.state.listRequests, [1, 2]);
  assert.deepEqual(
    new Set(
      f.state.extensions
        .filter((item) => item.name === "Okou Browser")
        .map((item) => item.version),
    ),
    new Set([version, "0.1.13", "0.1.12", "0.1.11", "0.1.10"]),
  );
  assert.deepEqual(
    f.state.extensions.filter((item) => item.name !== "Okou Browser"),
    others,
  );
});

test("cleanup failures preserve the upload receipt and resume without another upload", async (t) => {
  const f = await fixture(t);
  const previous = [
    "0.1.13",
    "0.1.12",
    "0.1.11",
    "0.1.10",
    "0.1.9",
    "0.1.8",
  ].map((value) => extension(value));
  f.state.extensions = [...previous];
  f.state.deleteFailureId = previous[5].id;
  const failed = await f.run();
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /cleanup failed \(503\)/);
  assert.deepEqual(await f.outputs(), {});
  assert.deepEqual(f.state.deletions, [previous[4].id, previous[5].id]);
  assert.ok(
    f.state.assets.some(
      (asset) => asset.name === "browser-extension-upload.json",
    ),
  );
  f.state.deleteFailureId = null;
  const resumed = await f.run();
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(f.state.uploads, 1);
  assert.equal((await f.outputs()).extension_id, newId);
  assert.deepEqual(f.state.deletions, [
    previous[4].id,
    previous[5].id,
    previous[5].id,
  ]);
  assert.deepEqual(
    new Set(f.state.extensions.map((item) => item.id)),
    new Set([newId, ...previous.slice(0, 4).map((item) => item.id)]),
  );
});

test("a lost deletion reply is reconciled from the registry before cleanup resumes", async (t) => {
  const f = await fixture(t);
  const previous = ["0.1.6", "0.1.5", "0.1.4", "0.1.3", "0.1.2", "0.1.1"].map(
    (value) => extension(value),
  );
  f.state.extensions = [...previous];
  f.state.lostDeleteReplyId = previous[4].id;
  assert.notEqual((await f.run()).code, 0);
  assert.deepEqual(await f.outputs(), {});
  const resumed = await f.run();
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(f.state.uploads, 1);
  assert.deepEqual(f.state.deletions, [previous[4].id, previous[5].id]);
  assert.deepEqual(
    new Set(f.state.extensions.map((item) => item.id)),
    new Set([newId, ...previous.slice(0, 4).map((item) => item.id)]),
  );
});

test("an already removed cleanup candidate does not block publication", async (t) => {
  const f = await fixture(t);
  const previous = ["0.1.5", "0.1.4", "0.1.3", "0.1.2", "0.1.1"].map((value) =>
    extension(value),
  );
  f.state.extensions = [...previous];
  f.state.missingOnDeleteId = previous[4].id;
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.outputs()).extension_id, newId);
  assert.deepEqual(
    new Set(f.state.extensions.map((item) => item.id)),
    new Set([newId, ...previous.slice(0, 4).map((item) => item.id)]),
  );
});

test("an invalid later registry page prevents all deletion and can be retried with the same upload", async (t) => {
  const f = await fixture(t);
  const previous = ["0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"].map((value) =>
    extension(value),
  );
  f.state.extensions = [
    ...previous,
    ...Array.from({ length: 99 }, () => ({
      id: randomUUID(),
      name: "Other extension",
      version: "1.0.0",
    })),
  ];
  f.state.invalidPage = 2;
  const failed = await f.run();
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /inconsistent extension pagination/);
  assert.deepEqual(f.state.deletions, []);
  assert.deepEqual(await f.outputs(), {});
  f.state.invalidPage = 0;
  const resumed = await f.run();
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(f.state.uploads, 1);
  assert.equal(
    f.state.extensions.filter((item) => item.name === "Okou Browser").length,
    5,
  );
});

test("unparseable registry replies fail with an owned diagnostic before cleanup", async (t) => {
  const f = await fixture(t);
  f.state.invalidRegistryJson = true;
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Browser Use returned invalid extension JSON/);
  assert.ok(!result.stderr.includes("provider-fixture-key"));
  assert.deepEqual(await f.outputs(), {});
  assert.deepEqual(f.state.deletions, []);
});

test("invalid or ambiguous matching versions prevent destructive cleanup", async (t) => {
  for (const invalid of [extension("not-a-version"), extension(version)]) {
    await t.test(invalid.version, async (t) => {
      const f = await fixture(t);
      f.state.extensions = [
        extension("0.1.1"),
        extension("0.1.2"),
        extension("0.1.3"),
        invalid,
      ];
      assert.notEqual((await f.run()).code, 0);
      assert.deepEqual(f.state.deletions, []);
      assert.deepEqual(await f.outputs(), {});
    });
  }
});

test("a publication outside the retained newest five cannot delete its selected upload", async (t) => {
  const f = await fixture(t);
  f.state.extensions = ["0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0"].map(
    (value) => extension(value),
  );
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not among the retained/);
  assert.deepEqual(f.state.deletions, []);
  assert.deepEqual(await f.outputs(), {});
  assert.ok(f.state.extensions.some((item) => item.id === newId));
});

test("published release artifacts are immutable and retain the exact uploaded ZIP", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  const archive = f.state.assets.find((asset) => asset.name.endsWith(".zip"));
  assert.deepEqual(f.state.contents.get(archive.id), await readFile(f.archive));
  f.state.contents.set(archive.id, Buffer.from("conflicting historical bytes"));
  const rerun = await f.run();
  assert.notEqual(rerun.code, 0);
  assert.match(rerun.stderr, /Conflicting release artifact/);
  assert.equal(f.state.uploads, 1);
});

test("an uncertain provider upload is not replayed by a rerun", async (t) => {
  const f = await fixture(t);
  f.state.extensions = ["0.1.1", "0.1.2", "0.1.3", "0.1.4"].map((value) =>
    extension(value),
  );
  f.state.lostReply = true;
  assert.notEqual((await f.run()).code, 0);
  assert.deepEqual(await f.outputs(), {});
  const retried = await f.run();
  assert.notEqual(retried.code, 0);
  assert.match(retried.stderr, /no completion receipt/);
  assert.equal(f.state.uploads, 1);
  assert.deepEqual(f.state.listRequests, []);
  assert.deepEqual(f.state.deletions, []);
});

test("provider rejection cannot publish deployment outputs", async (t) => {
  const f = await fixture(t);
  f.state.extensions = ["0.1.1", "0.1.2", "0.1.3", "0.1.4"].map((value) =>
    extension(value),
  );
  f.state.uploadFailure = true;
  assert.notEqual((await f.run()).code, 0);
  assert.deepEqual(await f.outputs(), {});
  assert.deepEqual(f.state.listRequests, []);
  assert.deepEqual(f.state.deletions, []);
});

test("a different uploaded version cannot become a verified publication output", async (t) => {
  const f = await fixture(t);
  f.state.uploadedVersion = "0.1.0";
  assert.notEqual((await f.run()).code, 0);
  assert.deepEqual(await f.outputs(), {});
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.state.uploads, 1);
});

test("a superseded release cannot upload older artifacts", async (t) => {
  const f = await fixture(t);
  f.state.superseded = true;
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.state.uploads, 0);
});

test("artifact tampering is rejected before publication", async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, "different bytes");
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.state.uploads, 0);
});

test("an extension release deploys its exact publication even when a higher version exists", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  f.state.extensions = [{ id: oldId, name: "Okou Browser", version: "9.0.0" }];
  const listRequests = [...f.state.listRequests];
  const resolved = await f.resolve({
    extensionReleased: true,
    publishedId: (await f.outputs()).extension_id,
  });
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), newId);
  assert.deepEqual(f.state.listRequests, listRequests);
});

test("a required publication output cannot be replaced by a registry lookup", async (t) => {
  const f = await fixture(t);
  for (const publishedId of ["", "invalid"]) {
    const resolved = await f.resolve({ extensionReleased: true, publishedId });
    assert.notEqual(resolved.code, 0);
    assert.equal(resolved.stdout, "");
    assert.match(resolved.stderr, /must provide a valid published ID/);
  }
});

test("an API-only deployment selects the highest numeric version across all pages", async (t) => {
  const f = await fixture(t);
  f.state.extensions = [
    { id: oldId, name: "Okou Browser", version: "0.9.0" },
    ...Array.from({ length: 99 }, () => ({
      id: randomUUID(),
      name: "Other extension",
      version: "99.0.0",
    })),
    { id: newId, name: "Okou Browser", version: "0.10.0" },
    { id: randomUUID(), name: "Okou Browser", version: "0.2.0" },
    { id: randomUUID(), name: "Okou Browser", version: "0.1.0" },
  ];
  const extensions = [...f.state.extensions];
  const resolved = await f.resolve({ publishedId: oldId });
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), newId);
  assert.deepEqual(f.state.listRequests, [1, 2]);
  assert.deepEqual(f.state.extensions, extensions);
  assert.deepEqual(f.state.deletions, []);
});

test("an absent or ambiguous highest matching version blocks deployment selection", async (t) => {
  const f = await fixture(t);
  for (const extensions of [
    [{ id: oldId, name: "Other extension", version: "1.0.0" }],
    [oldId, newId].map((id) => ({
      id,
      name: "Okou Browser",
      version: "1.0.0",
    })),
  ]) {
    f.state.extensions = extensions;
    const resolved = await f.resolve();
    assert.notEqual(resolved.code, 0);
    assert.equal(resolved.stdout, "");
  }
});

test("provider failures and invalid matching metadata cannot produce a deployment ID", async (t) => {
  const f = await fixture(t);
  f.state.lookupFailure = true;
  const failed = await f.resolve();
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /lookup failed \(503\)/);
  assert.equal(failed.stdout, "");
  f.state.lookupFailure = false;
  f.state.extensions = [
    { id: newId, name: "Okou Browser", version: "not-a-version" },
  ];
  const invalid = await f.resolve();
  assert.notEqual(invalid.code, 0);
  assert.equal(invalid.stdout, "");
});

test("the API production gate requires publication only when an extension is released", () => {
  const workflow = readWorkflow();
  const job = workflow.jobs["promote-api-production"];
  assert.ok(job.needs.includes("publish-browser-extension"));
  const selection = workflow.jobs["release-please"].outputs.api_deploy_required;
  for (const [extension, api, expected] of [
    [true, false, true],
    [true, true, true],
    [false, true, true],
    [false, false, false],
  ]) {
    const expression = selection
      .slice(3, -2)
      .replace(/steps\.release\.outputs\['([^']+)'\]/g, (_match, output) =>
        JSON.stringify(
          String(
            output === "turbo/apps/browser-extension--release_created"
              ? extension
              : output === "turbo/apps/api--release_created"
                ? api
                : false,
          ),
        ),
      );
    assert.equal(Function(`return (${expression});`)(), expected);
  }
  for (const released of [false, true]) {
    for (const extension of [false, true]) {
      const publication = workflow.jobs["publish-browser-extension"].if
        .slice(3, -2)
        .replaceAll(
          "needs.release-please.outputs.releases_created",
          JSON.stringify(String(released)),
        )
        .replaceAll(
          "needs.release-please.outputs.browser_extension_release_created",
          JSON.stringify(String(extension)),
        );
      assert.equal(
        Function(`return (${publication});`)(),
        released && extension,
      );
      for (const result of ["success", "failure", "cancelled", "skipped"]) {
        const condition = job.if
          .replaceAll("always()", "true")
          .replaceAll("failure()", String(result === "failure"))
          .replaceAll("cancelled()", String(result === "cancelled"))
          .replaceAll(
            "needs.publish-browser-extension.result",
            JSON.stringify(result),
          )
          .replaceAll(
            "needs.release-please.outputs.releases_created",
            JSON.stringify(String(released)),
          )
          .replaceAll(
            "needs.release-please.outputs.browser_extension_release_created",
            JSON.stringify(String(extension)),
          );
        const expected =
          released &&
          (result === "success" || (!extension && result === "skipped"));
        assert.equal(Function(`return (${condition});`)(), expected);
      }
    }
  }
  const renderer = job.steps.find((step) => {
    return step.id === "api-production-env";
  });
  assert.equal(
    renderer.with["browser-extension-id"],
    "${{ needs.publish-browser-extension.outputs.extension_id }}",
  );
  assert.equal(
    renderer.with["browser-extension-release-created"],
    "${{ needs.release-please.outputs.browser_extension_release_created == 'true' }}",
  );
});
