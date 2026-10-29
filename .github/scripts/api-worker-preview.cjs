#!/usr/bin/env node
// Run from the repository root with Node 24 and the installed toolchain.
// deploy: JOB_REF, API_ENV_FILE, NEON_API_KEY, NEON_PROJECT_ID,
// CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GH_TOKEN, GITHUB_REPOSITORY.
// PR deploys also require the captured event's EXPECTED_PR_HEAD_SHA.
// Google operations require GCP_MTLS_CERTIFICATE_ID, GCP_MTLS_CERTIFICATE_CHAIN
// (JSON, base64 DER leaf first), and GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER from the
// target's own certificate federation configuration. The shared Vercel env file
// supplies GCP_LLM_PROJECT_ID and GCP_LLM_SERVICE_ACCOUNT_EMAIL, never its OIDC
// provider for a Worker. Certificate provisioning and rotation are operator-owned.
// CF_API_NATIVE_TELEMETRY=true requires preconfigured Axiom dev OTLP destination
// slugs in CF_API_{LOGS,TRACES}_DESTINATION; otherwise those exports are optional.
// Account destination provisioning and credentials belong to their operator.
// deploy reads the branch prepared by deploy-api; it never creates or migrates it.
// deploy-production uses the existing production branch and requires ENV=production,
// live Clerk keys and production Google certificate federation inputs. It publishes
// only a workers.dev endpoint; canonical routes and scheduled jobs stay unchanged.
// Deploys validate their final runtime with the API's env:validate before
// building, uploading its decoded record with the raw values.
// cleanup needs only JOB_REF, Cloudflare and GitHub credentials; PR refs only.
// Credentials stay in memory/environment or private temporary files, never argv.
// Only control-plane APIs are called: never the deployed Worker.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const childProcess = require("node:child_process");

// Locally created errors carry only reviewed diagnostics; native failures do not.
class Error extends globalThis.Error {}

function required(name) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
}

function identities(ref) {
  if (!/^(pr-[1-9][0-9]*|staging)$/.test(ref)) {
    throw new Error("Invalid Worker preview job reference");
  }
  return { worker: `okou-api-preview-${ref}`, branch: `preview/${ref}` };
}

// The shared resolver writes literal key=value records, including multiline PEMs.
function parseEnvironment(text) {
  const values = {};
  let key;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const inPem =
      key &&
      values[key].includes("-----BEGIN ") &&
      !values[key].includes("-----END ");
    const match = inPem ? null : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      key = match[1];
      if (Object.hasOwn(values, key))
        throw new Error("Duplicate runtime environment key");
      values[key] = match[2];
    } else if (key) {
      values[key] += `\n${line}`;
    } else {
      throw new Error("Malformed runtime environment file");
    }
  }
  return values;
}

// Cloudflare limits each secret value to 5 KiB. Stay below that limit in UTF-8,
// not JS character count, while preserving Unicode code points across chunks.
function packSecrets(runtime) {
  const json = JSON.stringify(runtime);
  // Always publish a count, even for one part: Wrangler retains old secrets,
  // so shrinking a configuration must not leave an old count authoritative.
  const parts = [];
  let part = "";
  let bytes = 0;
  for (const character of json) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 4096) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  if (part) parts.push(part);
  // Reserve Hyperdrive, API_NATIVE_TELEMETRY, the part count and optional mTLS.
  if (parts.length > 125 - Number(Boolean(runtime.GCP_MTLS_CERTIFICATE_CHAIN)))
    throw new Error("Runtime configuration exceeds the Worker binding budget");
  return {
    API_ENV_JSON_PARTS: String(parts.length),
    ...Object.fromEntries(
      parts.map((value, index) => [`API_ENV_JSON_${index}`, value]),
    ),
  };
}

