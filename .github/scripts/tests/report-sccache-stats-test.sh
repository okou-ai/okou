#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

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
