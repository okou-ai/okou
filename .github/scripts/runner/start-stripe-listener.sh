#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${script_dir}/../../../ansible"

STRIPE_LISTENER_HOST="$(printf '%s\n' "$METAL_HOSTS" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed '/^$/d' | head -n 1)"
if [[ -z "$STRIPE_LISTENER_HOST" ]]; then
  echo "::error::AWS_METAL_RUNNER_HOSTS is empty"
  exit 1
fi

CLEANUP_EXTRA_VARS="$(jq -nc \
  --arg ansible_user "$METAL_USER" \
  --arg job_ref "$JOB_REF" \
  '{ansible_user: $ansible_user, job_ref: $job_ref}')"
ansible-playbook \
  -i "${METAL_HOSTS}," \
  playbooks/cleanup-stripe-listener.yml \
  --extra-vars "$CLEANUP_EXTRA_VARS" \
  -v

FORWARD_URL="${API_PREVIEW_URL%/}/api/webhooks/stripe"
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  encoded_bypass="$(node -e 'process.stdout.write(encodeURIComponent(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || ""))')"
  echo "::add-mask::$encoded_bypass"
  FORWARD_URL="${FORWARD_URL}?x-vercel-protection-bypass=${encoded_bypass}"
fi
EXTRA_VARS="$(jq -nc \
  --arg ansible_user "$METAL_USER" \
  --arg job_ref "$JOB_REF" \
  --arg forward_url "$FORWARD_URL" \
  --arg stripe_secret_key "$STRIPE_SECRET_KEY" \
  '{ansible_user: $ansible_user, job_ref: $job_ref, forward_url: $forward_url, stripe_secret_key: $stripe_secret_key}')"

ansible-playbook \
  -i "${STRIPE_LISTENER_HOST}," \
  playbooks/start-stripe-listener.yml \
  --extra-vars "$EXTRA_VARS" \
  -v
