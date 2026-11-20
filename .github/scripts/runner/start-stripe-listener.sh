#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STRIPE_WORKFLOW_CREATED_AT="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" --jq .created_at)"
export STRIPE_WORKFLOW_CREATED_AT
unset GH_TOKEN
exec python3 "${script_dir}/deploy-stripe-listener.py"
