#!/usr/bin/env bash
# Explicit transport modes: a main handoff is never a current-run fallback.
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case "${IMAGE_HANDOFF:-}" in
  current)
    : "${GITHUB_RUN_ID:?missing current run identity}"
    export RUNNER_IMAGE_RUN_ID="$GITHUB_RUN_ID"
    ;;
  main)
    if [ "${GITHUB_EVENT_NAME:-}" != push ] || [ "${GITHUB_REF:-}" != refs/heads/main ]; then
      echo 'main image handoff requires a push to the default main branch' >&2
      exit 2
    fi
    unset RUNNER_IMAGE_RUN_ID
    ;;
  *) echo 'missing or unsupported image handoff mode' >&2; exit 2 ;;
esac
case "${1:-}" in
  single) exec "$script_dir/wait-runner-image.sh" ;;
  groups) exec "$script_dir/wait-runner-image-groups.sh" ;;
  *) echo 'unsupported image manifest consumer' >&2; exit 2 ;;
esac
