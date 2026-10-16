#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/bin"
cat >"$fixture/bin/gh" <<'PY'
#!/usr/bin/env python3
import json
import os
import sys

path = sys.argv[2]
case = os.environ["CASE"]
sha = "a" * 40
job = {"id": 90, "name": "prepare", "run_id": 12, "run_attempt": 3,
       "head_sha": sha, "status": "completed", "conclusion": "success"}
artifact = {"id": 75, "name": "runner-cli-12-3", "expired": False,
            "workflow_run": {"id": 12, "head_sha": sha}}
if "/workflows/" in path:
    run = {"id": 12, "run_attempt": 9, "head_sha": sha,
           "event": "pull_request", "head_branch": "feature/cli",
           "path": ".github/workflows/runner-image.yml", "status": "completed",
           "repository": {"full_name": "okou-ai/okou"},
           "head_repository": {"full_name": "okou-ai/okou"}}
    if case == "wrong-repository":
        run["head_repository"]["full_name"] = "external/fork"
    print(json.dumps({"total_count": 1, "workflow_runs": [run]}))
elif "/jobs?" in path:
    if case in ("failed", "cancelled"):
        job["conclusion"] = "failure" if case == "failed" else "cancelled"
    if case == "wrong-job":
        job["head_sha"] = "b" * 40
    if case == "invalid-attempt":
        job["run_attempt"] = 0
    jobs = [] if case == "missing-job" else [job]
    # A successful old prepare must not win over the latest failed prepare.
    if case == "failed-rerun":
        jobs += [dict(job, id=91, run_attempt=4, conclusion="failure")]
    print(json.dumps({"total_count": 101 if case == "truncated-jobs" else len(jobs), "jobs": jobs}))
elif "/artifacts?" in path:
    if case == "expired":
        artifact["expired"] = True
    if case == "wrong-artifact":
        artifact["workflow_run"]["head_sha"] = "b" * 40
    if case == "old-artifact":
        artifact["name"] = "runner-cli-12-2"
    artifacts = [artifact, dict(artifact, id=76)] if case == "ambiguous" else [artifact]
    print(json.dumps({"total_count": len(artifacts), "artifacts": artifacts}))
else:
    raise SystemExit("unexpected GitHub boundary")
PY
chmod +x "$fixture/bin/gh"

resolve() {
  env -i PATH="$fixture/bin:$PATH" CASE="$1" \
    REPO=okou-ai/okou LOOKUP_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    EVENT_NAME=pull_request HEAD_BRANCH=feature/cli GH_TOKEN=fixture-token \
    GITHUB_OUTPUT="$fixture/outputs" TIMEOUT_SECONDS=2 POLL_SECONDS=1 \
    bash "$root/.github/scripts/runner/resolve-runner-cli-artifact.sh"
}

resolve success >"$fixture/log"
diff -u <(printf 'run-id=12\nartifact-id=75\nproducer-attempt=3\n') "$fixture/outputs"
for scenario in wrong-repository failed cancelled wrong-job invalid-attempt \
  missing-job failed-rerun truncated-jobs expired wrong-artifact old-artifact ambiguous; do
  : >"$fixture/outputs"
  if resolve "$scenario" >"$fixture/log" 2>&1; then
    echo "FAIL: accepted $scenario" >&2
    exit 1
  fi
  [ ! -s "$fixture/outputs" ] || { echo "FAIL: $scenario exposed an artifact" >&2; exit 1; }
done
echo 'resolve-runner-cli-artifact-test: ok'
