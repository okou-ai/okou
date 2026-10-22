// Offline workflow contract checks; no credentials, network, or deploys.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (name) =>
  fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");
const workflow = read("deploy-api-worker.yml");
const changes = workflow
  .split("\n  changes:\n")[1]
  .split("\n  deploy-api-worker:\n")[0];
const deploy = workflow
  .split("\n  deploy-api-worker:\n")[1]
  .split("\n  cleanup-api-worker:\n")[0];
const cleanup = workflow.split("\n  cleanup-api-worker:\n")[1];

function previewUrls(source) {
  return source
    .split("        id: preview-urls\n        run: |\n")[1]
    .split(/\n(?:\S| {2,6}\S)/)[0]
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

test("dedicated workflow owns one non-cancelling PR/staging lock", () => {
  assert.match(
    workflow,
    /^concurrency:\n  group: deploy-api-worker-\$\{\{ github.event_name == 'pull_request' && format\('pr-\{0\}', github.event.pull_request.number\) \|\| 'staging' \}\}\n  cancel-in-progress: false$/m,
  );
  assert.equal((workflow.match(/^\s*concurrency:/gm) || []).length, 1);
  assert.doesNotMatch(workflow, /^\s+(needs|uses): .*turbo\.yml/m);
  assert.doesNotMatch(read("turbo.yml"), /^  deploy-api-worker:/m);
  assert.doesNotMatch(read("cleanup.yml"), /^  cleanup-api-worker:/m);
});

test("all PR lifecycle events are unfiltered; main paths exclude merge queue", () => {
  const triggers = workflow.split("\non:\n")[1].split("\nconcurrency:")[0];
  const pr = triggers.split("  pull_request:\n")[1].split("  push:\n")[0];
  assert.match(pr, /types: \[opened, synchronize, reopened, closed\]/);
  assert.doesNotMatch(pr, /paths|branches/);
  assert.match(triggers, /branches: \[main\]/);
  for (const glob of [
    ".github/**",
    "turbo/apps/api/**",
    "turbo/packages/**",
    "turbo/pnpm-lock.yaml",
  ]) {
    assert.ok(triggers.includes(`- "${glob}"`));
  }
  assert.doesNotMatch(triggers, /^  (merge_group|schedule|workflow_call):/m);
  for (const job of [changes, cleanup]) {
    assert.match(
      job,
      /github.event.pull_request.head.repo.full_name == github.repository/,
    );
  }
  assert.match(changes, /github.event.action != 'closed'/);
  assert.match(changes, /github.rest.pulls.listFiles/);
  assert.match(deploy, /needs: \[changes\]/);
  assert.match(deploy, /needs.changes.outputs.deploy == 'true'/);
  assert.match(cleanup, /github.event.action == 'closed'/);
});

test("deploy uses captured revision and shared resolver; cleanup uses trusted code", () => {
  assert.match(deploy, /ref: \$\{\{ github.sha \}\}/);
  for (const action of ["toolchain-init", "web-api-env"]) {
    assert.ok(deploy.includes(`uses: ./.github/actions/${action}`));
  }
  assert.match(deploy, /doppler-project: vm0\n\s+doppler-config: dev/);
  assert.match(deploy, /API_ENV_FILE: \$\{\{ steps.api-env.outputs.file \}\}/);
  assert.match(deploy, /node \.github\/scripts\/api-worker-preview.cjs deploy/);
  assert.match(
    cleanup,
    /ref: \$\{\{ github.event.repository.default_branch \}\}/,
  );
  assert.match(cleanup, /persist-credentials: false/);
  assert.match(
    cleanup,
    /JOB_REF: pr-\$\{\{ github.event.pull_request.number \}\}/,
  );
  assert.match(
    cleanup,
    /node \.github\/scripts\/api-worker-preview.cjs cleanup/,
  );
  assert.doesNotMatch(cleanup, /release-please|paths:|github.sha/);
});

test("preview URL shell is identical to Turbo prepare and works offline", () => {
  const script = previewUrls(workflow);
  assert.equal(script, previewUrls(read("turbo.yml")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-workflow-test-"));
  try {
    for (const ref of ["pr-123", "staging"]) {
      const output = path.join(dir, ref);
      const rendered = script
        .replaceAll("${{ steps.set-job-ref.outputs.job-ref }}", ref)
        .replaceAll("${{ vars.PREVIEW_DOMAIN }}", "preview.example.com")
        .replaceAll("${{ vars.CF_WORKERS_SUBDOMAIN }}", "example");
      execFileSync("bash", ["-eu", "-c", rendered], {
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      const appUrl = execFileSync(
        "bash",
        [".github/scripts/resolve-app-preview-url.sh", ref, "example"],
        { cwd: root, encoding: "utf8" },
      ).trim();
      assert.equal(
        fs.readFileSync(output, "utf8"),
        `app-url=${appUrl}\napi-url=https://${ref}-api.preview.example.com\n`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
