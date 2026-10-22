#!/usr/bin/env node
// Run from the repository root with Node 24 and the installed toolchain.
// deploy: JOB_REF, API_ENV_FILE, NEON_API_KEY, NEON_PROJECT_ID,
// CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GH_TOKEN, GITHUB_REPOSITORY.
// cleanup uses the same credentials except API_ENV_FILE; accepts PR refs only.
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
  return { worker: `okou-api-preview-${ref}`, branch: `preview-worker/${ref}` };
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
  // Reserve one Hyperdrive binding as well as the encrypted part count.
  if (parts.length > 126)
    throw new Error("Runtime configuration exceeds the Worker binding budget");
  return {
    API_ENV_JSON_PARTS: String(parts.length),
    ...Object.fromEntries(
      parts.map((value, index) => [`API_ENV_JSON_${index}`, value]),
    ),
  };
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
  if (output.includes("startup time limit"))
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

async function main(mode) {
  const ref = required("JOB_REF");
  const names = identities(ref);
  if (!["deploy", "cleanup"].includes(mode))
    throw new Error("Usage: api-worker-preview.cjs deploy|cleanup");
  if (mode === "cleanup" && ref === "staging")
    throw new Error("Cleanup requires a PR reference");
  const account = required("CLOUDFLARE_ACCOUNT_ID");
  const project = required("NEON_PROJECT_ID");
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9-]+$/.test(project))
    throw new Error("Invalid control-plane account/project identity");
  const cfToken = required("CLOUDFLARE_API_TOKEN");
  const neonToken = required("NEON_API_KEY");
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
  const neon = (method, route, body) =>
    request(
      `https://console.neon.tech/api/v2/projects/${project}`,
      neonToken,
      method,
      route,
      body,
    );

  // Both jobs hold the same non-cancelling per-preview concurrency lock. Recheck
  // GitHub state inside that lock so delayed CI cannot recreate a closed preview.
  if (ref.startsWith("pr-")) {
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
  }

  // Neon search can be fuzzy; ownership always uses an exact branch name.
  const branches = (
    await neon(
      "GET",
      `/branches?search=${encodeURIComponent(names.branch)}&limit=100`,
    )
  ).branches;
  if (!Array.isArray(branches) || branches.length >= 100)
    throw new Error("Incomplete Neon preview inventory");
  const matches = branches.filter((branch) => branch.name === names.branch);
  if (matches.length > 1) throw new Error("Ambiguous Neon preview identity");
  let branch = matches[0];
  if (branch && !/^br-[a-z0-9-]+$/.test(branch.id))
    throw new Error("Invalid Neon branch ID");
  const hyperdrives = await cf("GET", "/hyperdrive/configs");
  if (!Array.isArray(hyperdrives))
    throw new Error("Invalid Hyperdrive inventory");
  const configs = hyperdrives.filter((config) => config.name === names.worker);
  if (configs.length > 1)
    throw new Error("Ambiguous Hyperdrive preview identity");
  let hyperdrive = configs[0];
  if (hyperdrive && !/^[a-f0-9]{32}$/.test(hyperdrive.id))
    throw new Error("Invalid Hyperdrive ID");

  if (mode === "cleanup") {
    // Delete the Worker before removing its database binding and origin branch.
    await cf("DELETE", `/workers/scripts/${names.worker}`, undefined, true);
    if (hyperdrive) await cf("DELETE", `/hyperdrive/configs/${hyperdrive.id}`);
    if (branch) await neon("DELETE", `/branches/${branch.id}`);
    console.log(`Removed Worker preview resources for ${ref}`);
    return;
  }

  // Never restore/reset a branch, and never touch preview/<ref> or its parent.
  if (!branch) {
    branch = (
      await neon("POST", "/branches", {
        branch: { name: names.branch },
        endpoints: [{ type: "read_write" }],
      })
    ).branch;
  }
  if (!/^br-[a-z0-9-]+$/.test(branch?.id) || branch.name !== names.branch)
    throw new Error("Invalid Neon branch identity");
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = (await neon("GET", `/branches/${branch.id}`)).branch;
    if (current?.current_state === "ready") {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!ready)
    throw new Error("Neon Worker preview branch did not become ready");
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
  fs.chmodSync(required("API_ENV_FILE"), 0o600);
  const runtime = parseEnvironment(
    fs.readFileSync(required("API_ENV_FILE"), "utf8"),
  );
  runtime.DATABASE_URL = database.toString();
  if (runtime.ENV !== "preview")
    throw new Error("Only preview runtime configuration is allowed");
  const root = process.cwd();
  command(
    "Migrate isolated Worker preview database",
    ["-F", "@okouai/db", "db:migrate"],
    { DATABASE_URL: runtime.DATABASE_URL },
    path.join(root, "turbo"),
  );
  command(
    "Build API Worker",
    ["--dir", "turbo/apps/api", "build:worker"],
    {},
    root,
  );

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
  const destination = process.env.CF_API_TRACES_DESTINATION;
  if (!destination)
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
    vars: {},
    env: {},
    hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdrive.id }],
    observability: {
      enabled: true,
      logs: { enabled: true },
      traces: {
        enabled: true,
        head_sampling_rate: 1,
        destinations: destination ? [destination] : [],
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
    fs.writeFileSync(secretPath, JSON.stringify(packSecrets(runtime)), {
      mode: 0o600,
    });
    command(
      "Deploy API Worker preview",
      [
        "--dir",
        "turbo/apps/app-worker",
        "exec",
        "wrangler",
        "deploy",
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
          : "Worker preview operation failed; details withheld to protect credentials",
      );
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.env.API_ENV_FILE)
        fs.rmSync(process.env.API_ENV_FILE, { force: true });
    });
}
