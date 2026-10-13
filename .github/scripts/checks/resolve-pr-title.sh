#!/usr/bin/env bash
set -euo pipefail

# Resolve the pull request title for the current CI event and print it.
#
# The title is always read from the API, never from the pull_request event
# payload: a re-run replays the original payload, so a payload read would keep
# validating the pre-edit title and force an empty commit just to refresh it.
#
# Prints nothing and exits 0 for events that have no pull request to validate.

EVENT_NAME="${EVENT_NAME:-}"
MQ_HEAD_REF="${MQ_HEAD_REF:-}"
PR_NUMBER="${PR_NUMBER:-}"
REPO="${REPO:-}"

case "$EVENT_NAME" in
  pull_request)
    pr_number="$PR_NUMBER"
    if [ -z "$pr_number" ]; then
      echo "::error::Could not resolve pull request number from the pull_request event" >&2
      exit 1
    fi
    ;;
  merge_group)
    pr_number="$(printf '%s\n' "$MQ_HEAD_REF" | grep -oE 'pr-[0-9]+' | head -1 | sed 's/pr-//' || true)"
    if [ -z "$pr_number" ]; then
      echo "::error::Could not resolve pull request number from merge queue ref: $MQ_HEAD_REF" >&2
      exit 1
    fi
    ;;
  *)
    exit 0
    ;;
esac

title="$(gh pr view "$pr_number" --repo "$REPO" --json title --jq .title)"

# Callers treat empty output as "no pull request to validate", so an empty
# resolved title must fail here instead of silently skipping validation.
if [ -z "$title" ]; then
  echo "::error::Resolved an empty title for pull request #${pr_number}" >&2
  exit 1
fi

printf '%s\n' "$title"
