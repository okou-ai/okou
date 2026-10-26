// Offline workflow contract checks; no credentials, network, or deploys.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const root = path.resolve(__dirname, "../..");
const read = (name) =>
  fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");
const turbo = read("turbo.yml");
const cleanupWorkflow = read("cleanup.yml");

// Select YAML jobs, steps and fields by indentation, not comments.
function jobs(source) {
  return Object.fromEntries(
    [
      ...source.matchAll(
        /^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm,
      ),
    ].map(([, name, body]) => [name, body]),
  );
}
function steps(job) {
  return [
    ...job.matchAll(/^      - ([\s\S]*?)(?=^      - |$(?![\s\S]))/gm),
  ].map(([, body]) => `        ${body}`);
}
function field(source, key, indent = 4) {
  const lines = source.split("\n");
  const prefix = `${" ".repeat(indent)}${key}: `;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  assert.ok(index >= 0, `Missing ${key}`);
  const value = lines[index].slice(prefix.length);
  if (!["|", ">-"].includes(value)) return value;
  const body = [];
  const bodyPrefix = " ".repeat(indent + 2);
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && !line.startsWith(bodyPrefix)) break;
    body.push(line.slice(indent + 2));
  }
  return body.join("\n");
}
function dependencies(job) {
  const inline = job.match(/^    needs: \[([^\]]+)\]/m);
  if (inline) return inline[1].split(/,\s*/);
  return [
    ...(job.match(/^    needs:\n((?:      - [\w-]+\n)+)/m)?.[1] || "").matchAll(
      /- ([\w-]+)/g,
    ),
  ].map(([, name]) => name);
}
function evaluate(expression, context) {
  // GitHub permits hyphens in property names; JavaScript needs bracket access.
  return runInNewContext(
    expression.replace(/\.([\w]+(?:-[\w]+)+)/g, '["$1"]'),
    context,
  );
}
function render(source, data) {
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
    String(evaluate(expression, data) ?? ""),
  );
}
const turboJobs = jobs(turbo);
const deploy = turboJobs["deploy-api"];
const deploySteps = steps(deploy);
const cleanupJobs = jobs(cleanupWorkflow);
const cleanup = cleanupJobs["cleanup-api-worker"];
const gate = turboJobs["ci-gate-turbo"];
const contractName = "Check Worker deployment contracts and secret handling";
const workerName =
  "Build and deploy API Worker using the shared preview database";
// Not every setup step has a name.
function stepNamed(name) {
  const matches = deploySteps.filter((step) =>
    step.startsWith(`        name: ${name}\n`),
  );
  assert.equal(matches.length, 1, name);
  return matches[0];
}
function context(event = "pull_request", sameRepo = true) {
  const needs = Object.fromEntries(
    dependencies(gate).map((name) => [
      name,
      { result: "success", outputs: {} },
    ]),
  );
  needs.prepare.outputs["job-ref"] = event === "push" ? "staging" : "pr-123";
  return {
    needs,
    steps: { "api-worker-checks": { outcome: "success" } },
    github: {
      event_name: event,
      ref: "refs/heads/main",
      repository: "okou-ai/okou",
      actor: "maintainer",
      event: {
        action: "closed",
        pull_request: {
          head: {
            repo: { full_name: sameRepo ? "okou-ai/okou" : "fork/okou" },
          },
        },
      },
    },
  };
}

test("API job keeps auxiliary Worker steps non-blocking after Vercel deployment", () => {
  const names = [
    "Deploy API to Vercel",
    "Check API health",
    "Create API Vercel Alias",
    "Post API preview URL",
    contractName,
    workerName,
  ];
  const indices = names.map((name) => deploySteps.indexOf(stepNamed(name)));
  assert.deepEqual(
    indices,
    [...indices].sort((a, b) => a - b),
  );
  for (const name of [contractName, workerName]) {
    const owners = Object.entries(turboJobs).flatMap(([jobName, job]) =>
      steps(job)
        .filter((step) => step.startsWith(`        name: ${name}\n`))
        .map(() => jobName),
    );
    assert.deepEqual(owners, ["deploy-api"], name);
    assert.equal(field(stepNamed(name), "continue-on-error", 8), "true");
  }
  assert.doesNotMatch(deploy, /^    continue-on-error: (?!false\s*$)/m);
  assert.match(
    stepNamed(contractName),
    /node --test .*api-worker-workflow\.test\.cjs .*api-worker-preview\.test\.cjs/,
  );
  assert.match(
    stepNamed(contractName),
    /pnpm --dir turbo\/apps\/api test:worker-build/,
  );
  const executionOwners = Object.entries(turboJobs).flatMap(([name, job]) =>
    steps(job)
      .filter((step) =>
        step.includes("node .github/scripts/api-worker-preview.cjs deploy"),
      )
      .map(() => name),
  );
  assert.deepEqual(executionOwners, ["deploy-api"]);
});

