#!/usr/bin/env bash
set -euo pipefail

# The deployment receipt is the authority. Never replace its generation by
# reading the current runner_id/heartbeat_generation during cleanup.
: "${RUNNER_RECEIPT:?deployment receipt is required}"
: "${METAL_HOSTS:?metal inventory is required}"
: "${METAL_USER:?SSH user is required}"
: "${JOB_REF:?runner image namespace is required}"
: "${RUNNER_SERVICE_REF:?service namespace is required}"

if [[ ! "$METAL_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] ||
  [[ ! "$JOB_REF" =~ ^(pr-[1-9][0-9]*|staging-[0-9a-f]{7,40})$ ]]; then
  echo "Invalid Runner cleanup namespace or SSH user" >&2
  exit 2
fi
expected_service_ref=$JOB_REF
if [[ "$JOB_REF" == staging-* ]]; then
  expected_service_ref=staging
fi
if [ "$RUNNER_SERVICE_REF" != "$expected_service_ref" ]; then
  echo "Runner service namespace does not match image namespace" >&2
  exit 2
fi

jq -e '
  type == "object" and
  (.host | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9.-]*$")) and
  (.service | type == "string") and (.binDir | type == "string") and
  (.runnerId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  (.heartbeatGeneration | type == "number" and . > 0 and . <= 9007199254740991 and . == floor)
' <<<"$RUNNER_RECEIPT" >/dev/null
host=$(jq -r .host <<<"$RUNNER_RECEIPT")
service=$(jq -r .service <<<"$RUNNER_RECEIPT")
bin_dir=$(jq -r .binDir <<<"$RUNNER_RECEIPT")
runner_id=$(jq -r .runnerId <<<"$RUNNER_RECEIPT")
generation=$(jq -r .heartbeatGeneration <<<"$RUNNER_RECEIPT")

matched=false
index=0
for inventory_host in $(echo "$METAL_HOSTS" | tr ',' ' '); do
  index=$((index + 1))
  if [ "$inventory_host" = "$host" ] && [ "$service" = "${RUNNER_SERVICE_REF}-${index}" ]; then
    matched=true
  fi
done
if ! $matched || [ "$bin_dir" != "/var/lib/vm0-runner/bin/${JOB_REF}" ]; then
  echo "Deployment receipt does not match this namespace and metal inventory" >&2
  exit 2
fi

# Every interpolated target is validated above. A missing/old binary, vanished
# generation, or peer mismatch fails; there is no signal or host-wide fallback.
# shellcheck disable=SC2029
timeout 150s ssh -o BatchMode=yes -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "${METAL_USER}@${host}" \
  "sudo ${bin_dir}/runner service prune-idle --name ${service} --expected-runner-id ${runner_id} --expected-heartbeat-generation ${generation} --timeout-secs 120"
