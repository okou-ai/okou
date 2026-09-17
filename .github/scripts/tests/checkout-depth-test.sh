#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for command in jq yq; do
  command -v "$command" >/dev/null || fail "$command is required"
done

actual=$(
  for workflow in turbo crates runner-image security; do
    yq -o=json '.' "${REPO_ROOT}/.github/workflows/${workflow}.yml" |
      jq -r --arg workflow "$workflow" '
        .jobs
        | to_entries[]
        | .key as $job
        | .value.steps[]?
        | select((.uses? // "") | startswith("actions/checkout@"))
        | select(.with["fetch-depth"]? != null)
        | [$workflow, $job, (.with["fetch-depth"] | tostring)]
        | @tsv
      '
  done | sort
)

expected=$(
  printf '%s\n' \
    $'crates\tdetect\t2' \
    $'runner-image\tprepare\t2' \
    $'security\tgitleaks\t${{ github.event_name != '\''pull_request'\'' && 2 || 0 }}' \
    $'security\tsemgrep\t${{ github.event_name == '\''push'\'' && 1 || 2 }}' \
    $'turbo\tdetect-turbo-ts-checks\t2' \
    $'turbo\tfile-size-check\t2' \
    $'turbo\tlint-eslint\t1' \
    $'turbo\tlint-style\t1' \
    $'turbo\tprepare\t2' \
    $'turbo\ttest-migrate\t2' \
    $'turbo\tvalidate-release-presence\t0' |
    sort
)

if [ "$actual" != "$expected" ]; then
  echo "Expected explicit checkout depths:" >&2
  echo "$expected" >&2
  echo "Actual explicit checkout depths:" >&2
  echo "$actual" >&2
  fail "checkout depth policy changed"
fi

echo "checkout-depth-test: ok"
