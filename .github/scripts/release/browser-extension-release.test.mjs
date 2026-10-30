import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
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
const authentication = resolve(
  import.meta.dirname,
  "browser-extension-variable-token.mjs",
);
const source = "1".repeat(40);
const version = "0.2.0";
const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const variable = "OKOU_BROWSER_USE_EXTENSION_ID";

async function run(t, script, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
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
    JSON.stringify({ manifest_version: 3, version }),
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
    writes: 0,
    current: oldId,
    uploadFailure: false,
    lostReply: false,
    variableFailure: false,
    superseded: false,
    missingVariable: false,
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
    if (url.pathname === "/api/v4/extensions") {
      state.uploads++;
      state.events.push("provider-upload");
      assert.equal(
        request.headers["x-browser-use-api-key"],
        "provider-fixture-key",
      );
      assert.ok(
        payload.includes(bytes),
        "the uploaded multipart includes the exact verified ZIP bytes",
      );
      if (state.lostReply) return response.destroy();
      return send({ id: newId }, state.uploadFailure ? 503 : 201);
    }
    if (
      url.pathname === `${prefix}/actions/variables/${variable}` &&
      request.method === "GET"
    )
      return send(
        { name: variable, value: state.current },
        state.missingVariable ? 404 : 200,
      );
    if (
      (url.pathname === `${prefix}/actions/variables/${variable}` &&
        request.method === "PATCH") ||
      (url.pathname === `${prefix}/actions/variables` &&
        request.method === "POST")
    ) {
      if (state.variableFailure) return send({}, 403);
      state.writes++;
      state.events.push("variable-update");
      state.current = JSON.parse(payload).value;
      state.missingVariable = false;
      return send({}, 204);
    }
    return send({ unhandled: `${request.method} ${url.pathname}` }, 404);
  });
  const env = {
    GITHUB_REPOSITORY: "okou-ai/okou",
    GITHUB_API_URL: api,
    BROWSER_USE_API_URL: api,
    GH_TOKEN: "contents-fixture-token",
    GITHUB_VARIABLES_TOKEN: "variables-fixture-token",
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
    async apiEnvironment({
      extensionReleased = true,
      configuredId = oldId,
    } = {}) {
      const step = readWorkflow().jobs["promote-api-production"].steps.find(
        (step) => step.id === "browser-extension-env",
      );
      const file = resolve(directory, "api-output");
      await writeFile(file, "");
      const child = spawn("bash", ["-c", step.run], {
        cwd: root,
        env: {
          ...process.env,
          GH_TOKEN: "",
          GITHUB_VARIABLES_TOKEN: "",
          REPO_VARS_JSON: JSON.stringify(
            { [variable]: configuredId, OTHER: "retained" },
            null,
            2,
          ),
          BROWSER_EXTENSION_RELEASE_CREATED: String(extensionReleased),
          BROWSER_EXTENSION_ID: extensionReleased
            ? (await readOutputs(output)).extension_id
            : "",
          GITHUB_OUTPUT: file,
        },
        signal: t.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const resolved = await completed(child);
      assert.equal(resolved.code, 0, resolved.stderr);
      return JSON.parse((await readOutputs(file)).json);
    },
  };
}

test("publication preserves artifact identity, replaces stale vars and reuses a completed upload", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  const outputs = await f.outputs();
  assert.equal(outputs.extension_id, newId);
  assert.deepEqual(await f.apiEnvironment(), {
    [variable]: newId,
    OTHER: "retained",
  });
  assert.deepEqual(f.state.events, [
    `browser-extension-${version}.zip`,
    `browser-extension-${version}.zip.sha256`,
    `browser-extension-${version}.zip.provenance.json`,
    "browser-extension-upload-attempt.json",
    "provider-upload",
    "browser-extension-upload.json",
    "variable-update",
  ]);
  assert.equal((await f.run()).code, 0);
  assert.equal(f.state.uploads, 1);
  assert.equal(f.state.writes, 1);
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
  assert.equal(f.state.writes, 1);
});

test("the first extension release creates the singular configuration Variable", async (t) => {
  const f = await fixture(t);
  f.state.missingVariable = true;
  assert.equal((await f.run()).code, 0);
  assert.equal(f.state.current, newId);
  assert.equal((await f.outputs()).extension_id, newId);
});

