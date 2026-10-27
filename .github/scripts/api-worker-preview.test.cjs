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
  sharedDatabase,
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
  const database = await sharedDatabase(neon, branch.name);
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
    sharedDatabase(neon, "preview/pr-123"),
    /Expected one existing shared API database branch/,
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

test("closed-PR cleanup releases its Worker and Hyperdrive without managing shared exports", async (t) => {
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

function deploymentFixture(t, environment = {}, production = false) {
  const root = path.resolve(__dirname, "../..");
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "shared-worker-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envFile = path.join(directory, "runtime.env");
  fs.writeFileSync(
    envFile,
    `ENV=preview\nGIT_COMMIT_SHA=${"3".repeat(40)}\nAXIOM_DATASET_SUFFIX=dev\nAXIOM_TOKEN_TELEMETRY=\nPRIVATE_KEY=private-runtime-credential\nAPI_VALIDATED_ENV={"DATABASE_URL":"postgresql://pooled.example.neon.tech/neondb"}\n`,
    { mode: 0o600 },
  );
  const outputFile = path.join(directory, "outputs");
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
    CF_API_TRACES_DESTINATION: "okou-api-dev-traces",
    CF_API_LOGS_DESTINATION: "okou-api-dev-logs",
    CF_API_NATIVE_TELEMETRY: "true",
    GCP_MTLS_CERTIFICATE_ID: undefined,
    GCP_MTLS_CERTIFICATE_CHAIN: undefined,
    GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER: undefined,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: undefined,
    ...environment,
  });
  const branch = {
    id: production ? "br-shared-production" : "br-shared-preview",
    name: production ? "production" : "preview/pr-123",
    current_state: "ready",
  };
  const hyperdrive = {
    id: "b".repeat(32),
    name: production ? "okou-api-production" : "okou-api-preview-pr-123",
    caching: { disabled: true },
  };
  const databaseHost = production
    ? "ep-production.example.neon.tech"
    : "ep-shared.example.neon.tech";
  const databaseUser = production ? "production" : "preview";
  const mutations = [];
  server.use(
    http.get(`${cfBase}/workers/subdomain`, () =>
      HttpResponse.json({
        success: true,
        result: { subdomain: "test-account" },
      }),
    ),
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
        uri: `postgresql://${databaseUser}:password@${databaseHost}/neondb`,
      });
    }),
    http.get(`${cfBase}/hyperdrive/configs`, () =>
      HttpResponse.json({
        success: true,
        result: production ? [] : [hyperdrive],
      }),
    ),
    (production ? http.post : http.put)(
      `${cfBase}/hyperdrive/configs${production ? "" : `/${hyperdrive.id}`}`,
      async ({ request: incoming }) => {
        assert.equal(
          incoming.headers.get("authorization"),
          "Bearer test-token",
        );
        const body = await incoming.json();
        mutations.push([incoming.method, new URL(incoming.url).pathname]);
        assert.deepEqual(body, {
          name: hyperdrive.name,
          origin: {
            scheme: "postgres",
            host: databaseHost,
            port: 5432,
            database: "neondb",
            user: databaseUser,
            password: "password",
          },
          caching: { disabled: true },
        });
        return HttpResponse.json({ success: true, result: hyperdrive });
      },
    ),
  );
  return { hyperdrive, outputFile, envFile, mutations };
}