function googleCertificateBinding(runtime) {
  const certificateId = process.env.GCP_MTLS_CERTIFICATE_ID;
  const certificateChain = process.env.GCP_MTLS_CERTIFICATE_CHAIN;
  const provider = process.env.GCP_MTLS_WORKLOAD_IDENTITY_PROVIDER;
  const configured = [
    certificateId,
    certificateChain,
    provider,
    runtime.GCP_LLM_PROJECT_ID,
    runtime.GCP_LLM_SERVICE_ACCOUNT_EMAIL,
    runtime.GCP_LLM_WORKLOAD_IDENTITY_PROVIDER,
  ].some(Boolean);
  if (!configured) return [];
  if (
    !certificateId ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(
      certificateId,
    ) ||
    !certificateChain ||
    !provider ||
    !/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(
      provider,
    ) ||
    !runtime.GCP_LLM_PROJECT_ID ||
    !runtime.GCP_LLM_SERVICE_ACCOUNT_EMAIL
  )
    throw new Error(
      "Google operations require complete GCP mTLS configuration for this Worker target",
    );
  if (provider === runtime.GCP_LLM_WORKLOAD_IDENTITY_PROVIDER)
    throw new Error(
      "Worker certificate federation requires a distinct X.509 workload identity provider",
    );
  let chain;
  try {
    chain = JSON.parse(certificateChain);
  } catch {
    throw new Error("Invalid GCP_MTLS_CERTIFICATE_CHAIN");
  }
  if (
    !Array.isArray(chain) ||
    chain.length < 1 ||
    chain.length > 5 ||
    chain.some(
      (certificate) =>
        typeof certificate !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(certificate),
    )
  )
    throw new Error("Invalid GCP_MTLS_CERTIFICATE_CHAIN");
  runtime.GCP_LLM_WORKLOAD_IDENTITY_PROVIDER = provider;
  runtime.GCP_MTLS_CERTIFICATE_CHAIN = JSON.stringify(chain);
  return [{ binding: "GCP_MTLS", certificate_id: certificateId }];
}

