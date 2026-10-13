#!/usr/bin/env bash
set -euo pipefail

event_name="${EVENT_NAME:-${GITHUB_EVENT_NAME:-}}"
checkout_ref="${CHECKOUT_REF:-${GITHUB_REF:-}}"

case "$event_name" in
  pull_request)
    if [[ "$checkout_ref" == refs/pull/*/merge ]] && git rev-parse -q --verify HEAD^2 >/dev/null; then
      git rev-parse HEAD^1
      exit 0
    fi

    if [ -z "${PULL_REQUEST_BASE_SHA:-}" ]; then
      echo "missing PULL_REQUEST_BASE_SHA for pull_request event" >&2
      exit 2
    fi
    git merge-base "$PULL_REQUEST_BASE_SHA" HEAD
    ;;
  merge_group)
    if [ -z "${MERGE_GROUP_BASE_SHA:-}" ]; then
      echo "missing MERGE_GROUP_BASE_SHA for merge_group event" >&2
      exit 2
    fi

    merge_group_base=$(git rev-parse --verify "${MERGE_GROUP_BASE_SHA}^{commit}" 2>/dev/null) || {
      echo "MERGE_GROUP_BASE_SHA is not an available commit: ${MERGE_GROUP_BASE_SHA}" >&2
      exit 2
    }
    merge_group_parent=$(git rev-parse --verify HEAD^ 2>/dev/null) || {
      echo "merge_group HEAD does not have an available parent" >&2
      exit 2
    }
    if [ "$merge_group_base" != "$merge_group_parent" ]; then
      echo "MERGE_GROUP_BASE_SHA does not match merge_group HEAD parent" >&2
      exit 2
    fi

    printf '%s\n' "$merge_group_base"
    ;;
  *)
    printf 'HEAD^\n'
    ;;
esac