// Stand in for the API's env:validate, which owns the schema: it receives the
// final Worker runtime in a private file and appends the decoded record.
function validateEnvironment(args) {
  const file = args.at(-1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const runtime = parseEnvironment(fs.readFileSync(file, "utf8"));
  fs.appendFileSync(
    file,
    `API_VALIDATED_ENV=${JSON.stringify({ DATABASE_URL: runtime.DATABASE_URL })}\n`,
  );
  return { file, runtime };
}

test("native deployment binds preconfigured exports without requiring an Axiom destination credential", async (t) => {
  const { hyperdrive, outputFile } = deploymentFixture(t);
  const commands = [];
  let generatedPath;
  let secretsPath;
  let validatedFile;
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    if (args.includes("env:validate")) {
      validatedFile = validateEnvironment(args).file;
      commands.push("validate");
    } else if (args.includes("build:worker")) commands.push("build");
    else {
      assert.ok(args.includes("deploy"));
      generatedPath = args[args.indexOf("--config") + 1];
      assert.equal(fs.statSync(generatedPath).mode & 0o777, 0o600);
      const config = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
      assert.equal(config.vars.API_NATIVE_TELEMETRY, "true");
      for (const kind of ["logs", "traces"]) {
        assert.equal(config.observability[kind].head_sampling_rate, 1);
        assert.deepEqual(config.observability[kind].destinations, [
          `okou-api-dev-${kind}`,
        ]);
      }
      assert.equal(
        JSON.stringify(config).includes("private-runtime-credential"),
        false,
      );
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
      assert.equal(runtime.AXIOM_TOKEN_TELEMETRY, "");
      assert.equal(runtime.PRIVATE_KEY, "private-runtime-credential");
      assert.equal(
        new URL(runtime.DATABASE_URL).hostname,
        "ep-shared.example.neon.tech",
      );
      // The workflow's record predates the Worker's database override.
      assert.deepEqual(JSON.parse(runtime.API_VALIDATED_ENV), {
        DATABASE_URL: runtime.DATABASE_URL,
      });
      commands.push("upload");
    }
    return { status: 0 };
  });
  await main("deploy");
  assert.deepEqual(commands, ["validate", "build", "upload"]);
  assert.equal(
    fs.readFileSync(outputFile, "utf8"),
    `worker-url=https://okou-api-preview-pr-123.test-account.workers.dev\nsource-sha=${"3".repeat(40)}\n`,
  );
  assert.equal(fs.existsSync(generatedPath), false);
  assert.equal(fs.existsSync(path.dirname(secretsPath)), false);
  assert.equal(fs.existsSync(path.dirname(validatedFile)), false);
});

test("Worker deployment binds certificate federation while preserving the shared Vercel environment", async (t) => {
  const provider =
    "projects/123456789/locations/global/workloadIdentityPools/api-preview/providers/x509";
  const certificateChain = JSON.stringify(["bGVhZg==", "cm9vdA=="]);
  const { envFile } = deploymentFixture(t, {
    GCP_MTLS_CERTIFICATE_ID: "c".repeat(32),
    GCP_MTLS_CERTIFICATE_CHAIN: certificateChain,
    GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER: provider,
  });
  fs.appendFileSync(
    envFile,
    "GCP_LLM_PROJECT_ID=test-project\n" +
      "GCP_LLM_SERVICE_ACCOUNT_EMAIL=llm-dev@test-project.iam.gserviceaccount.com\n" +
      "GCP_LLM_WORKLOAD_IDENTITY_PROVIDER=projects/123456789/locations/global/workloadIdentityPools/vercel/providers/oidc\n",
  );
  const sharedEnvironment = fs.readFileSync(envFile, "utf8");
  let deployedRuntime;
  let validatedRuntime;
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    if (args.includes("env:validate")) {
      validatedRuntime = validateEnvironment(args).runtime;
    } else if (args.includes("deploy")) {
      const config = JSON.parse(
        fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"),
      );
      assert.deepEqual(config.mtls_certificates, [
        { binding: "GCP_MTLS", certificate_id: "c".repeat(32) },
      ]);
      const secrets = JSON.parse(
        fs.readFileSync(args[args.indexOf("--secrets-file") + 1], "utf8"),
      );
      deployedRuntime = JSON.parse(
        Array.from(
          { length: Number(secrets.API_ENV_JSON_PARTS) },
          (_, i) => secrets[`API_ENV_JSON_${i}`],
        ).join(""),
      );
    }
    return { status: 0 };
  });
  await main("deploy");
  assert.equal(validatedRuntime.GCP_LLM_WORKLOAD_IDENTITY_PROVIDER, provider);
  assert.equal(validatedRuntime.GCP_MTLS_CERTIFICATE_CHAIN, certificateChain);
  assert.equal(deployedRuntime.GCP_LLM_WORKLOAD_IDENTITY_PROVIDER, provider);
  assert.equal(deployedRuntime.GCP_MTLS_CERTIFICATE_CHAIN, certificateChain);
  assert.equal(deployedRuntime.GCP_LLM_PROJECT_ID, "test-project");
  assert.equal(
    deployedRuntime.GCP_LLM_SERVICE_ACCOUNT_EMAIL,
    "llm-dev@test-project.iam.gserviceaccount.com",
  );
  assert.equal(fs.readFileSync(envFile, "utf8"), sharedEnvironment);
});

