#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
for workflow in crates runner-image release-please; do
  yq -o=json '.' "${REPO_ROOT}/.github/workflows/${workflow}.yml" > "${TEST_ROOT}/${workflow}.json"
done

# The native process is external; stdout and the real job-summary file are contracts.
python3 - "$REPO_ROOT" "$TEST_ROOT" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

repo, root = map(Path, sys.argv[1:])
fixture = root / "bin"
fixture.mkdir()
program = fixture / "sccache"
program.write_text('''#!/usr/bin/env bash
set -euo pipefail
[ -z "${AWS_ACCESS_KEY_ID:-}${AWS_SECRET_ACCESS_KEY:-}${SCCACHE_BUCKET:-}${SCCACHE_ENDPOINT:-}" ]
[ "$1" = --show-stats ]
if [ "$#" = 1 ]; then
  [ "$FIXTURE_MODE" != human-failure ] || exit 21
  printf 'Cache hits: 7\\nCache misses: 3\\nCache write errors: 1\\n'
else
  [ "$#" = 2 ] && [ "$2" = --stats-format=json ]
  [ "$FIXTURE_MODE" != json-failure ] || exit 22
  printf '{"stats":{"cache_hits":{"counts":{"Rust":7}},"cache_misses":{"counts":{"Rust":3}},"cache_write_errors":1}}'
fi
''')
program.chmod(0o755)
reporter = repo / ".github/scripts/report-sccache-stats.sh"
for mode in ["valid", "human-failure", "json-failure"]:
    summary = root / (mode + ".md")
    summary.write_text("Previous job summary\n")
    env = {"PATH": str(fixture) + os.pathsep + os.environ["PATH"],
           "GITHUB_STEP_SUMMARY": str(summary), "FIXTURE_MODE": mode}
    result = subprocess.run([str(reporter)], env=env, text=True, capture_output=True)
    text = summary.read_text()
    if mode == "valid":
        assert result.returncode == 0, result.stderr
        assert result.stdout.endswith("\n")
        assert "Cache hits: 7\nCache misses: 3\nCache write errors: 1\n" in result.stdout
        statistics = json.loads(result.stdout.splitlines()[-1])
        assert statistics["stats"]["cache_hits"]["counts"]["Rust"] == 7
        assert statistics["stats"]["cache_misses"]["counts"]["Rust"] == 3
        assert statistics["stats"]["cache_write_errors"] == 1
        assert text.startswith("Previous job summary\n")
        assert "~~~text\nCache hits: 7\nCache misses: 3\nCache write errors: 1\n~~~" in text
        assert json.loads(text.split("~~~json\n")[1].split("\n~~~")[0]) == statistics
    else:
        assert result.returncode != 0, mode
        assert text == "Previous job summary\n", mode
        if mode == "json-failure":
            assert "Cache hits: 7" in result.stdout

# Inspect the actual six consumers and evaluate their real Actions conditions below.
consumers = []
for name in ["crates", "runner-image", "release-please"]:
    workflow = json.loads((root / (name + ".json")).read_text())
    for job_id, job in workflow["jobs"].items():
        setups = [s for s in job.get("steps", []) if s.get("uses") == "./.github/actions/setup-r2-sccache"]
        if not setups:
            continue
        assert len(setups) == 1 and setups[0]["id"] == "sccache"
        reports = [s for s in job["steps"] if s.get("run") == ".github/scripts/report-sccache-stats.sh"]
        assert len(reports) == 1, (name, job_id)
        report = reports[0]
        forbidden = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "SCCACHE_BUCKET", "SCCACHE_ENDPOINT"}
        assert not forbidden.intersection(report.get("env", {}))
        assert not forbidden.intersection(job.get("env", {}))
        compiler_commands = {
            ".github/scripts/runner-binary-build/build.sh build",
            "bash .github/scripts/build-runner-native-release.sh",
            "bash .github/scripts/build-runner-native-supervisor.sh",
        }
        compilers = [i for i, s in enumerate(job["steps"]) if "cargo " in s.get("run", "") or
                     compiler_commands.intersection(s.get("run", "").splitlines())]
        assert compilers and max(compilers) < job["steps"].index(report)
        consumers.append({"workflow": name, "job": job_id, "if": report["if"], "setupIf": setups[0].get("if")})
assert {(x["workflow"], x["job"]) for x in consumers} == {
    ("crates", "coverage"), ("crates", "runner-rootfs-process-test"),
    ("runner-image", "compile"), ("runner-image", "prewarm-rust-cache"),
    ("runner-image", "native-release-build"),
    ("release-please", "build-runner-release-assets"),
}
(root / "consumers.json").write_text(json.dumps(consumers))
PY

node - "${TEST_ROOT}/consumers.json" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const consumers = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
function evaluate(expression, context, buildSucceeded) {
  // Actions inserts success() only when no explicit status function is present.
  if (!/\b(?:always|success|failure|cancelled)\(\)/.test(expression) && !buildSucceeded) return false;
  const source = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\b(?:github|steps)(?:\.[A-Za-z0-9_-]+)+/g, path => {
      let value = context;
      for (const key of path.split(".")) value = value?.[key];
      return JSON.stringify(value ?? "");
    });
  return vm.runInNewContext(source, { always: () => true, success: () => buildSucceeded }, { timeout: 1000 });
}
for (const consumer of consumers) {
  for (const started of ["true", "", "false"]) {
    for (const built of [true, false]) {
      const context = { steps: { sccache: { outputs: { started } } } };
      assert.equal(evaluate(consumer.if, context, built), started === "true", `${consumer.workflow}/${consumer.job}`);
    }
  }
}
const coverage = consumers.find(x => x.workflow === "crates" && x.job === "coverage");
for (const [event, author, sourceRepo, expected] of [
  ["push", "seven332", "okou-ai/okou", true],
  ["merge_group", "seven332", "okou-ai/okou", true],
  ["pull_request", "seven332", "okou-ai/okou", true],
  ["pull_request", "seven332", "outside/fork", false],
  ["pull_request", "dependabot[bot]", "okou-ai/okou", false],
]) {
  const context = { github: { event_name: event, repository: "okou-ai/okou", event: {
    pull_request: { user: { login: author }, head: { repo: { full_name: sourceRepo } } },
  } } };
  assert.equal(evaluate(coverage.setupIf, context, true), expected, event + author + sourceRepo);
}
JS

echo "report-sccache-stats-test: ok"
