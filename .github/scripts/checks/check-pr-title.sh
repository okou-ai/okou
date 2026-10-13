#!/usr/bin/env bash
set -euo pipefail

readonly MAX_HEADER_LENGTH=100
readonly ALLOWED_TYPES="feat, fix, docs, style, refactor, test, chore, ci, perf, build, revert"
readonly TITLE_PATTERN='^(feat|fix|docs|style|refactor|test|chore|ci|perf|build|revert)(\([^()[:space:]]+\))?!?: .+$'

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <pull-request-title>" >&2
  exit 2
fi

title="$1"
failed=0

report_error() {
  local message="$1"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error::$message"
  else
    echo "ERROR: $message" >&2
  fi
  failed=1
}

if [ -z "$title" ]; then
  report_error "Pull request title must not be empty"
else
  if [ "${#title}" -gt "$MAX_HEADER_LENGTH" ]; then
    report_error "Pull request title must be at most ${MAX_HEADER_LENGTH} characters"
  fi

  if [[ ! "$title" =~ $TITLE_PATTERN ]]; then
    report_error "Pull request title must use conventional format: type(optional-scope): lower-case summary"
  else
    subject="${title#*: }"
    lower_subject="$(printf '%s' "$subject" | LC_ALL=C tr '[:upper:]' '[:lower:]')"

    if [ "$subject" != "$lower_subject" ]; then
      report_error "Pull request title subject must be lower-case"
    fi

    if [[ "$subject" == *. ]]; then
      report_error "Pull request title subject must not end with a period"
    fi
  fi
fi

if [ "$failed" -ne 0 ]; then
  cat >&2 <<EOF

How to fix:
  Edit the pull request title, then re-run this check.
  This check reads the current title, so no new commit is needed.

Expected examples:
  feat(api): compact chat thread snapshots hourly
  fix: remove stale runner cleanup

Allowed types:
  $ALLOWED_TYPES
EOF
  exit 1
fi

echo "Pull request title is conventional: $title"