test("production deployment publishes the released API with its own database binding and Google identity", async (t) => {
  const provider =
    "projects/123456789/locations/global/workloadIdentityPools/api-production/providers/x509";
  const certificateChain = JSON.stringify(["bGVhZg==", "cm9vdA=="]);
  const { envFile, outputFile, hyperdrive, mutations } = deploymentFixture(
    t,
    {
      JOB_REF: undefined,
      GH_TOKEN: undefined,
      GITHUB_REPOSITORY: undefined,
      EXPECTED_PR_HEAD_SHA: undefined,
      CF_API_NATIVE_TELEMETRY: "false",
      CF_API_LOGS_DESTINATION: undefined,
      CF_API_TRACES_DESTINATION: undefined,
      GCP_MTLS_CERTIFICATE_ID: "d".repeat(32),
      GCP_MTLS_CERTIFICATE_CHAIN: certificateChain,
      GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER: provider,
    },
    true,
  );
  const releaseRuntime = {
    ENV: "production",
    GIT_COMMIT_SHA: "4".repeat(40),
    CLERK_PUBLISHABLE_KEY: "pk_live_test",
    CLERK_SECRET_KEY: "sk_live_test",
    APP_URL: "https://app.okou.ai",
    OKOU_WEB_URL: "https://www.okou.ai",
    OKOU_API_BACKEND_URL: "https://api.okou.ai",
    DATABASE_URL:
      "postgresql://production:password@ep-production-pooler.example.neon.tech/neondb",
    AXIOM_DATASET_SUFFIX: "prod",
    GCP_LLM_PROJECT_ID: "test-project",
    GCP_LLM_SERVICE_ACCOUNT_EMAIL:
      "llm-production@test-project.iam.gserviceaccount.com",
    GCP_LLM_WORKLOAD_IDENTITY_PROVIDER:
      "projects/123456789/locations/global/workloadIdentityPools/vercel-production/providers/oidc",
  };
  const sharedEnvironment = `${Object.entries(releaseRuntime)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(
      "",
    )}API_VALIDATED_ENV={"DATABASE_URL":"${releaseRuntime.DATABASE_URL}"}\n`;
  fs.writeFileSync(envFile, sharedEnvironment);
  const workerRuntime = {
    ...releaseRuntime,
    DATABASE_URL:
      "postgresql://production:password@ep-production.example.neon.tech/neondb?sslmode=verify-full",
    GCP_LLM_WORKLOAD_IDENTITY_PROVIDER: provider,
    GCP_MTLS_CERTIFICATE_CHAIN: certificateChain,
  };
  const commands = [];
  let generatedPath;
  let secretsPath;
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    if (args.includes("env:validate")) {
      assert.deepEqual(validateEnvironment(args).runtime, workerRuntime);
      commands.push("validate");
    } else if (args.includes("build:worker")) commands.push("build");
    else {
      assert.ok(args.includes("deploy"));
      generatedPath = args[args.indexOf("--config") + 1];
      const config = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
      assert.equal(config.name, "okou-api-production");
      assert.equal(config.workers_dev, true);
      assert.deepEqual(config.routes, []);
      assert.deepEqual(config.triggers.crons, []);
      assert.equal(config.vars.API_NATIVE_TELEMETRY, "false");
      assert.deepEqual(config.hyperdrive, [
        { binding: "HYPERDRIVE", id: hyperdrive.id },
      ]);
      assert.deepEqual(config.mtls_certificates, [
        { binding: "GCP_MTLS", certificate_id: "d".repeat(32) },
      ]);
      secretsPath = args[args.indexOf("--secrets-file") + 1];
      const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
      const runtime = JSON.parse(
        Array.from(
          { length: Number(secrets.API_ENV_JSON_PARTS) },
          (_, i) => secrets[`API_ENV_JSON_${i}`],
        ).join(""),
      );
      assert.deepEqual(runtime, {
        ...workerRuntime,
        API_VALIDATED_ENV: JSON.stringify({
          DATABASE_URL: workerRuntime.DATABASE_URL,
        }),
      });
      commands.push("upload");
    }
    return { status: 0 };
  });
  await main("deploy-production");
  assert.deepEqual(commands, ["validate", "build", "upload"]);
  assert.deepEqual(mutations, [
    ["POST", `/client/v4/accounts/${"a".repeat(32)}/hyperdrive/configs`],
  ]);
  assert.equal(
    fs.readFileSync(outputFile, "utf8"),
    `worker-url=https://okou-api-production.test-account.workers.dev\nsource-sha=${releaseRuntime.GIT_COMMIT_SHA}\n`,
  );
  assert.equal(fs.readFileSync(envFile, "utf8"), sharedEnvironment);
  assert.equal(fs.existsSync(generatedPath), false);
  assert.equal(fs.existsSync(path.dirname(secretsPath)), false);
});