test("an uncertain provider upload is not replayed by a rerun", async (t) => {
  const f = await fixture(t);
  f.state.lostReply = true;
  assert.notEqual((await f.run()).code, 0);
  assert.deepEqual(await f.outputs(), {});
  const retried = await f.run();
  assert.notEqual(retried.code, 0);
  assert.match(retried.stderr, /no completion receipt/);
  assert.equal(f.state.uploads, 1);
  assert.equal(f.state.writes, 0);
});

test("provider rejection cannot publish configuration or deployment outputs", async (t) => {
  const f = await fixture(t);
  f.state.uploadFailure = true;
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.state.writes, 0);
  assert.deepEqual(await f.outputs(), {});
});

test("a failed Variable update blocks deployment and retries from its completed receipt", async (t) => {
  const f = await fixture(t);
  f.state.variableFailure = true;
  assert.notEqual((await f.run()).code, 0);
  assert.deepEqual(await f.outputs(), {});
  f.state.variableFailure = false;
  assert.equal((await f.run()).code, 0);
  assert.equal(f.state.uploads, 1);
  assert.equal((await f.outputs()).extension_id, newId);
});

test("a superseded release cannot overwrite newer configuration", async (t) => {
  const f = await fixture(t);
  f.state.superseded = true;
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.state.uploads, 0);
  assert.equal(f.state.writes, 0);
});

test("artifact tampering is rejected before publication", async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, "different bytes");
  assert.notEqual((await f.run()).code, 0);
  assert.equal(f.state.uploads, 0);
  assert.equal(f.state.writes, 0);
});

test("an API-only release preserves its required configuration without publication credentials", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.apiEnvironment({ extensionReleased: false, configuredId: newId }),
    { [variable]: newId, OTHER: "retained" },
  );
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
    renderer.env.REPO_VARS_JSON,
    "${{ steps.browser-extension-env.outputs.json }}",
  );
  const variables = job.steps.find(
    (step) => step.id === "browser-extension-env",
  );
  assert.equal(
    variables.env.BROWSER_EXTENSION_ID,
    "${{ needs.publish-browser-extension.outputs.extension_id }}",
  );
});

test("the CI App token is scoped to this repository's Variables and is revoked", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "extension-app-token-"));
  t.after(() => {
    return rm(directory, { recursive: true, force: true });
  });
  const output = resolve(directory, "output");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  let scope,
    revoked = false;
  const api = await serve(t, async (request, response) => {
    if (request.url === "/installation/token") {
      assert.equal(request.method, "DELETE");
      assert.equal(
        request.headers.authorization,
        "Bearer fixture-installation-token",
      );
      revoked = true;
      return response.writeHead(204).end();
    }
    const jwt = request.headers.authorization
      .slice("Bearer ".length)
      .split(".");
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(jwt.slice(0, 2).join(".")),
        publicKey,
        Buffer.from(jwt[2], "base64url"),
      ),
    );
    const claims = JSON.parse(Buffer.from(jwt[1], "base64url"));
    assert.equal(claims.iss, "99");
    assert.equal(claims.exp - claims.iat, 600);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET")
      return response.end(JSON.stringify({ id: 7 }));
    scope = JSON.parse(await body(request));
    return response.end(
      JSON.stringify({
        token: "fixture-installation-token",
        permissions: { variables: "write" },
      }),
    );
  });
  const env = {
    GITHUB_API_URL: api,
    GITHUB_REPOSITORY: "okou-ai/okou",
    GITHUB_REPOSITORY_ID: "42",
    OKOU_CI_APP_ID: "99",
    OKOU_CI_APP_PRIVATE_KEY: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .replaceAll("\n", "\\n"),
    GITHUB_OUTPUT: output,
  };
  const created = await run(t, authentication, env);
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(scope, {
    repository_ids: [42],
    permissions: { variables: "write" },
  });
  assert.equal(created.stdout.trim(), "::add-mask::fixture-installation-token");
  assert.equal(
    await readFile(output, "utf8"),
    "token=fixture-installation-token\n",
  );
  assert.equal(
    (
      await run(
        t,
        authentication,
        { ...env, GITHUB_VARIABLES_TOKEN: "fixture-installation-token" },
        ["--revoke"],
      )
    ).code,
    0,
  );
  assert.equal(revoked, true);
});
