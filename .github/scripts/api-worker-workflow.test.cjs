// Offline workflow contract checks; no credentials, network, or deploys.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const root = path.resolve(__dirname, "../..");
const read = (name) =>
  fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");
const turbo = read("turbo.yml");
const cleanupWorkflow = read("cleanup.yml");

// Select YAML jobs/fields by their indentation, not comments or step labels.
function jobs(source) {
  return Object.fromEntries(
    [
      ...source.matchAll(
        /^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm,
      ),
    ].map(([, name, body]) => [name, body]),
  );
}
function field(source, key, indent = 4) {
  const match = source.match(
    new RegExp(
      `^ {${indent}}${key}: ([^\\n]*)(?:\\n((?: {${indent + 2},}[^\\n]*\\n|\\n)*))?`,
      "m",
    ),
  );
  assert.ok(match, `Missing ${key}`);
  return ["|", ">-"].includes(match[1])
    ? match[2]
        .split("\n")
        .map((line) => line.slice(indent + 2))
        .join("\n")
    : match[1];
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
const turboJobs = jobs(turbo);
const deploy = turboJobs["deploy-api-worker"];
const cleanupJobs = jobs(cleanupWorkflow);
const cleanup = cleanupJobs["cleanup-api-worker"];
const gate = turboJobs["ci-gate-turbo"];

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

test("Worker follows shared API setup without becoming an API or E2E dependency", () => {
  assert.deepEqual(dependencies(deploy), ["prepare", "deploy-api"]);
  assert.ok(dependencies(gate).includes("deploy-api-worker"));
  // Only the required gate may depend on Worker. This also prevents indirect
  // Worker failure/cancellation from skipping existing E2E consumers.
  for (const [name, job] of Object.entries(turboJobs)) {
    if (name !== "ci-gate-turbo") {
      assert.ok(!dependencies(job).includes("deploy-api-worker"), name);
    }
  }
  for (const name of [
    "cli-e2e-02-browser",
    "cli-e2e-02-playwright",
    "cli-e2e-03-runner-prepare",
  ]) {
    assert.ok(dependencies(turboJobs[name]).includes("deploy-api"), name);
  }
  assert.match(
    turboJobs["deploy-api"],
    /neon-preview-branch\.sh branch "preview\//,
  );
  assert.match(turboJobs["deploy-api"], /db:migrate/);
  assert.match(turboJobs["deploy-api"], /db:dev-seed/);
});

test("Worker eligibility is same-repo PR or main staging, never merge queue", () => {
  const condition = field(deploy, "if");
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
      event,
    );
  }
  const nonMain = context("push");
  nonMain.github.ref = "refs/heads/other";
  assert.equal(evaluate(condition, nonMain), false);
});

test("Worker owns its setup and uses prepare URLs without changing consumers", () => {
  assert.match(deploy, /ref: \$\{\{ github.sha \}\}/);
  for (const action of ["toolchain-init", "web-api-env"]) {
    assert.ok(deploy.includes(`uses: ./.github/actions/${action}`));
  }
  assert.match(deploy, /doppler-project: vm0\n\s+doppler-config: dev/);
  for (const [input, output] of [
    ["job-ref", "job-ref"],
    ["web-url", "api-preview-url"],
    ["app-url", "app-preview-url"],
    ["api-backend-url", "api-preview-url"],
  ]) {
    assert.ok(
      deploy.includes(`${input}: \${{ needs.prepare.outputs.${output} }}`),
    );
  }
  for (const binding of [
    "JOB_REF: ${{ needs.prepare.outputs.job-ref }}",
    "API_ENV_FILE: ${{ steps.api-env.outputs.file }}",
    "EXPECTED_PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    "NEON_API_KEY: ${{ secrets.NEON_API_KEY }}",
    "NEON_PROJECT_ID: ${{ vars.NEON_PROJECT_ID }}",
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}",
    "CLOUDFLARE_ACCOUNT_ID: ${{ vars.CF_ACCOUNT_ID }}",
    "GH_TOKEN: ${{ github.token }}",
  ]) {
    assert.ok(deploy.includes(binding), binding);
  }
  assert.match(deploy, /node \.github\/scripts\/api-worker-preview.cjs deploy/);
  assert.doesNotMatch(deploy, /neon-preview-branch\.sh|db:migrate|db:dev-seed/);
  assert.match(deploy, /if: always\(\)[\s\S]*rm -f -- "\$API_ENV_FILE"/);
});

test("deploy and trusted cleanup share a non-cancelling per-preview lock", () => {
  const deployLock = deploy.match(
    /    concurrency:\n([\s\S]*?)    runs-on:/,
  )[1];
  const cleanupLock = cleanup.match(
    /    concurrency:\n([\s\S]*?)    steps:/,
  )[1];
  assert.match(
    deployLock,
    /group: deploy-api-worker-\$\{\{ needs.prepare.outputs.job-ref \}\}/,
  );
  assert.match(
    cleanupLock,
    /group: deploy-api-worker-pr-\$\{\{ github.event.pull_request.number \}\}/,
  );
  for (const lock of [deployLock, cleanupLock]) {
    assert.match(lock, /cancel-in-progress: false/);
  }
  // A job-level lock does not make its cancellable parent immune to supersession.
  assert.match(
    turbo,
    /^  cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/m,
  );
});

test("closed same-repo PR cleanup uses trusted code and leaves shared DB ownership intact", () => {
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
  assert.match(
    cleanup,
    /permissions:\n      contents: read\n      pull-requests: read/,
  );
  const cleanupEnv = cleanup
    .split("        env:\n")[1]
    .split("        run:")[0];
  assert.deepEqual(
    [...cleanupEnv.matchAll(/^          (\w+):/gm)]
      .map(([, name]) => name)
      .sort(),
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "GH_TOKEN", "JOB_REF"],
  );
  assert.match(
    cleanupEnv,
    /JOB_REF: pr-\$\{\{ github.event.pull_request.number \}\}/,
  );
  assert.match(
    cleanup,
    /node \.github\/scripts\/api-worker-preview.cjs cleanup/,
  );
  assert.match(
    cleanupJobs["cleanup-database"],
    /uses: \.\/\.github\/actions\/neon-branch/,
  );
  assert.match(cleanupJobs["cleanup-database"], /action: "cleanup"/);
});

test("actual gate shell rejects Worker failures, cancellation and unexpected skips", () => {
  assert.match(gate, /^    if: always\(\)/m);
  const script = field(gate, "run", 8);
  const expectedExpression = field(gate, "API_WORKER_EXPECTED", 10)
    .trim()
    .slice(3, -2);
  for (const [event, result, expectedStatus] of [
    ["pull_request", "success", 0],
    ["pull_request", "failure", 1],
    ["pull_request", "cancelled", 1],
    ["pull_request", "skipped", 1],
    ["push", "failure", 1],
    ["merge_group", "skipped", 0],
  ]) {
    const data = context(event);
    data.needs["deploy-api-worker"].result = result;
    const rendered = script.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
      String(evaluate(expression, data) ?? ""),
    );
    const output = spawnSync("bash", ["-eu", "-c", rendered], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI_ADMISSION_RESULT: "success",
        EVENT_NAME: event,
        IS_RELEASE: "false",
        API_WORKER_EXPECTED: String(evaluate(expectedExpression, data)),
      },
    });
    assert.equal(
      output.status,
      expectedStatus,
      `${event}/${result}\n${output.stdout}\n${output.stderr}`,
    );
    if (expectedStatus !== 0) {
      assert.match(output.stdout, /::error::deploy-api-worker:/);
    }
  }
});
