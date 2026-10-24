// Temporary opt-in experiment. Only version uploads; never activate a version.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const BASELINE_REVISION = "197b2bc9d1e88e777dfe0882c503eba06bbb2012";
const BASELINE_HASH =
  "520e49d8695eee198c79a6cc71336197d8d2a5b835153f4fc20b28df0841726d";
const EXPERIMENT_BRANCH = "perf/worker-domain-split";

function enabled(env, ref, mode) {
  if (!env.API_WORKER_STARTUP_BENCH) return false;
  if (
    env.API_WORKER_STARTUP_BENCH !== "workflow-schema-reuse" ||
    mode !== "deploy" ||
    ref !== "pr-42640" ||
    env.GITHUB_EVENT_NAME !== "pull_request" ||
    env.GITHUB_HEAD_REF !== EXPERIMENT_BRANCH
  )
    throw new Error("Startup benchmark is restricted to the experiment PR");
  return true;
}

function loadVariants(directory, deployedBundle, sourceRevision) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.baselineRevision !== BASELINE_REVISION ||
    manifest.sourceRevision !== sourceRevision ||
    !/^[a-f0-9]{40}$/.test(sourceRevision)
  )
    throw new Error("Unexpected startup benchmark source identity");
  const variants = {};
  for (const name of ["baseline", "optimized"]) {
    const item = manifest.variants?.[name];
    if (item?.file !== `${name}/worker.js`)
      throw new Error("Unexpected startup benchmark bundle path");
    const bytes = fs.readFileSync(path.join(directory, item.file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      sha256 !== item.sha256 ||
      bytes.length !== item.bytes ||
      (name === "baseline" && sha256 !== BASELINE_HASH)
    )
      throw new Error("Startup benchmark bundle hash mismatch");
    variants[name] = { bytes, sha256, contractSha256: item.contractSha256 };
  }
  if (!variants.optimized.bytes.equals(fs.readFileSync(deployedBundle)))
    throw new Error("Startup benchmark candidate differs from deployed bundle");
  return {
    variants,
    provenance: {
      sourceTree: /^[a-f0-9]{40}$/.test(manifest.sourceTree)
        ? manifest.sourceTree
        : null,
      lockfileSha256: /^[a-f0-9]{64}$/.test(manifest.lockfileSha256)
        ? manifest.lockfileSha256
        : null,
      trackedWorktreeClean: manifest.trackedWorktreeClean === true,
    },
  };
}

function pairedOrder(rounds, seed) {
  let state = seed || 1;
  const result = [];
  for (let round = 1; round <= rounds; round++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const order =
      state & 1 ? ["baseline", "optimized"] : ["optimized", "baseline"];
    for (const variant of order)
      result.push({ round, variant, sequence: result.length + 1 });
  }
  return result;
}