test("production release keeps Worker deployment non-blocking and verifies its deployed revision", () => {
  const production = jobs(read("release-please.yml"))["promote-api-production"];
  const productionSteps = steps(production);
  const byId = (id) => {
    const matches = productionSteps.filter((step) =>
      step.includes(`        id: ${id}\n`),
    );
    assert.equal(matches.length, 1, id);
    return matches[0];
  };
  const worker = byId("api-worker-deploy");
  const verify = byId("api-worker-verify");
  assert.equal(field(production, "environment"), "production");
  assert.match(
    production,
    /ref: \$\{\{ needs.release-please.outputs.release_target \}\}/,
  );
  assert.doesNotMatch(production, /^    continue-on-error: (?!false\s*$)/m);
  assert.doesNotMatch(byId("deploy"), /^        continue-on-error: true/m);
  for (const id of [
    "api-worker-checks",
    "api-worker-deploy",
    "api-worker-verify",
  ]) {
    const step = byId(id);
    assert.equal(field(step, "continue-on-error", 8), "true");
    assert.ok(
      productionSteps.indexOf(step) > productionSteps.indexOf(byId("deploy")),
    );
  }
  assert.equal(
    field(worker, "API_ENV_FILE", 10),
    "${{ steps.api-production-env.outputs.file }}",
  );
  for (const name of [
    "CERTIFICATE_ID",
    "CERTIFICATE_CHAIN",
    "WORKLOAD_IDENTITY_PROVIDER",
  ]) {
    const data = {
      vars: {
        [`CF_API_GCP_MTLS_${name}_PRODUCTION`]: `production-${name}`,
        [`CF_API_GCP_MTLS_${name}_PREVIEW`]: `preview-${name}`,
        [`CF_API_GCP_MTLS_${name}_STAGING`]: `staging-${name}`,
      },
    };
    assert.equal(
      render(field(worker, `GCP_MTLS_${name}`, 10), data),
      `production-${name}`,
    );
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "api-worker-release-"),
  );
  try {
    const sha = "4".repeat(40);
    const url = "https://okou-api-production.example.workers.dev";
    // The external HTTP boundary returns a healthy Worker at the uploaded SHA.
    fs.writeFileSync(
      path.join(directory, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${!#}" >> "$REQUESTS_FILE"
case "\${!#}" in
  "$WORKER_URL/health") printf '%s\\n' '{"status":"ok"}' ;;
  "$WORKER_URL/api/build-info") printf '{"commitSha":"%s"}\\n' "$FIXTURE_SHA" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    const data = {
      steps: {
        "api-worker-deploy": {
          outputs: { "worker-url": url, "source-sha": sha },
        },
      },
    };
    const requests = path.join(directory, "requests");
    const summary = path.join(directory, "summary");
    const result = spawnSync("bash", ["-eu", "-c", field(verify, "run", 8)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        WORKER_URL: render(field(verify, "WORKER_URL", 10), data),
        EXPECTED_SOURCE_SHA: render(
          field(verify, "EXPECTED_SOURCE_SHA", 10),
          data,
        ),
        FIXTURE_SHA: sha,
        REQUESTS_FILE: requests,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(requests, "utf8").trim().split("\n"), [
      `${url}/health`,
      `${url}/api/build-info`,
    ]);
    assert.ok(fs.readFileSync(summary, "utf8").includes(sha));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("both Worker steps run only for same-repository PRs and main pushes", () => {
  for (const name of [contractName, workerName]) {
    const step = stepNamed(name);
    assert.match(step, /^        if: (?:\||>-)\n/m);
    const condition = field(step, "if", 8);
    for (const [event, sameRepo, expected] of [
      ["pull_request", true, true],
      ["pull_request", false, false],
      ["push", true, true],
      ["merge_group", true, false],
      ["workflow_dispatch", true, false],
    ]) {
      assert.equal(
        evaluate(condition, context(event, sameRepo)),
        expected,
        `${name}/${event}/${sameRepo}`,
      );
    }
    const nonMain = context("push");
    nonMain.github.ref = "refs/heads/other";
    assert.equal(evaluate(condition, nonMain), false, name);
  }
  const deployCondition = field(stepNamed(workerName), "if", 8);
  for (const outcome of ["failure", "skipped", "cancelled"]) {
    const data = context();
    data.steps["api-worker-checks"].outcome = outcome;
    assert.equal(evaluate(deployCondition, data), false, outcome);
  }
});

test("Worker reuses API setup, environment and sole shared database owner", () => {
  for (const action of [
    "actions/checkout@",
    "./.github/actions/toolchain-init",
    "dopplerhq/secrets-fetch-action@",
  ]) {
    assert.equal(
      deploySteps.filter((step) => step.includes(`uses: ${action}`)).length,
      1,
      action,
    );
  }
  const resolvers = deploySteps.filter((step) =>
    step.includes("uses: ./.github/actions/web-api-env"),
  );
  assert.deepEqual(
    resolvers.map((step) => field(step, "id", 8)),
    ["api-seed-env", "api-deploy-env"],
  );
  assert.match(deploy, /ref: \$\{\{ github.sha \}\}/);
  assert.match(deploy, /doppler-project: vm0\n\s+doppler-config: dev/);
  for (const resolver of resolvers) {
    assert.ok(
      resolver.includes(
        "DOPPLER_SECRETS_JSON: ${{ toJSON(steps.doppler-oauth.outputs) }}",
      ),
    );
  }
  const databaseOwners = Object.entries(turboJobs).filter(([, job]) =>
    job.includes('neon-preview-branch.sh branch "preview/'),
  );
  assert.deepEqual(
    databaseOwners.map(([name]) => name),
    ["deploy-api"],
  );
  const databaseStep = stepNamed("Create Neon Branch");
  assert.match(databaseStep, /db:migrate/);
  assert.match(databaseStep, /db:dev-seed/);
  assert.match(
    resolvers[1],
    /database-url: \$\{\{ steps.neon.outputs.database-url \}\}/,
  );
  const worker = stepNamed(workerName);
  assert.ok(
    worker.includes("API_ENV_FILE: ${{ steps.api-deploy-env.outputs.file }}"),
  );
  assert.ok(
    stepNamed("Deploy API to Vercel").includes(
      "environment-file: ${{ steps.api-deploy-env.outputs.file }}",
    ),
  );
  for (const binding of [
    "JOB_REF: ${{ needs.prepare.outputs.job-ref }}",
    "EXPECTED_PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    "NEON_API_KEY: ${{ secrets.NEON_API_KEY }}",
    "NEON_PROJECT_ID: ${{ vars.NEON_PROJECT_ID }}",
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}",
    "CLOUDFLARE_ACCOUNT_ID: ${{ vars.CF_ACCOUNT_ID }}",
    "GH_TOKEN: ${{ github.token }}",
  ])
    assert.ok(worker.includes(binding), binding);
  assert.match(
    worker,
    /run: node \.github\/scripts\/api-worker-preview\.cjs deploy/,
  );
});

test("existing E2E consumers wait for the complete API job", () => {
  assert.deepEqual(dependencies(deploy), ["prepare"]);
  for (const [name, expected] of [
    ["cli-e2e-02-browser", ["prepare", "deploy-api", "deploy-app"]],
    [
      "cli-e2e-02-playwright",
      ["prepare", "deploy-api", "deploy-app", "deploy-runner-start"],
    ],
    [
      "cli-e2e-03-runner-prepare",
      ["prepare", "deploy-api", "deploy-app", "deploy-stripe-listener"],
    ],
  ]) {
    assert.deepEqual(dependencies(turboJobs[name]), expected, name);
    assert.match(turboJobs[name], /needs.deploy-api.result == 'success'/);
  }
});

test("PR and staging Workers select their configured Google identities", () => {
  const worker = stepNamed(workerName);
  for (const name of [
    "CERTIFICATE_ID",
    "CERTIFICATE_CHAIN",
    "WORKLOAD_IDENTITY_PROVIDER",
  ]) {
    const expression = field(worker, `GCP_MTLS_${name}`, 10);
    const vars = {
      [`CF_API_GCP_MTLS_${name}_PREVIEW`]: `preview-${name}`,
      [`CF_API_GCP_MTLS_${name}_STAGING`]: `staging-${name}`,
    };
    const data = {
      ...context(),
      vars,
      format: (pattern, target) => pattern.replace("{0}", target),
    };
    assert.equal(render(expression, data), `preview-${name}`);
    data.needs.prepare.outputs["job-ref"] = "staging";
    assert.equal(render(expression, data), `staging-${name}`);
  }
});

test("API temporary environment cleanup always removes both owned files", () => {
  const removal = deploySteps.at(-1);
  assert.equal(field(removal, "if", 8), "always()");
  assert.equal(
    field(removal, "API_ENV_FILE", 10),
    "${{ steps.api-deploy-env.outputs.file }}",
  );
  assert.equal(
    field(removal, "API_SEED_ENV_FILE", 10),
    "${{ steps.api-seed-env.outputs.file }}",
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "api-worker-workflow-"),
  );
  try {
    const env = {
      ...process.env,
      API_ENV_FILE: path.join(directory, "deploy env"),
      API_SEED_ENV_FILE: path.join(directory, "seed env"),
    };
    for (const file of [env.API_ENV_FILE, env.API_SEED_ENV_FILE])
      fs.writeFileSync(file, "temporary");
    const output = spawnSync("bash", ["-eu", "-c", field(removal, "run", 8)], {
      env,
      encoding: "utf8",
    });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("trusted closed-PR cleanup shares the API preview lock without database credentials", () => {
  assert.equal(
    field(deploy, "group", 6),
    "deploy-api-${{ needs.prepare.outputs.job-ref }}",
  );
  assert.equal(field(deploy, "cancel-in-progress", 6), "true");
  assert.equal(
    field(cleanup, "group", 6),
    "deploy-api-pr-${{ github.event.pull_request.number }}",
  );
  assert.equal(field(cleanup, "cancel-in-progress", 6), "false");
  assert.match(
    cleanupWorkflow,
    /pull_request_target:\n\s+types: \[closed, reopened\]/,
  );
  const condition = field(cleanup, "if");
  const closed = context("pull_request_target");
  assert.equal(evaluate(condition, closed), true);
  closed.github.event.action = "reopened";
  assert.equal(evaluate(condition, closed), false);
  assert.equal(
    evaluate(condition, context("pull_request_target", false)),
    false,
  );
  assert.equal(evaluate(condition, context("pull_request")), false);
  assert.match(
    cleanup,
    /ref: \$\{\{ github.event.repository.default_branch \}\}/,
  );
  assert.match(cleanup, /persist-credentials: false/);
  const permissionLines = cleanup
    .split("    permissions:\n")[1]
    .split("    concurrency:")[0]
    .trim();
  assert.equal(permissionLines, "contents: read\n      pull-requests: read");
  const cleanupEnv = cleanup
    .split("        env:\n")[1]
    .split("        run:")[0];
  assert.deepEqual(
    [...cleanupEnv.matchAll(/^          (\w+):/gm)]
      .map(([, name]) => name)
      .sort(),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GH_TOKEN", "JOB_REF"],
  );
  assert.doesNotMatch(cleanup, /NEON_API_KEY|NEON_PROJECT_ID/);
  assert.match(
    cleanupEnv,
    /JOB_REF: pr-\$\{\{ github.event.pull_request.number \}\}/,
  );
  assert.match(
    cleanup,
    /node \.github\/scripts\/api-worker-preview.cjs cleanup/,
  );
  const databaseCleanupOwners = Object.entries(cleanupJobs).filter(([, job]) =>
    job.includes("uses: ./.github/actions/neon-branch"),
  );
  assert.deepEqual(
    databaseCleanupOwners.map(([name]) => name),
    ["cleanup-database"],
  );
  assert.match(cleanupJobs["cleanup-database"], /action: "cleanup"/);
});

test("actual gate shell propagates API job failure and cancellation, retaining allowed skips", () => {
  assert.match(gate, /^    if: always\(\)/m);
  assert.ok(dependencies(gate).includes("deploy-api"));
  const script = field(gate, "run", 8);
  const envKeys = [...gate.matchAll(/^          (\w+): /gm)].map(
    ([, key]) => key,
  );
  for (const event of ["pull_request", "merge_group", "push"]) {
    for (const [result, expectedStatus] of [
      ["success", 0],
      ["failure", 1],
      ["cancelled", 1],
      ["skipped", 0],
    ]) {
      const data = context(event);
      data.needs["deploy-api"].result = result;
      data.needs["detect-release"].outputs.skip = "false";
      const env = Object.fromEntries(
        envKeys.map((key) => [key, render(field(gate, key, 10), data)]),
      );
      const output = spawnSync("bash", ["-eu", "-c", render(script, data)], {
        encoding: "utf8",
        env: { ...process.env, ...env },
      });
      assert.equal(
        output.status,
        expectedStatus,
        `${event}/${result}\n${output.stdout}\n${output.stderr}`,
      );
      if (expectedStatus !== 0)
        assert.match(output.stdout, /::error::deploy-api:/);
    }
  }
});
