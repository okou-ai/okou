#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/runner/prune-runner-idle.sh"
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "${test_dir}/bin"
cat >"${test_dir}/bin/ssh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$SSH_LOG"
exit "${SSH_RESULT:-0}"
SH
chmod +x "${test_dir}/bin/ssh"
export PATH="${test_dir}/bin:$PATH" SSH_LOG="${test_dir}/ssh.log"
export METAL_HOSTS=arm-1,x86-1,x86-2 METAL_USER=ci JOB_REF=pr-123 RUNNER_SERVICE_REF=pr-123
receipt='{"host":"x86-1","service":"pr-123-2","binDir":"/var/lib/vm0-runner/bin/pr-123","runnerId":"550e8400-e29b-41d4-a716-446655440000","heartbeatGeneration":7}'
export RUNNER_RECEIPT=$receipt
bash "$script"
grep -Fxq 'ci@x86-1' "$SSH_LOG"
grep -Fxq 'sudo /var/lib/vm0-runner/bin/pr-123/runner service prune-idle --name pr-123-2 --expected-runner-id 550e8400-e29b-41d4-a716-446655440000 --expected-heartbeat-generation 7 --timeout-secs 120' "$SSH_LOG"

# A failed request (including a stale generation or unsupported old binary)
# remains a failure, and never retries against a newly discovered generation.
status=0
SSH_RESULT=1 bash "$script" >"${test_dir}/failure.log" 2>&1 || status=$?
[ "$status" -eq 1 ]
for invalid in \
  '.host = "other-host"' \
  '.service = "pr-999-2"' \
  '.service = "pr-123-1"' \
  '.binDir = "/var/lib/vm0-runner/bin/pr-999"' \
  '.runnerId = "invalid"' \
  '.heartbeatGeneration = 0' \
  '.heartbeatGeneration = 1.5'; do
  rm -f "$SSH_LOG"
  invalid_receipt=$(jq -c "$invalid" <<<"$receipt")
  if RUNNER_RECEIPT="$invalid_receipt" bash "$script" >"${test_dir}/invalid.log" 2>&1; then
    echo "FAIL: accepted invalid deployment receipt: $invalid" >&2
    exit 1
  fi
  [ ! -f "$SSH_LOG" ]
done

export JOB_REF=staging-abcdef123 RUNNER_SERVICE_REF=staging
RUNNER_RECEIPT=$(jq -c '.service = "staging-2" | .binDir = "/var/lib/vm0-runner/bin/staging-abcdef123"' <<<"$receipt")
bash "$script"
grep -Fq -- '--name staging-2 --expected-runner-id' "$SSH_LOG"
echo 'PASS: generation-fenced idle cleanup targets and failure propagation'
