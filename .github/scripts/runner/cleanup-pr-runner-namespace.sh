#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

required_env=(
  GH_TOKEN
  GITHUB_REPOSITORY
  GITHUB_RUN_ID
  JOB_REF
  METAL_HOSTS
  METAL_USER
  PR_NUMBER
)
for name in "${required_env[@]}"; do
  require_env "$name"
done

if [[ ! "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid PR number: ${PR_NUMBER}" >&2
  exit 2
fi
if [ "$JOB_REF" != "pr-${PR_NUMBER}" ]; then
  echo "runner cleanup namespace mismatch: ${JOB_REF} != pr-${PR_NUMBER}" >&2
  exit 2
fi

# The caller requests CI cancellation before taking the namespace lock. Recheck
# closed-PR authority here before deleting resources under that lock.
if ! pr_state=$(gh api --method GET \
  "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" \
  --jq '.state' 2>&1); then
  echo "failed to resolve current state for PR #${PR_NUMBER}: ${pr_state}" >&2
  exit 1
fi
if [ "$pr_state" != "closed" ]; then
  echo "refusing to clean runner resources for PR #${PR_NUMBER} in state ${pr_state}" >&2
  exit 1
fi

exec ansible-playbook \
  -i "${METAL_HOSTS}," \
  "${REPO_ROOT}/ansible/playbooks/cleanup-pr-runner.yml" \
  -e "ansible_user=${METAL_USER}" \
  -e "job_ref=${JOB_REF}" \
  -v