for (const kind of ["logs", "traces"]) {
  test(`native deployment without the ${kind} destination stops before building or mutating resources`, async (t) => {
    const { mutations } = deploymentFixture(t, {
      [`CF_API_${kind.toUpperCase()}_DESTINATION`]: undefined,
    });
    const processBoundary = t.mock.method(childProcess, "spawnSync", () => {
      throw new Error("Deployment must not start with incomplete exports");
    });
    await assert.rejects(
      main("deploy"),
      new RegExp(
        `requires a valid CF_API_${kind.toUpperCase()}_DESTINATION slug`,
      ),
    );
    assert.equal(processBoundary.mock.callCount(), 0);
    assert.deepEqual(mutations, []);
  });
}

test("native deployment rejects a non-dev Axiom configuration before changing resources", async (t) => {
  const { envFile, mutations } = deploymentFixture(t);
  fs.writeFileSync(
    envFile,
    `ENV=preview\nGIT_COMMIT_SHA=${"3".repeat(40)}\nAXIOM_DATASET_SUFFIX=prod\n`,
  );
  const processBoundary = t.mock.method(childProcess, "spawnSync", () => {
    throw new Error("Deployment must not start with a production dataset");
  });
  await assert.rejects(main("deploy"), /requires an Axiom dev configuration/);
  assert.equal(processBoundary.mock.callCount(), 0);
  assert.deepEqual(mutations, []);
});

test("SDK telemetry deployment retains optional export destinations and runtime credentials", async (t) => {
  const { envFile } = deploymentFixture(t, {
    CF_API_NATIVE_TELEMETRY: "false",
    CF_API_LOGS_DESTINATION: undefined,
    CF_API_TRACES_DESTINATION: undefined,
  });
  fs.writeFileSync(
    envFile,
    fs
      .readFileSync(envFile, "utf8")
      .replace(
        "AXIOM_TOKEN_TELEMETRY=\n",
        "AXIOM_TOKEN_TELEMETRY=private-product-token\n",
      ),
  );
  const commands = [];
  t.mock.method(childProcess, "spawnSync", (_command, args) => {
    if (args.includes("env:validate")) validateEnvironment(args);
    else if (args.includes("build:worker")) commands.push("build");
    else {
      const config = JSON.parse(
        fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"),
      );
      assert.equal(config.vars.API_NATIVE_TELEMETRY, "false");
      assert.deepEqual(config.observability.logs.destinations, []);
      assert.deepEqual(config.observability.traces.destinations, []);
      const secrets = JSON.parse(
        fs.readFileSync(args[args.indexOf("--secrets-file") + 1], "utf8"),
      );
      const runtime = JSON.parse(secrets.API_ENV_JSON_0);
      assert.equal(runtime.AXIOM_TOKEN_TELEMETRY, "private-product-token");
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
