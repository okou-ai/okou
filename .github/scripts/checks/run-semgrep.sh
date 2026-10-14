#!/bin/sh

set -eu

: "${EVENT_NAME:?EVENT_NAME is required}"

set -- \
  scan \
  --config auto \
  --json-output semgrep-results.json \
  --sarif \
  --output semgrep-results.sarif

case "$EVENT_NAME" in
  pull_request)
    baseline_commit="$(git rev-parse --verify HEAD^1)"
    echo "Running diff-aware Semgrep against pull request base $baseline_commit"
    set -- "$@" --baseline-commit "$baseline_commit"
    ;;
  merge_group)
    : "${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA is required for merge_group}"
    baseline_commit="$(git rev-parse --verify "${MERGE_GROUP_BASE_SHA}^{commit}")"
    echo "Running diff-aware Semgrep against merge group base $baseline_commit"
    set -- "$@" --baseline-commit "$baseline_commit"
    ;;
  push)
    echo "Running full Semgrep scan on main"
    ;;
  *)
    echo "Unsupported Semgrep event: $EVENT_NAME" >&2
    exit 2
    ;;
esac

exec semgrep "$@" .
