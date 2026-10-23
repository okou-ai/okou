const assert = require("node:assert/strict");
const { test, before, after, afterEach } = require("node:test");
const { createRequire } = require("node:module");
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

// .github is outside the pnpm workspace. Resolve the API's existing MSW
// dependency from its owning package, independent of the invocation directory.
const requireApi = createRequire(
  path.resolve(__dirname, "../../turbo/apps/api/package.json"),
);
const { http, HttpResponse } = requireApi("msw");
const { setupServer } = requireApi("msw/node");
const server = setupServer();
const boundaryErrors = [];
before(() => {
  server.events.on("unhandledException", ({ error }) =>
    boundaryErrors.push(error),
  );
  server.listen({
    onUnhandledRequest(incoming) {
      const error = new Error(`Unhandled ${incoming.method} ${incoming.url}`);
      boundaryErrors.push(error);
      throw error; // The installed MSW print.error() only logs; reject explicitly.
    },
  });
});
afterEach(() => {
  server.resetHandlers();
  // The production adapter sanitizes fetch failures. They must not hide a
  // missing handler or a failed assertion inside an MSW response resolver.
  assert.deepEqual(boundaryErrors.splice(0), []);
});
after(() => server.close());
const neonBase = "https://console.neon.tech/api/v2/projects/test-project";
const cfBase = `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}`;
const prUrl = "https://api.github.com/repos/example/repository/pulls/123";
const neon = (method, route) => request(neonBase, "test-token", method, route);

test("Worker consumes the exact prepared shared branch through a direct GET-only connection", async () => {
  const branch = {
    id: "br-shared-preview",
    name: "preview/pr-123",
    current_state: "ready",
  };
  const requests = [];
  server.use(
    http.get(`${neonBase}/branches`, ({ request: incoming }) => {
      const url = new URL(incoming.url);
      requests.push([incoming.method, `/branches${url.search}`]);
      assert.equal(url.searchParams.get("search"), branch.name);
      assert.equal(url.searchParams.get("limit"), "100");
      return HttpResponse.json({
        branches: [
          { ...branch, id: "br-unrelated", name: "preview/pr-123-other" },
          branch,
        ],
      });
    }),
    http.get(`${neonBase}/branches/${branch.id}`, () =>
      HttpResponse.json({ branch }),
    ),
    http.get(`${neonBase}/connection_uri`, ({ request: incoming }) => {
      assert.deepEqual(Object.fromEntries(new URL(incoming.url).searchParams), {
        branch_id: branch.id,
        database_name: "neondb",
        role_name: "neondb_owner",
        pooled: "false",
      });
      return HttpResponse.json({
        uri: "postgresql://preview:password@ep-shared.example.neon.tech/neondb",
      });
    }),
  );
  const database = await sharedPreviewDatabase(neon, branch.name);
  assert.equal(database.hostname, "ep-shared.example.neon.tech");
  assert.equal(database.searchParams.get("sslmode"), "verify-full");
  assert.equal(requests[0][1], "/branches?search=preview%2Fpr-123&limit=100");
});

