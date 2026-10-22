const assert = require("node:assert/strict");
const { test } = require("node:test");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  packSecrets,
  parseEnvironment,
  request,
  command,
  sharedPreviewDatabase,
  main,
} = require("./api-worker-preview.cjs");

test("Worker consumes the exact prepared shared branch through a direct GET-only connection", async () => {
  const branch = {
    id: "br-shared-preview",
    name: "preview/pr-123",
    current_state: "ready",
  };
  const requests = [];
  const database = await sharedPreviewDatabase(async (method, route) => {
    requests.push([method, route]);
    assert.equal(method, "GET");
    if (route.startsWith("/branches?"))
      return {
        branches: [
          { ...branch, id: "br-unrelated", name: "preview/pr-123-other" },
          branch,
        ],
      };
    if (route === `/branches/${branch.id}`) return { branch };
    assert.equal(
      route,
      "/connection_uri?branch_id=br-shared-preview&database_name=neondb&role_name=neondb_owner&pooled=false",
    );
    return {
      uri: "postgresql://preview:password@ep-shared.example.neon.tech/neondb",
    };
  }, branch.name);
  assert.equal(database.hostname, "ep-shared.example.neon.tech");
  assert.equal(database.searchParams.get("sslmode"), "verify-full");
  assert.equal(requests[0][1], "/branches?search=preview%2Fpr-123&limit=100");
});

test("a missing shared branch fails instead of allocating another Neon branch", async () => {
  const requests = [];
  await assert.rejects(
    sharedPreviewDatabase(async (method, route) => {
      requests.push([method, route]);
      return { branches: [] };
    }, "preview/pr-123"),
    /Expected one existing shared API preview branch/,
  );
  assert.deepEqual(requests, [
    ["GET", "/branches?search=preview%2Fpr-123&limit=100"],
  ]);
});

function operationEnvironment(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("closed-PR Worker cleanup deletes only its Worker and Hyperdrive without Neon credentials", async (t) => {
  operationEnvironment(t, {
    JOB_REF: "pr-123",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-token",
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/repository",
    NEON_API_KEY: undefined,
    NEON_PROJECT_ID: undefined,
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const pathname = new URL(url).pathname;
    requests.push([options.method, pathname]);
    if (url.startsWith("https://api.github.com/"))
      return Response.json({ state: "closed" });
    assert.equal(new URL(url).hostname, "api.cloudflare.com");
    return Response.json({
      success: true,
      result:
        options.method === "GET"
          ? [{ name: "okou-api-preview-pr-123", id: "b".repeat(32) }]
          : null,
    });
  });
  await main("cleanup");
  assert.deepEqual(
    requests.filter(([method]) => method === "DELETE"),
    [
      [
        "DELETE",
        `/client/v4/accounts/${"a".repeat(32)}/workers/scripts/okou-api-preview-pr-123`,
      ],
      [
        "DELETE",
        `/client/v4/accounts/${"a".repeat(32)}/hyperdrive/configs/${"b".repeat(32)}`,
      ],
    ],
  );
});

test("a superseded PR revision is rejected before database or Cloudflare operations", async (t) => {
  operationEnvironment(t, {
    JOB_REF: "pr-123",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-token",
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/repository",
    EXPECTED_PR_HEAD_SHA: "1".repeat(40),
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(
      url,
      "https://api.github.com/repos/example/repository/pulls/123",
    );
    return Response.json({
      state: "open",
      head: { sha: "2".repeat(40), repo: { full_name: "example/repository" } },
    });
  });
  await assert.rejects(main("deploy"), /Superseded PR revision/);
});

test("downstream deployment binds the existing branch and runs only build and Worker upload", async (t) => {
  const root = path.resolve(__dirname, "../..");
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "shared-worker-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, "runtime.env");
  fs.writeFileSync(envFile, "ENV=preview\n", { mode: 0o600 });
  operationEnvironment(t, {
    JOB_REF: "pr-123",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-token",
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: "example/repository",
    EXPECTED_PR_HEAD_SHA: "1".repeat(40),
    NEON_API_KEY: "test-token",
    NEON_PROJECT_ID: "test-project",
    API_ENV_FILE: envFile,
    CF_API_TRACES_DESTINATION: undefined,
  });
  const branch = {
    id: "br-shared-preview",
    name: "preview/pr-123",
    current_state: "ready",
  };
  const hyperdrive = {
    id: "b".repeat(32),
    name: "okou-api-preview-pr-123",
    caching: { disabled: true },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const u = new URL(url);
    if (u.hostname === "api.github.com")
      return Response.json({
        state: "open",
        head: {
          sha: "1".repeat(40),
          repo: { full_name: "example/repository" },
        },
      });
    if (u.hostname === "console.neon.tech") {
      assert.equal(options.method, "GET");
      if (u.pathname.endsWith("/connection_uri")) {
        assert.equal(u.searchParams.get("branch_id"), branch.id);
        assert.equal(u.searchParams.get("pooled"), "false");
        return Response.json({
          uri: "postgresql://preview:password@ep-shared.example.neon.tech/neondb",
        });
      }
      if (u.pathname.endsWith(`/branches/${branch.id}`))
        return Response.json({ branch });
      assert.equal(u.searchParams.get("search"), branch.name);
      return Response.json({ branches: [branch] });
    }
    assert.equal(u.hostname, "api.cloudflare.com");
    if (options.method === "GET")
      return Response.json({ success: true, result: [hyperdrive] });
    assert.equal(options.method, "PUT");
    const body = JSON.parse(options.body);
    assert.equal(body.origin.host, "ep-shared.example.neon.tech");
    assert.equal(body.caching.disabled, true);
    return Response.json({ success: true, result: hyperdrive });
  });
  const commands = [];
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    if (args.includes("build:worker")) commands.push("build");
    else {
      assert.ok(args.includes("deploy"));
      const config = JSON.parse(
        fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"),
      );
      assert.deepEqual(config.hyperdrive, [
        { binding: "HYPERDRIVE", id: hyperdrive.id },
      ]);
      const secretsFile = args[args.indexOf("--secrets-file") + 1];
      assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
      const secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
      const runtime = JSON.parse(
        Array.from(
          { length: Number(secrets.API_ENV_JSON_PARTS) },
          (_, i) => secrets[`API_ENV_JSON_${i}`],
        ).join(""),
      );
      assert.equal(
        new URL(runtime.DATABASE_URL).hostname,
        "ep-shared.example.neon.tech",
      );
      commands.push("upload");
    }
    return { status: 0 };
  });
  await main("deploy");
  assert.deepEqual(commands, ["build", "upload"]);
});