function existingBindings(settings) {
  const expectedSecrets = [
    "API_ENV_JSON_PARTS",
    "API_ENV_JSON_0",
    "API_ENV_JSON_1",
    "API_ENV_JSON_2",
    "API_ENV_JSON_3",
  ].sort();
  if (
    settings?.compatibility_date !== "2026-09-02" ||
    !isDeepStrictEqual(settings.compatibility_flags, ["nodejs_compat"]) ||
    !Array.isArray(settings.bindings)
  )
    throw new Error(
      "Existing Worker compatibility or bindings do not match the frozen experiment",
    );
  const secrets = settings.bindings.filter(
    (binding) => binding.type === "secret_text",
  );
  const hyperdrive = settings.bindings.filter(
    (binding) => binding.type === "hyperdrive",
  );
  if (
    settings.bindings.length !== 6 ||
    !isDeepStrictEqual(
      secrets.map((binding) => binding.name).sort(),
      expectedSecrets,
    ) ||
    hyperdrive.length !== 1 ||
    hyperdrive[0].name !== "HYPERDRIVE" ||
    hyperdrive[0].id !== "469d16da6a4848e485434be430b1b523"
  )
    throw new Error(
      "Existing Worker binding identities do not match the frozen experiment",
    );
  // Never return provider fields that might contain runtime secret values.
  return settings.bindings
    .map((binding) => ({
      name: binding.name,
      type: binding.type,
      ...(binding.type === "hyperdrive" ? { id: binding.id } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summarize(rows) {
  return Object.fromEntries(
    ["baseline", "optimized"].map((name) => {
      const samples = rows.filter((row) => row.variant === name);
      const times = samples
        .filter((row) => row.status === "success")
        .map((row) => row.startup_time_ms)
        .sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      return [
        name,
        {
          attempts: samples.length,
          successes: times.length,
          startupCpuExceeded: samples.filter(
            (row) => row.status === "startup-cpu-exceeded",
          ).length,
          otherOrUnknown: samples.filter(
            (row) => !["success", "startup-cpu-exceeded"].includes(row.status),
          ).length,
          successfulMedianMs: times.length
            ? times.length % 2
              ? times[middle]
              : (times[middle - 1] + times[middle]) / 2
            : null,
          successfulMinMs: times[0] ?? null,
          successfulMaxMs: times.at(-1) ?? null,
        },
      ];
    }),
  );
}

async function runBenchmark({
  variants,
  sourceRevision,
  config,
  bindings,
  worker,
  account,
  token,
  cf,
  assertCurrentPreview,
  outputDirectory,
  rounds = 15,
  seed = randomBytes(4).readUInt32BE(0),
  provenance = {},
}) {
  if (
    !/^okou-api-preview-pr-[1-9][0-9]*$/.test(worker) ||
    config.name !== worker ||
    config.preview_urls !== false
  )
    throw new Error("Startup benchmark requires an isolated PR preview Worker");
  const resource = `/workers/scripts/${worker}`;
  const urls = await cf("GET", `${resource}/subdomain`);
  if (urls?.previews_enabled !== false)
    throw new Error(
      "Version preview URLs must be disabled before benchmarking",
    );
  // Require an existing Worker; this experiment never bootstraps one.
  const before = await cf("GET", `${resource}/deployments`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const resultsPath = path.join(outputDirectory, "results.json");
  if (fs.existsSync(resultsPath))
    throw new Error("Existing benchmark receipts must not be replayed");
  const rows = [];
  const order = pairedOrder(rounds, seed);
  const identity = {
    baselineRevision: BASELINE_REVISION,
    sourceRevision,
    worker,
    seed,
    rounds,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings,
    ...provenance,
    variants: Object.fromEntries(
      Object.entries(variants).map(([name, item]) => [
        name,
        {
          sha256: item.sha256,
          bytes: item.bytes.length,
          contractSha256: /^[a-f0-9]{64}$/.test(item.contractSha256)
            ? item.contractSha256
            : null,
        },
      ]),
    ),
  };
  const save = () =>
    fs.writeFileSync(
      resultsPath,
      `${JSON.stringify({ ...identity, order, rows }, null, 2)}\n`,
    );
  save();
  const metadata = {
    main_module: "worker.js",
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    bindings: bindings.map(({ name }) => ({ name, type: "inherit" })),
  };
  let deploymentUnchanged = null;
  let settingsIdentityUnchanged = null;
  let completed = false;
  try {
    for (const item of order) {
      await assertCurrentPreview();
      const row = {
        ...item,
        startedAt: new Date().toISOString(),
        status: "pending",
        startup_time_ms: null,
        versionId: null,
      };
      rows.push(row);
      save(); // Retain pending intent before a potentially uncertain upload.
      const form = new FormData();
      form.set(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              ...metadata,
              annotations: {
                "workers/message": `workflow-schema ${sourceRevision} ${seed} ${item.sequence} ${item.variant}`,
              },
            }),
          ],
          { type: "application/json" },
        ),
        "metadata.json",
      );
      form.set(
        "worker.js",
        new Blob([variants[item.variant].bytes], {
          type: "application/javascript+module",
        }),
        "worker.js",
      );
      let response;
      let payload;
      try {
        // Wrangler versions upload internally retries writes; use one fetch so
        // an uncertain response can never cause an automatic second upload.
        response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}${resource}/versions?bindings_inherit=strict`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
            signal: AbortSignal.timeout(120000),
            redirect: "error",
          },
        );
        row.httpStatus = response.status;
        payload = await response.json();
      } catch {
        row.status = "unknown-outcome";
        save();
        throw new Error(
          "Startup upload outcome is unknown; stopped without retry",
        );
      }
      const result = payload?.result;
      row.errorCodes = Array.isArray(payload?.errors)
        ? payload.errors
            .map((error) => error.code)
            .filter(
              (code) => Number.isInteger(code) && code >= 0 && code < 100000000,
            )
            .slice(0, 3)
        : [];
      if (
        response.ok &&
        payload?.success === true &&
        Number.isFinite(result?.startup_time_ms) &&
        result.startup_time_ms >= 0 &&
        /^[a-f0-9-]{36}$/.test(result?.id)
      ) {
        row.status = "success";
        row.startup_time_ms = result.startup_time_ms;
        row.versionId = result.id;
      } else if (
        !response.ok &&
        Array.isArray(payload?.errors) &&
        payload.errors.some(
          (error) =>
            error.code === 10021 &&
            typeof error.message === "string" &&
            error.message.includes("Script startup exceeded CPU time limit"),
        )
      ) {
        row.status = "startup-cpu-exceeded";
      } else {
        row.status = "unexpected-response";
      }
      save();
      console.log(
        `Startup benchmark ${row.sequence}/${order.length} ${row.variant}: ${row.status}${row.startup_time_ms === null ? "" : ` ${row.startup_time_ms} ms`}`,
      );
      if (row.status === "unexpected-response")
        throw new Error(
          "Unexpected startup upload response; stopped without retry",
        );
    }
    completed = true;
  } finally {
    // Both verification reads run even after a rejected/uncertain upload or a
    // failed first verification read. Unknown is never recorded as unchanged.
    try {
      deploymentUnchanged = isDeepStrictEqual(
        before,
        await cf("GET", `${resource}/deployments`),
      );
    } catch {
      deploymentUnchanged = null;
    }
    try {
      const settings = await cf("GET", `${resource}/settings`);
      try {
        settingsIdentityUnchanged =
          settings.compatibility_date === config.compatibility_date &&
          isDeepStrictEqual(
            settings.compatibility_flags,
            config.compatibility_flags,
          ) &&
          isDeepStrictEqual(
            existingBindings(settings),
            [...bindings].sort((a, b) => a.name.localeCompare(b.name)),
          );
      } catch {
        settingsIdentityUnchanged = false;
      }
    } catch {
      settingsIdentityUnchanged = null;
    }
    const paired = {
      bothSucceeded: 0,
      optimizedFaster: 0,
      baselineFaster: 0,
      tied: 0,
    };
    for (let round = 1; round <= rounds; round++) {
      const successful = rows.filter(
        (row) => row.round === round && row.status === "success",
      );
      if (successful.length !== 2) continue;
      paired.bothSucceeded++;
      const baseline = successful.find(
        (row) => row.variant === "baseline",
      ).startup_time_ms;
      const optimized = successful.find(
        (row) => row.variant === "optimized",
      ).startup_time_ms;
      paired[
        optimized < baseline
          ? "optimizedFaster"
          : optimized > baseline
            ? "baselineFaster"
            : "tied"
      ]++;
    }
    const summary = {
      ...identity,
      completed:
        completed &&
        deploymentUnchanged === true &&
        settingsIdentityUnchanged === true,
      uploadsCompleted: completed,
      deploymentUnchanged,
      settingsIdentityUnchanged,
      results: summarize(rows),
      paired,
    };
    fs.writeFileSync(
      path.join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    const lines = [
      "### Full API Worker startup benchmark",
      "",
      `Complete: ${summary.completed}; active deployment unchanged: ${deploymentUnchanged}; compatibility and binding identities unchanged: ${settingsIdentityUnchanged}.`,
      "",
      "| Variant | Successful uploads | CPU rejections | Other/unknown | Successful median (ms) | Range (ms) |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
    ];
    for (const [name, stats] of Object.entries(summary.results))
      lines.push(
        `| ${name} | ${stats.successes}/${stats.attempts} | ${stats.startupCpuExceeded} | ${stats.otherOrUnknown} | ${stats.successfulMedianMs ?? "unavailable"} | ${stats.successfulMinMs ?? "unavailable"}–${stats.successfulMaxMs ?? "unavailable"} |`,
      );
    lines.push(
      "",
      `Both succeeded: ${paired.bothSucceeded} pairs; optimized faster: ${paired.optimizedFaster}; baseline faster: ${paired.baselineFaster}; tied: ${paired.tied}.`,
      "",
      "Only successful uploads provide numeric CPU startup time. Uploads are not guaranteed to bypass Cloudflare compiler caches. No Worker application requests were made.",
      "",
    );
    fs.writeFileSync(
      path.join(outputDirectory, "summary.md"),
      lines.join("\n"),
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
  if (settingsIdentityUnchanged !== true)
    throw new Error(
      "Preview compatibility and binding identities were not confirmed unchanged",
    );
  if (deploymentUnchanged !== true)
    throw new Error("Active preview deployment changed during benchmark");
}

module.exports = {
  enabled,
  loadVariants,
  pairedOrder,
  existingBindings,
  summarize,
  runBenchmark,
};
