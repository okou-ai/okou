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
const gateValidation = steps(gate).find((step) =>
  step.startsWith("        name: Validate CI results\n"),
);
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

test("API readiness is required before publishing the Worker preview URL", () => {
  const names = [
    "Deploy API to Vercel",
    "Check API health",
    "Create API Vercel Alias",
    contractName,
    workerName,
    "Post API preview URL",
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
    assert.doesNotMatch(
      stepNamed(name),
      /^        continue-on-error: (?!false\s*$)/m,
    );
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
  for (const event of ["pull_request", "merge_group", "push"]) {
    const data = {
      ...context(event),
      steps: {
        "api-alias": {
          outputs: { url: "https://staging-api.preview.example" },
        },
        "api-deploy": { outputs: { url: "https://comparison.vercel.app" } },
        "api-worker": { outputs: { url: "https://tested.workers.dev" } },
      },
    };
    assert.equal(
      render(field(deploy, "preview-url", 6), data),
      event === "push"
        ? "https://staging-api.preview.example"
        : "https://tested.workers.dev",
    );
    if (event !== "push") {
      data.steps["api-worker"].outputs.url = "";
      assert.equal(
        render(field(deploy, "preview-url", 6), data),
        "",
        `${event} must not fall back to Vercel`,
      );
    }
  }
  assert.equal(
    field(deploy, "worker-deployment-id", 6),
    "${{ steps.api-worker.outputs.deployment-id }}",
  );
  assert.equal(field(stepNamed(workerName), "id", 8), "api-worker");
  assert.match(
    stepNamed("Post API preview URL"),
    /API preview: \$\{\{ steps.api-worker.outputs.url \}\}/,
  );
});

test("Worker validation covers same-repository PRs, merge groups and main pushes", () => {
  for (const name of [contractName, workerName]) {
    const step = stepNamed(name);
    assert.match(step, /^        if: (?:\||>-)\n/m);
    const condition = field(step, "if", 8);
    for (const [event, sameRepo, expected] of [
      ["pull_request", true, true],
      ["pull_request", false, false],
      ["push", true, true],
      ["merge_group", true, true],
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
    "EXPECTED_SOURCE_SHA: ${{ github.sha }}",
    "EXPECTED_MERGE_GROUP_REF: ${{ github.event.merge_group.head_ref }}",
    "API_PREVIEW_URL: ${{ format('https://okou-api-preview-{0}.{1}.workers.dev', needs.prepare.outputs.job-ref, vars.CF_WORKERS_SUBDOMAIN) }}",
    "CF_WORKERS_SUBDOMAIN: ${{ vars.CF_WORKERS_SUBDOMAIN }}",
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

test("API callers consume the selected preview and callbacks use the same origin", () => {
  for (const [job, key] of [
    ["cli-e2e-02-browser", "OKOU_API_BACKEND_URL"],
    ["cli-e2e-02-playwright", "OKOU_API_BACKEND_URL"],
    ["cli-e2e-03-runner-prepare", "OKOU_API_BACKEND_URL"],
    ["deploy-runner-start", "RUNNER_API_URL"],
  ]) {
    assert.equal(
      field(turboJobs[job], key, 10),
      "${{ needs.deploy-api.outputs.preview-url }}",
      job,
    );
  }
  for (const name of [
    "Resolve API seed environment",
    "Resolve API deploy environment",
  ]) {
    const resolver = stepNamed(name);
    for (const key of ["web-url", "api-backend-url"])
      assert.equal(
        field(resolver, key, 10),
        "${{ needs.prepare.outputs.api-preview-url }}",
        `${name}/${key}`,
      );
  }
  assert.equal(
    field(turboJobs["deploy-stripe-listener"], "API_PREVIEW_URL", 10),
    "${{ needs.prepare.outputs.api-preview-url }}",
  );
  assert.deepEqual(dependencies(turboJobs["cli-e2e-01-serial"]), [
    "prepare",
    "prepare-cli",
  ]);
});

test("preview preparation routes PRs to Workers and retains the staging callback origin", () => {
  const preparation = steps(turboJobs.prepare).find((step) =>
    step.includes("        id: preview-urls\n"),
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "worker-preview-urls-"),
  );
  try {
    for (const [jobRef, domain, expected] of [
      [
        "pr-123",
        "",
        "https://okou-api-preview-pr-123.example-team.workers.dev",
      ],
      ["staging", "preview.example", "https://staging-api.preview.example"],
    ]) {
      const outputFile = path.join(directory, jobRef);
      const script = render(field(preparation, "run", 8), {
        steps: { "set-job-ref": { outputs: { "job-ref": jobRef } } },
        vars: { CF_WORKERS_SUBDOMAIN: "example-team", PREVIEW_DOMAIN: domain },
      });
      const result = spawnSync("bash", ["-eu", "-c", script], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputFile },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        fs
          .readFileSync(outputFile, "utf8")
          .split("\n")
          .includes(`api-url=${expected}`),
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
  const script = field(gateValidation, "run", 8);
  const envKeys = [...gateValidation.matchAll(/^          (\w+): /gm)].map(
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
        envKeys.map((key) => [
          key,
          render(field(gateValidation, key, 10), data),
        ]),
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

test("selected deployed journeys fail the gate on failures, cancellation or unexpected skips", () => {
  const script = field(gateValidation, "run", 8);
  const envKeys = [...gateValidation.matchAll(/^          (\w+): /gm)].map(
    ([, key]) => key,
  );
  for (const event of ["pull_request", "merge_group"]) {
    for (const job of [
      "deploy-api",
      "deploy-stripe-listener",
      "cli-e2e-02-browser",
      "cli-e2e-02-playwright",
      "cli-e2e-03-runner-prepare",
      "cli-e2e-03-runner-bootstrap",
      "cli-e2e-03-runner",
      "deploy-runner-prepare",
      "deploy-runner-start",
    ]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const data = context(event);
        data.needs["detect-release"].outputs.skip = "false";
        Object.assign(data.needs.prepare.outputs, {
          "ci-changed": "true",
          "turbo-runner-consumer-needed": "true",
          "playwright-runner-consumer-needed": "true",
        });
        data.needs[job].result = result;
        const env = Object.fromEntries(
          envKeys.map((key) => [
            key,
            render(field(gateValidation, key, 10), data),
          ]),
        );
        const output = spawnSync("bash", ["-eu", "-c", render(script, data)], {
          encoding: "utf8",
          env: { ...process.env, ...env },
        });
        assert.equal(
          output.status,
          1,
          `${event}/${job}/${result}\n${output.stdout}\n${output.stderr}`,
        );
        assert.ok(output.stdout.includes(`::error::${job}:`));
      }
    }
  }
});

test("PR and merge-group gates verify the same Worker deployment after E2E", () => {
  const gateSteps = steps(gate);
  const verify = gateSteps.find((step) =>
    step.includes("        name: Verify API Worker deployment after E2E\n"),
  );
  const checkout = gateSteps.find((step) =>
    step.includes("        name: Check out the tested API Worker source\n"),
  );
  assert.ok(gateSteps.indexOf(gateValidation) < gateSteps.indexOf(checkout));
  assert.ok(gateSteps.indexOf(checkout) < gateSteps.indexOf(verify));
  assert.equal(field(checkout, "ref", 10), "${{ github.sha }}");
  for (const step of [checkout, verify]) {
    for (const [event, expected] of [
      ["pull_request", true],
      ["merge_group", true],
      ["push", false],
    ]) {
      const data = context(event);
      assert.equal(evaluate(field(step, "if", 8), data), expected);
      data.needs["deploy-api"].result = "skipped";
      assert.equal(evaluate(field(step, "if", 8), data), false);
    }
  }
  assert.equal(field(verify, "EXPECTED_SOURCE_SHA", 10), "${{ github.sha }}");
  assert.equal(
    field(verify, "EXPECTED_DEPLOYMENT_ID", 10),
    "${{ needs.deploy-api.outputs.worker-deployment-id }}",
  );
  assert.equal(
    field(verify, "run", 8).trim(),
    "node .github/scripts/api-worker-preview.cjs verify",
  );
});
