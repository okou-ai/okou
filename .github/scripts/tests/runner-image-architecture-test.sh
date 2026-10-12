#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

node - "$REPO_ROOT" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const vm = require("node:vm");
const root = process.argv[2];
const load = name => JSON.parse(execFileSync("yq", ["-o=json", ".",
  path.join(root, ".github/workflows", name)], { encoding: "utf8" }));
const caller = load("runner-image.yml");
const branch = caller.jobs.build;

// This assertion fails against the pre-change production workflow, including
// the mixed hit/miss case where a cached target waited for another compiler.
assert.deepEqual(branch.needs, ["prepare"],
  "image production still waits for the aggregate compiler matrix");
assert.equal(branch.uses, "./.github/workflows/runner-image-architecture.yml");
assert.equal(branch.strategy["fail-fast"], false);
assert.equal(branch.strategy.matrix.include,
  "${{ fromJSON(needs.prepare.outputs.runner-host-groups-matrix) }}");
assert.equal(branch["continue-on-error"], undefined);

const pipeline = load("runner-image-architecture.yml");
const declaration = pipeline.on.workflow_call;
assert.deepEqual(Object.keys(declaration.inputs).sort(), Object.keys(branch.with).sort());
assert.deepEqual(Object.keys(declaration.secrets).sort(), Object.keys(branch.secrets).sort());
const usedSecrets = [...new Set([...JSON.stringify(pipeline.jobs)
  .matchAll(/\bsecrets\.([A-Z0-9_]+)/g)].map(match => match[1]))].sort();
assert.deepEqual(Object.keys(declaration.secrets).sort(), usedSecrets);
assert.notEqual(branch.secrets, "inherit");
assert.equal(declaration.inputs["cache-hit"].type, "boolean");
assert.deepEqual(branch.permissions, { actions: "read", contents: "read" });
assert.equal(branch.with["architecture-json"], "${{ toJSON(matrix) }}");
assert.equal(branch.with["head-sha"], "${{ needs.prepare.outputs.head-sha }}");
assert.equal(branch.with["producer-head-sha"], "${{ needs.prepare.outputs.producer-head-sha }}");
assert.equal(branch.with["job-ref"], "${{ needs.prepare.outputs.job-ref }}");
assert.equal(branch.with["pr-number"], "${{ needs.prepare.outputs.pr-number }}");
assert.equal(branch.with["pr-head-ref"], "${{ needs.prepare.outputs.pr-head-ref }}");
assert.equal(branch.with["cache-hit"],
  "${{ contains(fromJSON(needs.prepare.outputs.runner-binary-hit-targets), matrix.target) }}");
assert.equal(branch.with["cache-reference"],
  "${{ toJSON(fromJSON(needs.prepare.outputs.runner-binary-hit-references)[matrix.target]) }}");
for (const secret of Object.keys(declaration.secrets)) {
  assert.equal(branch.secrets[secret], `\${{ secrets.${secret} }}`);
}

const compile = pipeline.jobs.compile;
const image = pipeline.jobs.build;
assert.equal(compile.needs, undefined);
assert.deepEqual(image.needs, ["compile"]);
for (const job of [compile, image]) {
  assert.equal(job["continue-on-error"], undefined);
  assert.deepEqual(job.permissions, branch.permissions);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.strategy.matrix.include,
    "${{ fromJSON(format('[{0}]', inputs.architecture-json)) }}");
  assert.equal(job.env.RUNNER_BINARY_GIT_REVISION, "${{ inputs.head-sha }}");
  const checkouts = job.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.ref, "${{ inputs.head-sha }}");
}
assert.equal(compile.steps[1].run, ".github/scripts/runner-image-architecture.sh validate");
assert.equal(compile.steps[1].env.RUNNER_IMAGE_ARCHITECTURE, "${{ inputs.architecture-json }}");
assert.equal(compile.steps[1].if, undefined);
assert.equal(compile.steps[1]["continue-on-error"], undefined);
const guard = image.steps.findIndex(step =>
  step.run === ".github/scripts/runner-image-architecture.sh build-ready");
assert.equal(guard, 1, "the image prerequisite guard must follow checkout before other work");
assert.equal(image.steps[guard].env.RUNNER_IMAGE_COMPILE_RESULT, "${{ needs.compile.result }}");
assert.equal(image.steps[guard].env.RUNNER_IMAGE_CACHE_HIT, "${{ inputs.cache-hit }}");
assert.equal(image.steps[guard].env.RUNNER_IMAGE_ARCHITECTURE, "${{ inputs.architecture-json }}");
for (const effect of ["Download private CLI build input", "Download cached runner binary from R2",
  "Download compiled runner binary from R2", "Setup SSH via Cloudflare Tunnel",
  "Provision metal hosts", "Build runner image on all metal hosts", "Upload runner image manifest"]) {
  assert.ok(image.steps.findIndex(step => step.name === effect) > guard, effect);
}
assert.equal(image.steps[guard].if, undefined);
assert.equal(image.steps[guard]["continue-on-error"], undefined);

