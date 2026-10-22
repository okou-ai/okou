import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const apiRequire = createRequire(
  path.join(root, "turbo/apps/api/package.json"),
);
const rootRequire = createRequire(path.join(root, "turbo/package.json"));
const appRequire = createRequire(
  path.join(root, "turbo/apps/app-worker/package.json"),
);
const output = path.join(
  process.env.RUNNER_TEMP ?? "/tmp",
  "cloudflare-auth-spike",
);
await mkdir(output, { recursive: true });
const ownershipFile = path.join(output, "owned-worker.json");
const report = {
  sha: process.env.SOURCE_SHA,
  kms: [],
  google: { status: "BLOCKED" },
};
const context = { purpose: "vm0-stored-secret" };
const prefix = "vm0secret:v1:";
const encode = (kms) =>
  prefix +
  Buffer.from(JSON.stringify({ v: 1, kind: "stored-secret", kms })).toString(
    "base64url",
  );
const decode = (value) =>
  JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString());

function safeFailure(error) {
  return {
    status: "FAIL",
    error: error?.name ?? "UnknownError",
    httpStatus: error?.$metadata?.httpStatusCode ?? error?.httpStatus ?? null,
    ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}),
  };
}
async function cf(account, suffix, method = "GET", body) {
  const headers = {
    Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
  };
  if (body && !(body instanceof FormData))
    headers["Content-Type"] = "application/json";
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${suffix}`,
    {
      method,
      headers,
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw Object.assign(new Error("Cloudflare request failed"), {
      name: "CloudflareError",
      httpStatus: response.status,
      diagnostics: data.errors?.map((error) => ({
        code: error.code,
        runtimeType: error.message?.match(/Uncaught (\w+Error)/)?.[1] ?? null,
        locations: error.message?.match(/worker\.js:\d+:\d+/g) ?? [],
        invalidRequirePath: /filename|absolute path|file URL/.test(
          error.message ?? "",
        ),
        missingModule:
          error.message?.match(
            /(?:No such module|Cannot find module|Dynamic require of) ["']([a-zA-Z0-9_@:/.-]+)["']/,
          )?.[1] ?? null,
      })),
    });
  }
  return data.result;
}
async function cleanup() {
  let owned;
  try {
    owned = JSON.parse(await readFile(ownershipFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      report.cleanup = "NOT_DEPLOYED";
      return;
    }
    throw error;
  }
  const scripts = await cf(owned.account, "/workers/scripts");
  if (scripts.some((script) => script.id === owned.name)) {
    const settings = await cf(
      owned.account,
      `/workers/scripts/${owned.name}/settings`,
    );
    assert.ok(
      settings.bindings.some(
        (binding) =>
          binding.name === "SPIKE_OWNER" && binding.text === owned.owner,
      ),
    );
    await cf(owned.account, `/workers/scripts/${owned.name}`, "DELETE");
    assert.ok(
      !(await cf(owned.account, "/workers/scripts")).some(
        (script) => script.id === owned.name,
      ),
    );
  }
  await rm(ownershipFile);
  report.cleanup = "PASS";
}
async function buildNodeCrypto() {
  const { build: bundle } = rootRequire("esbuild");
  const outfile = path.join(output, "crypto-node.mjs");
  await bundle({
    entryPoints: [
      path.join(root, "turbo/apps/api/src/signals/services/crypto.utils.ts"),
    ],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "node-env-adapter",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/lib\/env$/ }, () => ({
            path: path.join(directory, "bindings-node.mjs"),
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(outfile).href);
}
async function build() {
  const { build: bundle } = rootRequire("esbuild");
  const intermediate = path.join(output, "worker.mjs");
  await bundle({
    entryPoints: [path.join(directory, "worker.mjs")],
    outfile: intermediate,
    bundle: true,
    format: "esm",
    platform: "browser",
    external: [...builtinModules, "node:*", "cloudflare:workers"],
    banner: {
      js: 'import { createRequire as createWorkerRequire } from "node:module"; const require = createWorkerRequire(import.meta.url);',
    },
    nodePaths: [
      path.join(root, "turbo/apps/api/node_modules"),
      path.join(root, "turbo/node_modules"),
    ],
    plugins: [
      {
        name: "cloudflare-deployment-adapters",
        setup(builder) {
          builder.onResolve(
            { filter: /^\.\.\/\.\.\/lib\/(env|secret-kms-client)$/ },
            (args) => {
              if (!args.importer.endsWith("/signals/services/crypto.utils.ts"))
                return;
              return {
                path: path.join(
                  directory,
                  args.path.endsWith("/env") ? "bindings.mjs" : "kms.mjs",
                ),
              };
            },
          );
        },
      },
    ],
  });
  const config = path.join(output, "wrangler.json");
  await writeFile(
    config,
    JSON.stringify({
      name: "okou-auth-spike-build",
      main: intermediate,
      compatibility_date: "2026-08-06",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
    }),
  );
  const wrangler = path.join(
    path.dirname(appRequire.resolve("wrangler/package.json")),
    "bin/wrangler.js",
  );
  execFileSync(
    process.execPath,
    [
      wrangler,
      "deploy",
      "--dry-run",
      "--config",
      config,
      "--outdir",
      path.join(output, "bundle"),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  return readFile(path.join(output, "bundle/worker.js"));
}

if (process.argv.includes("--cleanup")) {
  await cleanup();
} else if (process.argv.includes("--build-only")) {
  await buildNodeCrypto();
  await build();
} else {
  let client;
  try {
    for (const name of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "PR_NUMBER",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "SOURCE_SHA",
    ])
      assert.ok(process.env[name], `Missing ${name}`);
    assert.match(process.env.PR_NUMBER, /^\d+$/);
    assert.match(process.env.SOURCE_SHA, /^[a-f0-9]{40}$/);
    const canary = `cloudflare-auth-spike:${process.env.GITHUB_RUN_ID}:${randomBytes(8).toString("hex")}`;
    const fixture = {};
    let nodeCrypto;
    let keyId;
    const hasKms = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
      "SECRETS_KMS_KEY_ID",
      "EXPECTED_KMS_KEY_ARN",
    ].every((name) => process.env[name]);
    if (hasKms) {
      assert.equal(
        process.env.SECRETS_KMS_KEY_ID,
        process.env.EXPECTED_KMS_KEY_ARN,
      );
      const expectedKey = process.env.EXPECTED_KMS_KEY_ARN.split(":");
      assert.equal(expectedKey[2], "kms");
      assert.equal(expectedKey[3], process.env.AWS_REGION);
      const identity = JSON.parse(
        execFileSync(
          "aws",
          ["sts", "get-caller-identity", "--output", "json"],
          {
            encoding: "utf8",
            timeout: 20_000,
          },
        ),
      );
      assert.ok(
        !identity.Arn.endsWith(":root"),
        "Root AWS credentials are forbidden",
      );
      assert.equal(identity.Account, expectedKey[4]);
      report.nonRootPreviewPrincipal = true;
      const { KMSClient, EncryptCommand } = apiRequire("@aws-sdk/client-kms");
      client = new KMSClient({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
        maxAttempts: 1,
      });
      nodeCrypto = await buildNodeCrypto();
      fixture.envelope = await nodeCrypto.encryptStoredSecretValue(canary);
      keyId = decode(fixture.envelope).kms.keyId;
      assert.equal(keyId, process.env.EXPECTED_KMS_KEY_ARN);
      try {
        const direct = await client.send(
          new EncryptCommand({
            KeyId: keyId,
            Plaintext: Buffer.from(canary),
            EncryptionContext: context,
          }),
        );
        fixture.direct = encode({
          keyId,
          ciphertext: Buffer.from(direct.CiphertextBlob).toString("base64"),
        });
      } catch (error) {
        if (error.name !== "AccessDeniedException") throw error;
        report.kms.push({
          name: "node-to-worker-direct",
          status: "BLOCKED",
          reason:
            "Preview principal cannot create legacy direct canary (kms:Encrypt)",
        });
      }
    } else {
      report.kms.push({
        name: "dedicated-kms-credentials",
        status: "BLOCKED",
        reason:
          "Configure dedicated CF_SPIKE_* AWS secrets and key/region allowlist variables; existing preview credentials are never reused",
      });
    }
    const bundle = await build();
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const name = `okou-auth-pr-${process.env.PR_NUMBER}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    const owner = randomBytes(16).toString("hex");
    assert.ok(
      !(await cf(account, "/workers/scripts")).some(
        (script) => script.id === name,
      ),
      "Refusing to overwrite existing Worker",
    );
    const gate = randomBytes(32).toString("hex");
    const texts = {
      SOURCE_SHA: report.sha,
      SPIKE_OWNER: owner,
      CANARY: canary,
      AWS_REGION: process.env.AWS_REGION,
      SECRETS_KMS_KEY_ID: process.env.SECRETS_KMS_KEY_ID,
      RESOLVED_KEY_ID: keyId,
      GCP_PROJECT: process.env.GCP_PROJECT,
      GCP_SERVICE_ACCOUNT_EMAIL: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
    };
    const secrets = {
      PROBE_AUTH: gate,
      AWS_ACCESS_KEY_ID: keyId ? process.env.AWS_ACCESS_KEY_ID : undefined,
      AWS_SECRET_ACCESS_KEY: keyId
        ? process.env.AWS_SECRET_ACCESS_KEY
        : undefined,
      GCP_SERVICE_ACCOUNT_JSON: process.env.GCP_SERVICE_ACCOUNT_JSON,
    };
    const bindings = [
      ...Object.entries(texts)
        .filter(([, value]) => value)
        .map(([name, text]) => ({ name, text, type: "plain_text" })),
      ...Object.entries(secrets)
        .filter(([, value]) => value)
        .map(([name, text]) => ({ name, text, type: "secret_text" })),
      { name: "VERSION", type: "version_metadata" },
    ];
    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2026-08-06",
      compatibility_flags: ["nodejs_compat"],
      bindings,
      observability: { enabled: false },
    };
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append(
      "worker.js",
      new Blob([bundle], { type: "application/javascript+module" }),
      "worker.js",
    );
    report.ownership = { name, owner }; // Non-secret cleanup identity, not the bearer gate.
    await writeFile(ownershipFile, JSON.stringify({ account, name, owner }), {
      mode: 0o600,
    });
    const deployed = await cf(account, `/workers/scripts/${name}`, "PUT", form);
    report.deployment = deployed.deployment_id;
    await cf(account, `/workers/scripts/${name}/subdomain`, "POST", {
      enabled: true,
      previews_enabled: false,
    });
    const { subdomain } = await cf(account, "/workers/subdomain");
    const url = `https://${name}.${subdomain}.workers.dev/`;
    report.previewUrl = url;
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
        });
        if (
          response.ok &&
          response.headers.get("content-type")?.includes("application/json")
        )
          ready = (await response.json()).sha === report.sha;
        else await response.body?.cancel();
      } catch (error) {
        if (!["TypeError", "TimeoutError", "AbortError"].includes(error.name))
          throw error;
        report.readinessTransportFailures =
          (report.readinessTransportFailures ?? 0) + 1;
      }
      if (!ready && Date.now() < deadline) await delay(2000);
    }
    assert.ok(ready, "Preview did not serve the expected SHA");
    for (const authorization of [null, "Bearer wrong-spike-token"]) {
      const denied = await fetch(url, {
        method: "POST",
        headers: authorization ? { Authorization: authorization } : {},
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(denied.status, 404);
      await denied.body?.cancel();
    }
    report.workerAuth = "PASS";
    // A single side-effecting POST. Never replay an uncertain provider operation.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gate}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fixture),
      signal: AbortSignal.timeout(90_000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.sha, report.sha);
    report.version = result.version;
    report.kms.push(...result.checks);
    report.google = result.google;
    if (keyId) {
      assert.ok(result.ciphertext);
      for (const name of [
        "node-to-worker-envelope",
        "worker-write-and-read",
        "wrong-context-rejected",
        "tampered-gcm-rejected",
        ...(fixture.direct ? ["node-to-worker-direct"] : []),
      ]) {
        assert.ok(result.checks.some((check) => check.name === name));
      }
      assert.equal(decode(result.ciphertext).kms.keyId, keyId);
      assert.equal(
        await nodeCrypto.decryptStoredSecretValue(result.ciphertext),
        canary,
      );
      report.kms.push({ name: "worker-to-node-envelope", status: "PASS" });
    }
  } catch (error) {
    report.failure = safeFailure(error);
  } finally {
    client?.destroy();
    try {
      await cleanup();
    } catch (error) {
      report.cleanup = safeFailure(error);
    }
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(report, null, 2),
    );
    const summary = `## Cloudflare auth preview spike\n\nSHA: \`${report.sha}\`\n\n${JSON.stringify(report, null, 2).replace(/^/gm, "    ")}\n\nNo production changes. P0 stays open until all positive checks, credential refresh and environment isolation pass.\n`;
    await writeFile(path.join(output, "result.md"), summary);
    if (process.env.GITHUB_STEP_SUMMARY)
      await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
    console.log(JSON.stringify(report, null, 2));
  }
  if (
    report.failure ||
    report.cleanup !== "PASS" ||
    report.google.status !== "PASS" ||
    report.kms.some((check) => check.status !== "PASS")
  )
    process.exitCode = 1;
}
