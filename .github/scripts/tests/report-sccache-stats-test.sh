#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
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
PY

# The reporter has no credential input. Its subprocesses inherit workflow env.
for workflow in crates runner-image runner-image-architecture release-please; do
  yq -o=json '.' "${REPO_ROOT}/.github/workflows/${workflow}.yml" | jq -e '
    .env as $workflow_env |
    all(.jobs[];
      .env as $job_env |
      all(.steps[]? | select(.run == ".github/scripts/report-sccache-stats.sh");
        (($workflow_env // {}) + ($job_env // {}) + (.env // {})) |
        any(keys[]; IN("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID",
                      "SCCACHE_BUCKET", "SCCACHE_ENDPOINT")) | not))
  ' >/dev/null || {
    echo "${workflow}: sccache reporting must run without cache credentials" >&2
    exit 1
  }
done

echo "report-sccache-stats-test: ok"