function evaluate(expression, context) {
  const source = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\b(?:inputs|needs)(?:\.[A-Za-z0-9_-]+)+/g, reference => {
      let value = context;
      for (const key of reference.split(".")) value = value?.[key];
      return JSON.stringify(value ?? "");
    });
  return vm.runInNewContext(source, {
    always: () => true, cancelled: () => context.cancelled,
  }, { timeout: 1000 });
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "runner-image-architecture-"));
try {
  const ssh = path.join(fixture, "ssh");
  fs.writeFileSync(ssh, "#!/usr/bin/env bash\nset -euo pipefail\n" +
    "test \"$1\" = -n; test \"$3\" = uname; test \"$4\" = -m\n" +
    "case \"$2\" in fixture@arm.fixture) echo aarch64;; fixture@x86.fixture) echo x86_64;; *) exit 2;; esac\n",
    { mode: 0o755 });
  const env = { ...process.env, PATH: `${fixture}:${process.env.PATH}`,
    AWS_METAL_RUNNER_HOSTS: "arm.fixture,x86.fixture", METAL_USER: "fixture" };
  const groups = JSON.parse(execFileSync("bash",
    [path.join(root, ".github/scripts/runner-host-architecture-groups.sh"), "matrix"],
    { env, encoding: "utf8" }));
  assert.deepEqual(groups.map(group => group.id), ["arm64", "x86_64"]);
  const validator = path.join(root, ".github/scripts/runner-image-architecture.sh");
  assert.notEqual(spawnSync("bash", [validator, "validate"], {
    env: { ...env, RUNNER_IMAGE_ARCHITECTURE: "{invalid JSON" }, encoding: "utf8",
  }).status, 0);
  const validate = (mode, architecture, hit, result) => spawnSync("bash", [validator, mode], {
    env: { ...env, RUNNER_IMAGE_ARCHITECTURE: JSON.stringify(architecture),
      RUNNER_IMAGE_CACHE_HIT: hit, RUNNER_IMAGE_COMPILE_RESULT: result }, encoding: "utf8",
  });
  for (const group of groups) {
    assert.equal(validate("validate", group, "false", "").status, 0);
    for (const hit of [true, false]) {
      assert.equal(evaluate(compile.if, { inputs: { "cache-hit": hit }, cancelled: false }), !hit);
      assert.equal(evaluate(compile.if, { inputs: { "cache-hit": hit }, cancelled: true }), false);
      for (const result of ["success", "failure", "cancelled", "skipped", "", "neutral"]) {
        const context = { inputs: { "cache-hit": hit }, needs: { compile: { result } }, cancelled: false };
        assert.equal(evaluate(image.if, context), true,
          "image job must inspect unsuccessful compiler results rather than hide them as skips");
        const expected = (hit && result === "skipped") || (!hit && result === "success");
        assert.equal(validate("build-ready", group, String(hit), result).status === 0, expected,
          `${group.id}: hit=${hit}, compile=${result}`);
        assert.equal(evaluate(image.if, { ...context, cancelled: true }), false);
      }
    }
    for (const malformed of [null, [], {}, { ...group, hosts: "arm.fixture" },
      { ...group, target: "unsupported-target" }, { ...group, id: "unknown" },
      { ...group, unameM: "other" }, { ...group, cacheSuffix: "wrong" },
      { ...group, assetSuffix: "wrong" }, { ...group, label: "" }]) {
      assert.notEqual(validate("build-ready", malformed, "true", "skipped").status, 0);
    }
    assert.notEqual(validate("build-ready", group, "", "skipped").status, 0);
    assert.notEqual(validate("build-ready", group, "unexpected", "success").status, 0);
  }
  // Both directions: only this instance's terminal compiler is a predecessor.
  // The other target can remain in progress without becoming an ancestor.
  for (const [ready, slow] of [[groups[0], groups[1]], [groups[1], groups[0]]]) {
    for (const hit of [true, false]) {
      const result = hit ? "skipped" : "success";
      assert.equal(validate("build-ready", ready, String(hit), result).status, 0);
      assert.notEqual(validate("build-ready", slow, "false", "in_progress").status, 0);
    }
  }
  for (const prepared of ["success", "failure", "cancelled", "skipped"]) {
    for (const needed of ["true", "false"]) {
      const context = { needs: { prepare: { result: prepared, outputs: {
        "current-runner-image-needed": needed,
      } } }, cancelled: false };
      assert.equal(evaluate(branch.if, context), prepared === "success" && needed === "true");
      assert.equal(evaluate(branch.if, { ...context, cancelled: true }), false);
    }
  }
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log("runner-image-architecture-test: ok");
JS