test("encrypted environment chunks preserve multibyte values and stay below the per-secret limit", () => {
  const runtime = { ENV: "preview", KEY: "🔐中".repeat(3000), EMPTY: "" };
  const secrets = packSecrets(runtime);
  const count = Number(secrets.API_ENV_JSON_PARTS);
  assert.ok(count > 1);
  const joined = Array.from({ length: count }, (_, index) => {
    const part = secrets[`API_ENV_JSON_${index}`];
    assert.ok(Buffer.byteLength(part) <= 4096);
    return part;
  }).join("");
  assert.deepEqual(JSON.parse(joined), runtime);
  // Simulate retained old Cloudflare secrets after the runtime shrinks.
  Object.assign(secrets, packSecrets({ ENV: "preview" }));
  assert.equal(secrets.API_ENV_JSON_PARTS, "1");
  assert.deepEqual(JSON.parse(secrets.API_ENV_JSON_0), { ENV: "preview" });
});

test("resolver literal environment records preserve multiline credentials and equals signs", () => {
  const values = parseEnvironment(
    "ENV=preview\nPRIVATE_KEY=-----BEGIN KEY-----\nsecret==\n-----END KEY-----\nTOKEN=a=b=c\nEMPTY=\n",
  );
  assert.deepEqual(values, {
    ENV: "preview",
    PRIVATE_KEY: "-----BEGIN KEY-----\nsecret==\n-----END KEY-----",
    TOKEN: "a=b=c",
    EMPTY: "",
  });
});

test("deployment failures expose numeric diagnostics without printing credentials or provider messages", (t) => {
  const secret = "postgres://secret:password@database";
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 1,
    stdout: Buffer.from(`runtime configuration: ${secret}`),
    stderr: Buffer.from(
      `Uncaught TypeError: ${secret}\n at worker.js:12:345 [code: 10021]\nAuthorization: Bearer secret-value`,
    ),
  }));
  assert.throws(
    () => command("Deploy API Worker preview", [], {}, process.cwd()),
    (error) => {
      assert.equal(
        error.message,
        "Deploy API Worker preview failed (Cloudflare code 10021; startup TypeError; worker.js:12:345) (output withheld to protect credentials)",
      );
      return true;
    },
  );
});

test("control-plane failures never expose provider response bodies or native credential-bearing errors", async (t) => {
  const secret = "postgres://secret:password@database";
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(secret, { status: 400 }),
  );
  await assert.rejects(
    request(
      "https://example.invalid",
      secret,
      "POST",
      `/configs?token=${secret}`,
      {
        password: secret,
      },
    ),
    (error) =>
      !error.message.includes(secret) &&
      error.message.includes("example.invalid POST /configs") &&
      error.message.includes("HTTP 400"),
  );
  globalThis.fetch = async () => {
    throw new globalThis.Error(secret);
  };
  await assert.rejects(
    request("https://example.invalid", secret, "POST", "/configs"),
    (error) =>
      !error.message.includes(secret) && error.message.includes("not retried"),
  );
});
