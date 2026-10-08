#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/runner-image.yml"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v yq >/dev/null || fail "yq is required"
yq -o=json '.' "$WORKFLOW" > "${TEST_ROOT}/workflow.json"

# Producer and consumers must derive compatible keys, without relaxing any
# required compiler gate or making an image/deployment wait for cache warming.
jq -e '
  .jobs.compile as $compile |
  .jobs["prewarm-rust-cache"] as $warm |
  ($compile.steps | map(select((.uses // "") | startswith("Swatinem/rust-cache@"))) | .[0]) as $cache |
  ($warm.steps | map(select(.id == "cache-lookup")) | .[0]) as $lookup |
  ($warm.steps | map(select(.id == "cache-restore")) | .[0]) as $restore |
  $warm.needs == ["prepare"] and
  $warm["continue-on-error"] == true and
  $warm["runs-on"] == $compile["runs-on"] and
  $warm.container == $compile.container and
  $warm.env == $compile.env and
  $warm.permissions == $compile.permissions and
  $warm.strategy.matrix.include == "${{ fromJSON(needs.prepare.outputs.runner-binary-hit-matrix) }}" and
  ($compile | has("continue-on-error") | not) and
  $cache.with["save-if"] == "${{ github.ref == '\''refs/heads/main'\'' }}" and
  $lookup.uses == $cache.uses and
  $restore.uses == $cache.uses and
  $lookup.with.workspaces == $cache.with.workspaces and
  $restore.with.workspaces == $cache.with.workspaces and
  $lookup.with["shared-key"] == $cache.with["shared-key"] and
  $restore.with["shared-key"] == $cache.with["shared-key"] and
  $lookup.with["lookup-only"] == true and
  $lookup.with["save-if"] == false and
  ($restore.with["lookup-only"] // false) == false and
  $restore.with["save-if"] == $cache.with["save-if"] and
  any($warm.steps[];
    .name == "Configure git safe directory" and .shell == "bash"
  ) and
  ($warm.steps | map(select(.uses == "./.github/actions/setup-r2-sccache")) | .[0].with) ==
    ($compile.steps | map(select(.uses == "./.github/actions/setup-r2-sccache")) | .[0].with) and
  (($warm.steps | map(.id // .name) | index("Setup R2 sccache")) <
    ($warm.steps | map(.id // .name) | index("cache-lookup"))) and
  any($warm.steps[];
    .id == "prewarm" and
    .run == ".github/scripts/runner-binary-build/build.sh build" and
    .env.RUNNER_BINARY_METADATA_PATH == "runner-rust-cache-prewarm/metadata.json"
  ) and
  all($warm.steps[];
    ((.uses // "") | startswith("actions/upload-artifact@") | not) and
    ((.run // "") | contains("runner-binary-transport.sh") | not) and
    ((.run // "") | contains("prepare-runner-image.sh") | not)
  ) and
  all(.jobs[];
    ((.needs // [] | index("prewarm-rust-cache")) == null)
  )
' "${TEST_ROOT}/workflow.json" >/dev/null || fail "dependency cache producer must match consumers and remain main-owned and publication-free"

# Evaluate the routing conditions taken from the actual workflow against event
# and cache-service responses. No GitHub cache is read or written by this test.
node - "${TEST_ROOT}/workflow.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const workflow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const warm = workflow.jobs["prewarm-rust-cache"];
const steps = Object.fromEntries(warm.steps.map(step => [step.id || step.name, step]));
const targets = [
  { id: "arm64", target: "aarch64-unknown-linux-musl" },
  { id: "x86_64", target: "x86_64-unknown-linux-musl" },
];

// These routing expressions use booleans, string equality, JSON, and paths.
// Resolve hyphenated Actions output names before evaluating that small subset.
function evaluate(expression, context) {
  const source = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\b(?:github|needs|steps)(?:\.[A-Za-z0-9_-]+)+/g, path => {
      let value = context;
      for (const key of path.split(".")) value = value?.[key];
      return JSON.stringify(value ?? "");
    });
  return vm.runInNewContext(source, {
    cancelled: () => context.cancelled,
    fromJSON: JSON.parse,
  }, { timeout: 1000 });
}

function context(overrides = {}) {
  const { event = "push", ref = "refs/heads/main", hits = targets,
    needed = "true", prepared = "success", cancelled = false,
    lookup = "false", restore = "false" } = overrides;
  return {
    github: { event_name: event, ref },
    needs: { prepare: { result: prepared, outputs: {
      "current-runner-image-needed": needed,
      "runner-binary-hit-matrix": JSON.stringify(hits),
    } } },
    steps: {
      "cache-lookup": { outputs: { "cache-hit": lookup } },
      "cache-restore": { outputs: { "cache-hit": restore } },
    },
    cancelled,
  };
}

for (const [label, input, expectedTargets] of [
  ["main binary hits", {}, targets],
  ["main mixed plan", { hits: [targets[0]] }, [targets[0]]],
  ["main compiler misses", { hits: [] }, []],
  ["pull request", { event: "pull_request", ref: "refs/pull/1/merge" }, []],
  ["merge queue", { event: "merge_group", ref: "refs/heads/gh-readonly-queue/main/pr-1" }, []],
  ["non-main push", { ref: "refs/heads/feature" }, []],
  ["no image needed", { needed: "false" }, []],
  ["failed prepare", { prepared: "failure" }, []],
  ["cancelled run", { cancelled: true }, []],
]) {
  const data = context(input);
  const selected = evaluate(warm.if, data)
    ? evaluate(warm.strategy.matrix.include, data) : [];
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), expectedTargets, label);
}

for (const [label, input, expected] of [
  ["cold key", { lookup: "false", restore: "false" }, [true, true, true]],
  ["exact key hit", { lookup: "true", restore: "" }, [false, false, false]],
  ["cache filled between lookup and restore", { lookup: "false", restore: "true" }, [true, false, false]],
]) {
  const data = context(input);
  const selected = ["cache-restore", "Download private CLI build input", "prewarm"]
    .map(name => evaluate(steps[name].if, data));
  assert.deepEqual(selected, expected, label);
}
JS

echo "runner-rust-cache-prewarm-workflow-test: ok"