test("a missing shared branch fails instead of allocating another Neon branch", async () => {
  const requests = [];
  server.use(
    http.get(`${neonBase}/branches`, ({ request: incoming }) => {
      const url = new URL(incoming.url);
      requests.push([incoming.method, `/branches${url.search}`]);
      return HttpResponse.json({ branches: [] });
    }),
  );
  await assert.rejects(
    sharedPreviewDatabase(neon, "preview/pr-123"),
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
  server.use(
    http.get(prUrl, () => HttpResponse.json({ state: "closed" })),
    http.get(`${cfBase}/hyperdrive/configs`, () =>
      HttpResponse.json({
        success: true,
        result: [{ name: "okou-api-preview-pr-123", id: "b".repeat(32) }],
      }),
    ),
    ...[
      `${cfBase}/workers/scripts/okou-api-preview-pr-123`,
      `${cfBase}/hyperdrive/configs/${"b".repeat(32)}`,
    ].map((url) =>
      http.delete(url, ({ request: incoming }) => {
        assert.equal(
          incoming.headers.get("authorization"),
          "Bearer test-token",
        );
        requests.push([incoming.method, new URL(incoming.url).pathname]);
        return HttpResponse.json({ success: true, result: null });
      }),
    ),
  );
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
  server.use(
    http.get(prUrl, () =>
      HttpResponse.json({
        state: "open",
        head: {
          sha: "2".repeat(40),
          repo: { full_name: "example/repository" },
        },
      }),
    ),
  );
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
  server.use(
    http.get(prUrl, () =>
      HttpResponse.json({
        state: "open",
        head: {
          sha: "1".repeat(40),
          repo: { full_name: "example/repository" },
        },
      }),
    ),
    http.get(`${neonBase}/branches`, ({ request: incoming }) => {
      assert.equal(
        new URL(incoming.url).searchParams.get("search"),
        branch.name,
      );
      return HttpResponse.json({ branches: [branch] });
    }),
    http.get(`${neonBase}/branches/${branch.id}`, () =>
      HttpResponse.json({ branch }),
    ),
    http.get(`${neonBase}/connection_uri`, ({ request: incoming }) => {
      const params = new URL(incoming.url).searchParams;
      assert.equal(params.get("branch_id"), branch.id);
      assert.equal(params.get("pooled"), "false");
      return HttpResponse.json({
        uri: "postgresql://preview:password@ep-shared.example.neon.tech/neondb",
      });
    }),
    http.get(`${cfBase}/hyperdrive/configs`, () =>
      HttpResponse.json({
        success: true,
        result: [hyperdrive],
      }),
    ),
    http.put(
      `${cfBase}/hyperdrive/configs/${hyperdrive.id}`,
      async ({ request: incoming }) => {
        assert.equal(
          incoming.headers.get("authorization"),
          "Bearer test-token",
        );
        const body = await incoming.json();
        assert.deepEqual(body, {
          name: hyperdrive.name,
          origin: {
            scheme: "postgres",
            host: "ep-shared.example.neon.tech",
            port: 5432,
            database: "neondb",
            user: "preview",
            password: "password",
          },
          caching: { disabled: true },
        });
        return HttpResponse.json({ success: true, result: hyperdrive });
      },
    ),
  );
  const commands = [];
  const output = [];
  t.mock.method(console, "log", (...values) => output.push(values.join(" ")));
  let generatedPath;
  let secretsPath;
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    if (args.includes("build:worker")) commands.push("build");
    else {
      assert.ok(args.includes("deploy"));
      generatedPath = args[args.indexOf("--config") + 1];
      assert.equal(fs.statSync(generatedPath).mode & 0o777, 0o600);
      const config = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
      assert.deepEqual(config.hyperdrive, [
        { binding: "HYPERDRIVE", id: hyperdrive.id },
      ]);
      secretsPath = args[args.indexOf("--secrets-file") + 1];
      assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);
      const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
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
      return {
        status: 0,
        stdout: Buffer.from(
          "Worker Startup Time: 612.5 ms\r\nruntime secret: private-value\n",
        ),
        stderr: Buffer.from("Authorization: Bearer private-value"),
      };
    }
    return { status: 0 };
  });
  await main("deploy");
  assert.deepEqual(commands, ["build", "upload"]);
  assert.deepEqual(
    output.filter((line) => line.startsWith("Worker Startup Time:")),
    ["Worker Startup Time: 612.5 ms"],
  );
  assert.ok(output.every((line) => !line.includes("private-value")));
  assert.equal(fs.existsSync(generatedPath), false);
  assert.equal(fs.existsSync(path.dirname(secretsPath)), false);
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
  const output = [];
  t.mock.method(console, "log", (...values) => output.push(values.join(" ")));
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 1,
    stdout: Buffer.from(
      `Worker Startup Time: 612.5 ms\nruntime configuration: ${secret}`,
    ),
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
  assert.deepEqual(output, ["Deploy API Worker preview"]);
});

test("successful commands leave absent or invalid startup measurements unavailable", (t) => {
  let stdout;
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout,
    stderr: Buffer.from("Worker Startup Time: 123 ms\n"),
  }));
  const output = [];
  t.mock.method(console, "log", (...values) => output.push(values.join(" ")));
  for (const value of [
    undefined,
    "",
    "Worker Startup Time: 12 ms secret-value\n",
    "Worker Startup Time: NaN ms\n",
    "Worker Startup Time: Infinity ms\n",
    "Worker Startup Time: -1 ms\n",
    `Worker Startup Time: ${"9".repeat(400)} ms\n`,
  ]) {
    stdout = value === undefined ? undefined : Buffer.from(value);
    assert.equal(
      command("Deploy API Worker preview", [], {}, process.cwd()),
      undefined,
    );
  }
  assert.ok(output.every((line) => line === "Deploy API Worker preview"));
});

test("startup CPU rejection retains its fixed classification without provider text or credentials", (t) => {
  const secret = "postgres://secret:password@database";
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 1,
    stdout: Buffer.from(`runtime configuration: ${secret}`),
    stderr: Buffer.from(
      `Script startup exceeded CPU time limit. [code: 10021]\nAuthorization: Bearer ${secret}`,
    ),
  }));
  assert.throws(
    () => command("Deploy API Worker preview", [], {}, process.cwd()),
    (error) => {
      assert.equal(
        error.message,
        "Deploy API Worker preview failed (Cloudflare code 10021; Worker startup time limit exceeded) (output withheld to protect credentials)",
      );
      return true;
    },
  );
});

test("control-plane failures withhold credentials and never replay uncertain requests", async () => {
  const secret = "postgres://secret:password@database";
  server.use(
    http.post(
      "https://api.cloudflare.com/client/v4/configs",
      async ({ request: incoming }) => {
        assert.equal(incoming.headers.get("authorization"), `Bearer ${secret}`);
        assert.equal(new URL(incoming.url).searchParams.get("token"), secret);
        assert.deepEqual(await incoming.json(), { password: secret });
        return new HttpResponse(secret, { status: 400 });
      },
    ),
  );
  await assert.rejects(
    request(
      "https://api.cloudflare.com/client/v4",
      secret,
      "POST",
      `/configs?token=${secret}`,
      {
        password: secret,
      },
    ),
    (error) =>
      !error.message.includes(secret) &&
      error.message.includes("api.cloudflare.com POST /configs") &&
      error.message.includes("HTTP 400"),
  );
  let attempts = 0;
  server.use(
    http.post("https://api.cloudflare.com/client/v4/configs", () => {
      attempts += 1;
      return HttpResponse.error();
    }),
  );
  await assert.rejects(
    request("https://api.cloudflare.com/client/v4", secret, "POST", "/configs"),
    (error) =>
      !error.message.includes(secret) && error.message.includes("not retried"),
  );
  assert.equal(attempts, 1);
});