async function request(base, token, method, route, body, allowMissing = false) {
  // Routes are internally constructed resource paths. Exclude query strings,
  // bodies, headers and provider messages while preserving the failed operation.
  const operation = `${new URL(base).hostname} ${method} ${route.split(/[?#]/u)[0]}`;
  let response;
  try {
    response = await fetch(`${base}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    // Native fetch errors and provider responses may contain request credentials.
    throw new Error(
      `Control-plane ${operation} failed; outcome may be uncertain, not retried`,
    );
  }
  if (allowMissing && response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `Control-plane ${operation} failed (HTTP ${response.status})`,
    );
  try {
    return await response.json();
  } catch {
    throw new Error("Invalid control-plane response");
  }
}

// Emit only fixed classifications and bounded numeric metadata. Raw diagnostics
// can include database URLs, SQL, runtime secrets, or provider response bodies.
function commandDiagnostics(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const details = new Set();
  for (const match of output.matchAll(/\[code:\s*(\d{1,8})\]/g)) {
    details.add(`Cloudflare code ${match[1]}`);
    if (details.size === 3) break;
  }
  const exception = output.match(
    /\bUncaught (TypeError|ReferenceError|SyntaxError|RangeError|Error)\b/,
  );
  if (exception) details.add(`startup ${exception[1]}`);
  for (const match of output.matchAll(/\bworker\.js:(\d{1,8}):(\d{1,8})\b/g)) {
    details.add(`worker.js:${match[1]}:${match[2]}`);
    if (details.size >= 8) break;
  }
  if (output.includes("exceeded the size limit"))
    details.add("Worker size limit exceeded");
  if (
    output.includes("startup time limit") ||
    output.includes("Script startup exceeded CPU time limit")
  )
    details.add("Worker startup time limit exceeded");
  return [...details].join("; ");
}

function command(label, args, env, cwd) {
  console.log(label);
  const result = childProcess.spawnSync("pnpm", args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Migration/Wrangler diagnostics can echo URLs, SQL parameters or secret files.
  // Do not print raw subprocess diagnostics, including on failure.
  if (result.error || result.status !== 0) {
    const diagnostics = commandDiagnostics(result);
    throw new Error(
      `${label} failed${diagnostics ? ` (${diagnostics})` : ""} (output withheld to protect credentials)`,
    );
  }
}

// The workflow validated the shared file, but Workers override some of its
// values. Validate the exact runtime uploaded here so the API's published
// decoded record matches it; the API owns that schema and record.
function validateRuntime(runtime, root) {
  const values = { ...runtime };
  delete values.API_VALIDATED_ENV;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "api-worker-env-"));
  try {
    const file = path.join(temporary, "runtime.env");
    fs.writeFileSync(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { mode: 0o600 },
    );
    command(
      "Validate API Worker environment",
      ["--dir", "turbo/apps/api", "env:validate", file],
      {},
      root,
    );
    return parseEnvironment(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// The existing API release/preview lane owns branch creation and migrations.
// Workers uses a direct connection to that exact existing branch, never a second
// compute/branch or a hostname derived by rewriting Vercel's pooled URL.
async function sharedDatabase(neon, branchName) {
  const branches = (
    await neon(
      "GET",
      `/branches?search=${encodeURIComponent(branchName)}&limit=100`,
    )
  ).branches;
  if (!Array.isArray(branches) || branches.length >= 100)
    throw new Error("Incomplete Neon branch inventory");
  const matches = branches.filter((branch) => branch.name === branchName);
  if (matches.length !== 1 || !/^br-[a-z0-9-]+$/.test(matches[0].id))
    throw new Error("Expected one existing shared API database branch");
  const branch = (await neon("GET", `/branches/${matches[0].id}`)).branch;
  if (
    branch?.id !== matches[0].id ||
    branch.name !== branchName ||
    branch.current_state !== "ready"
  )
    throw new Error("Shared API database branch is not ready");
  const connection = await neon(
    "GET",
    `/connection_uri?branch_id=${encodeURIComponent(branch.id)}&database_name=neondb&role_name=neondb_owner&pooled=false`,
  );
  let database;
  try {
    database = new URL(connection.uri);
  } catch {
    throw new Error("Invalid Neon connection URI");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.hostname.endsWith(".neon.tech") ||
    database.hostname.includes("-pooler.") ||
    !database.username ||
    !database.password
  )
    throw new Error("Expected a direct Neon database endpoint");
  database.searchParams.set("sslmode", "verify-full");
  console.log(
    `Reuse prepared API database branch ${branchName} (${branch.id})`,
  );
  return database;
}

async function main(mode) {
  if (!["deploy", "deploy-production", "cleanup"].includes(mode))
    throw new Error(
      "Usage: api-worker-preview.cjs deploy|deploy-production|cleanup",
    );
  const production = mode === "deploy-production";
  const ref = production ? "production" : required("JOB_REF");
  const names = production
    ? { worker: "okou-api-production", branch: "production" }
    : identities(ref);
  if (mode === "cleanup" && ref === "staging")
    throw new Error("Cleanup requires a PR reference");
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/.test(account))
    throw new Error("Invalid Cloudflare account identity");
  const cfToken = required("CLOUDFLARE_API_TOKEN");
  const cf = async (method, route, body, missing = false) => {
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${account}`,
      cfToken,
      method,
      route,
      body,
      missing,
    );
    if (response === null) return null;
    if (response.success !== true)
      throw new Error("Cloudflare control-plane operation rejected");
    return response.result;
  };
  // Turbo may cancel a superseded preview run. Reconcile exact resource names
  // on the next run, reject stale PR revisions and never replay uncertain writes.
  // Cleanup executes trusted default-branch code and never owns the shared DB.
  const assertCurrentPreview = async () => {
    if (!ref.startsWith("pr-")) return;
    const repository = required("GITHUB_REPOSITORY");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Invalid repository identity");
    const pr = await request(
      "https://api.github.com",
      required("GH_TOKEN"),
      "GET",
      `/repos/${repository}/pulls/${ref.slice(3)}`,
    );
    if (pr.state !== (mode === "cleanup" ? "closed" : "open"))
      throw new Error("PR state does not authorize Worker preview operation");
    if (mode === "deploy" && pr.head?.repo?.full_name !== repository)
      throw new Error("Fork PR cannot deploy a Worker preview");
    if (mode === "deploy" && pr.head?.sha !== required("EXPECTED_PR_HEAD_SHA"))
      throw new Error("Superseded PR revision cannot deploy a Worker preview");
  };
  await assertCurrentPreview();

  const hyperdrives = await cf("GET", "/hyperdrive/configs");
  if (!Array.isArray(hyperdrives))
    throw new Error("Invalid Hyperdrive inventory");
  const configs = hyperdrives.filter((config) => config.name === names.worker);
  if (configs.length > 1) throw new Error("Ambiguous Hyperdrive identity");
  let hyperdrive = configs[0];
  if (hyperdrive && !/^[a-f0-9]{32}$/.test(hyperdrive.id))
    throw new Error("Invalid Hyperdrive ID");

  if (mode === "cleanup") {
    // Shared Neon branch cleanup belongs exclusively to the existing DB owner.
    await cf("DELETE", `/workers/scripts/${names.worker}`, undefined, true);
    if (hyperdrive) await cf("DELETE", `/hyperdrive/configs/${hyperdrive.id}`);
    console.log(`Removed Worker preview resources for ${ref}`);
    return;
  }

  const project = required("NEON_PROJECT_ID");
  if (!/^[a-z0-9-]+$/.test(project))
    throw new Error("Invalid Neon project identity");
  const neonToken = required("NEON_API_KEY");
  const neon = (method, route) => {
    if (method !== "GET")
      throw new Error("Worker deployment may only read shared Neon resources");
    return request(
      `https://console.neon.tech/api/v2/projects/${project}`,
      neonToken,
      method,
      route,
    );
  };
  const database = await sharedDatabase(neon, names.branch);
  fs.chmodSync(required("API_ENV_FILE"), 0o600);
  const runtime = parseEnvironment(
    fs.readFileSync(required("API_ENV_FILE"), "utf8"),
  );
  runtime.DATABASE_URL = database.toString();
  if (runtime.ENV !== (production ? "production" : "preview"))
    throw new Error(
      `Expected ${production ? "production" : "preview"} runtime configuration`,
    );
  if (
    production &&
    (!runtime.CLERK_SECRET_KEY?.startsWith("sk_live_") ||
      !runtime.CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_"))
  )
    throw new Error("Production Worker requires live Clerk keys");
  const googleCertificates = googleCertificateBinding(runtime);
  if (production && googleCertificates.length !== 1)
    throw new Error("Production Worker requires Google certificate federation");
  const nativeTelemetry = process.env.CF_API_NATIVE_TELEMETRY === "true";
  if (nativeTelemetry && !ref.startsWith("pr-"))
    throw new Error("Native telemetry validation requires a PR preview");
  const exports = {
    logs: process.env.CF_API_LOGS_DESTINATION,
    traces: process.env.CF_API_TRACES_DESTINATION,
  };
  if (nativeTelemetry) {
    if (runtime.AXIOM_DATASET_SUFFIX !== "dev")
      throw new Error(
        "Native preview telemetry requires an Axiom dev configuration",
      );
    // Validate before building or changing Hyperdrive. CI only references
    // operator-provisioned destinations; it never manages their credentials.
    for (const kind of ["logs", "traces"]) {
      if (!/^[a-z0-9-]+$/.test(exports[kind] ?? ""))
        throw new Error(
          `Native preview telemetry requires a valid CF_API_${kind.toUpperCase()}_DESTINATION slug`,
        );
    }
  }
  const subdomain = (await cf("GET", "/workers/subdomain"))?.subdomain;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain))
    throw new Error("Invalid Workers subdomain");
  if (!/^[a-f0-9]{40}$/.test(runtime.GIT_COMMIT_SHA))
    throw new Error("Invalid Worker source revision");
  const root = process.cwd();
  const validated = validateRuntime(runtime, root);
  command(
    "Build API Worker",
    ["--dir", "turbo/apps/api", "build:worker"],
    {},
    root,
  );

  await assertCurrentPreview();
  const origin = {
    scheme: "postgres",
    host: database.hostname,
    port: Number(database.port || 5432),
    database: decodeURIComponent(database.pathname.slice(1)),
    user: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password),
  };
  const body = { name: names.worker, origin, caching: { disabled: true } };
  hyperdrive = hyperdrive
    ? await cf("PUT", `/hyperdrive/configs/${hyperdrive.id}`, body)
    : await cf("POST", "/hyperdrive/configs", body);
  if (
    !/^[a-f0-9]{32}$/.test(hyperdrive?.id) ||
    hyperdrive.name !== names.worker ||
    hyperdrive.caching?.disabled !== true
  )
    throw new Error("Hyperdrive reconciliation was not confirmed");

  const requireWorker = createRequire(
    path.join(root, "turbo/apps/app-worker/package.json"),
  );
  // Wrangler has no supported config-file `extends`. Use its pinned JSONC parser
  // and write beside the source config to preserve all relative build paths.
  const { experimental_readRawConfig } = requireWorker("wrangler");
  const configPath = path.join(root, "turbo/apps/api/wrangler.jsonc");
  const { rawConfig } = experimental_readRawConfig({ config: configPath });
  if (
    rawConfig.main !== "dist-worker/worker.js" ||
    rawConfig.no_bundle !== true
  )
    throw new Error("Unexpected API Worker entrypoint");
  if (!exports.traces)
    console.log(
      "::notice::Native Worker tracing enabled; Axiom export requires the CF_API_TRACES_DESTINATION repository variable and an account OTLP destination",
    );
  const generated = {
    ...rawConfig,
    name: names.worker,
    account_id: account,
    routes: [],
    workers_dev: true,
    preview_urls: false,
    triggers: { crons: [] },
    vars: { API_NATIVE_TELEMETRY: String(nativeTelemetry) },
    env: {},
    hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdrive.id }],
    mtls_certificates: googleCertificates,
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        destinations: exports.logs ? [exports.logs] : [],
      },
      traces: {
        enabled: true,
        head_sampling_rate: 1,
        destinations: exports.traces ? [exports.traces] : [],
      },
    },
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "api-worker-"));
  const generatedPath = path.join(
    path.dirname(configPath),
    `.${path.basename(temporary)}.json`,
  );
  try {
    fs.writeFileSync(generatedPath, JSON.stringify(generated), {
      mode: 0o600,
      flag: "wx",
    });
    const secretPath = path.join(temporary, "secrets.json");
    fs.writeFileSync(secretPath, JSON.stringify(packSecrets(validated)), {
      mode: 0o600,
    });
    command(
      `Deploy API Worker ${production ? "production" : "preview"}`,
      [
        "--dir",
        "turbo/apps/app-worker",
        "exec",
        "wrangler",
        "deploy",
        // Rollbacks select immutable history by the full release source SHA.
        ...(production ? ["--tag", runtime.GIT_COMMIT_SHA] : []),
        "--config",
        generatedPath,
        "--secrets-file",
        secretPath,
      ],
      {
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
      },
      root,
    );
    console.log(
      `Deployed ${names.worker}; no Worker HTTP/health/E2E requests were made`,
    );
    const url = `https://${names.worker}.${subdomain}.workers.dev`;
    console.log(`API Worker ${production ? "production" : "preview"}: ${url}`);
    console.log(`API Worker source revision: ${runtime.GIT_COMMIT_SHA}`);
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `worker-url=${url}\nsource-sha=${runtime.GIT_COMMIT_SHA}\n`,
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `API Worker ${production ? "production" : "preview"}: ${url}\n\nSource: \`${runtime.GIT_COMMIT_SHA}\`\n\nNative Axiom export: ${nativeTelemetry}\n`,
      );
  } finally {
    fs.rmSync(generatedPath, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  identities,
  parseEnvironment,
  packSecrets,
  request,
  command,
  sharedDatabase,
  main,
};
if (require.main === module) {
  main(process.argv[2])
    .catch((error) => {
      // All errors intentionally created above are credential-free. Never print
      // native exception text, which may embed source/config/credential content.
      console.error(
        error instanceof Error
          ? error.message
          : "Worker operation failed; details withheld to protect credentials",
      );
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.env.API_ENV_FILE)
        fs.rmSync(process.env.API_ENV_FILE, { force: true });
    });
}
