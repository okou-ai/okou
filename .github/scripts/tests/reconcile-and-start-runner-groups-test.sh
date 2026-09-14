#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/reconcile-and-start-runner-groups.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "${tmp_dir}/bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${tmp_dir}/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "-n" ]; then
  shift
fi
host=${1#*@}
shift
case "$host" in
  arm-1) arch=aarch64; target=aarch64-unknown-linux-musl ;;
  x86-1|x86-2) arch=x86_64; target=x86_64-unknown-linux-musl ;;
  *) echo "unexpected SSH host: $host" >&2; exit 1 ;;
esac

if [ "$*" = "uname -m" ]; then
  echo "$arch"
  exit 0
fi
if [ "$*" = "bash -s -- $BIN_DIR" ]; then
  cat >/dev/null
  if [ "${MOCK_RECOVERY:-false}" = true ]; then
    if [ -f "${MOCK_REMOTE_ROOT}/${host}/bin/runner" ]; then
      sha256sum "${MOCK_REMOTE_ROOT}/${host}/bin/runner" | awk '{print $1}'
    else
      echo missing
    fi
    exit 0
  fi
  jq -r --arg target "$target" '.[$target]' <<<"$RUNNER_SHA_MAP"
  exit 0
fi
if [ "$*" = "bash -s -- $RUNNER_DIR" ]; then
  bash -s -- "${MOCK_REMOTE_ROOT}/${host}"
  exit 0
fi
if [[ "$*" == "bash -s -- ${BIN_DIR}/runner.recovery."* ]]; then
  shift 3
  mapped_args=()
  for arg in "$@"; do
    mapped_args+=("${arg//"$BIN_DIR"/"${MOCK_REMOTE_ROOT}/${host}/bin"}")
  done
  bash -s -- "${mapped_args[@]}"
  exit 0
fi
if [ "$*" = "sudo mkdir -p -- $BIN_DIR" ]; then
  mkdir -p "${MOCK_REMOTE_ROOT}/${host}/bin"
  exit 0
fi
if [[ "$*" == "sudo install -m 755 /dev/stdin ${BIN_DIR}/runner.recovery."* ]]; then
  destination=${*: -1}
  install -m 755 /dev/stdin "${MOCK_REMOTE_ROOT}/${host}/bin/${destination##*/}"
  exit 0
fi

printf '%s\t%s\n' "$host" "$*" >>"$MOCK_SERVICE_LOG"
service_name=$(printf '%s\n' "$*" | sed -n "s/.*--name ['\"]*\\([a-z0-9-]*\\).*/\\1/p")
case "$*" in
  "test -x ${BIN_DIR}/runner") ;;
  "sudo ${BIN_DIR}/runner config "*)
    printf '%s\n' "$*" >"${MOCK_REMOTE_ROOT}/${host}/config"
    ;;
  "sudo ${BIN_DIR}/runner service stop "*)
    if [ "${MOCK_FAILURE:-none}" = retire ] && [ "$host" = x86-2 ]; then
      exit 1
    fi
    rm -f "${MOCK_REMOTE_ROOT}/${host}/${service_name}"
    ;;
  "sudo rm -f ${RUNNER_DIR}/status.json") ;;
  "sudo ${BIN_DIR}/runner service start "*)
    printf '%s\n' "$*" >"${MOCK_REMOTE_ROOT}/${host}/${service_name}"
    printf '550e8400-e29b-41d4-a716-446655440000\n' >"${MOCK_REMOTE_ROOT}/${host}/runner_id"
    printf '7\n' >"${MOCK_REMOTE_ROOT}/${host}/heartbeat_generation"
    if [ "${MOCK_FAILURE:-none}" = identity ]; then
      printf 'invalid\n' >"${MOCK_REMOTE_ROOT}/${host}/heartbeat_generation"
    fi
    ;;
  "sudo ${BIN_DIR}/runner service wait-running "*)
    if [ "${MOCK_FAILURE:-none}" = readiness ]; then
      exit 1
    fi
    if [ "${MOCK_FAILURE:-none}" = cancel ]; then
      kill -TERM "$MOCK_DEPLOY_PID"
      exit 0
    fi
    echo 35
    ;;
  "sudo ${BIN_DIR}/runner doctor "*) ;;
  *) echo "unexpected SSH command: $*" >&2; exit 1 ;;
esac
SH
chmod +x "${tmp_dir}/bin/ssh"
cat >"${tmp_dir}/bin/sudo" <<'SH'
#!/usr/bin/env bash
exec "$@"
SH
chmod +x "${tmp_dir}/bin/sudo"

cat >"${tmp_dir}/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = api ]; then
  endpoint=${*: -1}
  [[ "$endpoint" == *'/actions/artifacts?'* ]] || exit 2
  name=${endpoint#*name=}
  name=${name%%&*}
  jq -cn --arg name "$name" '[{artifacts: [{
    id: 120, name: $name, expired: false, size_in_bytes: 1000,
    created_at: "2026-09-11T00:00:00Z", workflow_run: {id: 20}
  }]}]'
elif [ "$1" = run ] && [ "$2" = download ]; then
  name="" output=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -n) name=$2; shift 2 ;;
      -D) output=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "${MOCK_CACHE_ROOT}/${name}.json" "${output}/manifest.json"
else
  exit 2
fi
SH
cat >"${tmp_dir}/bin/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = s3api ] || exit 2
case "$2" in
  head-object) printf '{}\n' ;;
  get-object) cp "${MOCK_CACHE_ROOT}/cached-runner.zst" "${*: -1}" ;;
  *) exit 2 ;;
esac
SH
chmod +x "${tmp_dir}/bin/gh" "${tmp_dir}/bin/aws"

printf '#!/usr/bin/env bash\nprintf "cached runner fixture\\n"\n' >"${tmp_dir}/cached-runner"
zstd -q -3 -o "${tmp_dir}/cached-runner.zst" "${tmp_dir}/cached-runner"
cached_sha=$(sha256sum "${tmp_dir}/cached-runner" | awk '{print $1}')
guests=$(jq -c --arg sha "$cached_sha" \
  'map({key: .binary, value: $sha}) | from_entries' \
  "${repo_root}/crates/runner/guest-binaries.json")
for target in aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
  digest_output=$("${repo_root}/.github/scripts/runner-binary-build/digest.sh" "$target")
  digest=$(sed -n 's/^binary-input-digest=//p' <<<"$digest_output")
  toolchain=$(sed -n 's/^toolchain-image=//p' <<<"$digest_output")
  jq -n --arg target "$target" --arg digest "$digest" \
    --arg sha "$cached_sha" --arg toolchain "$toolchain" \
    --argjson guests "$guests" '{
      schemaVersion: 1, target: $target, binaryInputDigest: $digest,
      toolchainImage: $toolchain, guests: $guests,
      object: {key: ("runner-binaries/" + $target + "/" + $sha + ".zst")}
    }' >"${tmp_dir}/runner-binary-asset-${target}-${digest}.json"
done

cat >"${tmp_dir}/run-deployment" <<'SH'
#!/usr/bin/env bash
export MOCK_DEPLOY_PID=$$
exec bash "$@"
SH

run_case() {
  local case_name=$1 job_ref=$2 selected_host=$3 selected_index=$4 failure=$5 recovery=${6:-false}
  local case_dir="${tmp_dir}/${case_name}"
  local runner_sha_map='{"aarch64-unknown-linux-musl":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","x86_64-unknown-linux-musl":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  if [ "$recovery" = true ]; then
    runner_sha_map=$(jq -c --arg sha "$cached_sha" 'map_values($sha)' <<<"$runner_sha_map")
  fi
  local service_ref=$job_ref
  if [[ "$job_ref" == staging-* ]]; then
    service_ref=staging
  fi
  local host host_index=0
  if [ ! -d "$case_dir" ]; then
    for host in arm-1 x86-1 x86-2; do
      host_index=$((host_index + 1))
      mkdir -p "${case_dir}/${host}"
      printf 'existing-service\n' >"${case_dir}/${host}/${service_ref}-${host_index}"
      printf 'unrelated-service\n' >"${case_dir}/${host}/pr-999-${host_index}"
      if [ "$recovery" = true ] && [ "$host" != x86-1 ]; then
        mkdir -p "${case_dir}/${host}/bin"
        cp "${tmp_dir}/cached-runner" "${case_dir}/${host}/bin/runner"
      fi
    done
  fi
  : >"${case_dir}/service.log"

  local status=0
  env \
    PATH="${tmp_dir}/bin:$PATH" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1,x86-2 \
    BIN_DIR="/var/lib/vm0-runner/bin/${job_ref}" \
    JOB_REF="$job_ref" \
    METAL_HOSTS=arm-1,x86-1,x86-2 \
    METAL_USER=ci \
    OFFICIAL_RUNNER_SECRET=test-secret \
    REPO=vm0-ai/vm0 \
    ROOTFS_HASH_MAP='{"arm-1":"rootfs-arm","x86-1":"rootfs-x86-1","x86-2":"rootfs-x86-2"}' \
    RUNNER_API_URL=https://api.example.test \
    RUNNER_DIR="/var/lib/vm0-runner/runners/${job_ref}" \
    RUNNER_GROUP="vm0/development-${service_ref}" \
    RUNNER_SERVICE_REF="$service_ref" \
    RUNNER_SHA_MAP="$runner_sha_map" \
    SNAPSHOT_HASH_MAP='{"arm-1":"snapshot-arm","x86-1":"snapshot-x86-1","x86-2":"snapshot-x86-2"}' \
    VERCEL_BYPASS=test-bypass \
    AWS_ACCESS_KEY_ID=test-access \
    AWS_SECRET_ACCESS_KEY=test-secret \
    R2_ACCOUNT_ID=test-account \
    R2_BUCKET_NAME=test-bucket \
    MOCK_CACHE_ROOT="$tmp_dir" \
    MOCK_RECOVERY="$recovery" \
    MOCK_REMOTE_ROOT="$case_dir" \
    MOCK_SERVICE_LOG="${case_dir}/service.log" \
    MOCK_FAILURE="$failure" \
    GITHUB_OUTPUT="${case_dir}/github-output" \
    bash "${tmp_dir}/run-deployment" "$script" >"${case_dir}/output" 2>&1 || status=$?

  if [ "$failure" != none ]; then
    [ "$status" -ne 0 ] || fail "${case_name}: ${failure} failure must fail deployment"
    if [ "$failure" = cancel ]; then
      [ "$status" -eq 143 ] || fail "${case_name}: cancellation must preserve the signal exit code"
    fi
    [ ! -f "${case_dir}/${selected_host}/${service_ref}-${selected_index}" ] ||
      fail "${case_name}: failed start left the selected service running"
  else
    if [ "$status" -ne 0 ]; then
      cat "${case_dir}/output" >&2
      fail "${case_name}: deployment failed"
    fi
    grep -Fq -- "--name ${service_ref}-${selected_index}" "${case_dir}/${selected_host}/${service_ref}-${selected_index}" ||
      fail "${case_name}: selected service lost its original inventory index"
    grep -Fq -- "--hostname ${selected_host}" "${case_dir}/${selected_host}/config" ||
      fail "${case_name}: config does not use the selected host"
    receipt=$(sed -n 's/^runner-receipt=//p' "${case_dir}/github-output" | tail -n1)
    jq -e --arg host "$selected_host" --arg service "${service_ref}-${selected_index}" '
      .host == $host and .service == $service and
      .runnerId == "550e8400-e29b-41d4-a716-446655440000" and .heartbeatGeneration == 7
    ' <<<"$receipt" >/dev/null || fail "${case_name}: invalid deployment receipt"
    if [ "$recovery" = true ]; then
      cmp "${tmp_dir}/cached-runner" "${case_dir}/x86-1/bin/runner" ||
        fail "${case_name}: missing binary was not restored from the cache reference"
    fi
  fi

  [ "$(awk '!/runner service stop / {print $1}' "${case_dir}/service.log" | sort -u)" = "$selected_host" ] ||
    fail "${case_name}: start or readiness operations reached an unselected host"
  [ "$(grep -c 'runner service start ' "${case_dir}/service.log")" -eq 1 ] ||
    fail "${case_name}: deployment must start exactly one service"
  grep -Fq -- "service wait-running --name ${service_ref}-${selected_index}" "${case_dir}/service.log" ||
    fail "${case_name}: readiness must use the selected service identity"
  host_index=0
  for host in arm-1 x86-1 x86-2; do
    host_index=$((host_index + 1))
    [ "$(cat "${case_dir}/${host}/pr-999-${host_index}")" = unrelated-service ] ||
      fail "${case_name}: deployment changed another PR's service"
    [ "$host" = "$selected_host" ] && continue
    # Cancellation can interrupt retirement, but must roll back the new service.
    [ "$failure" = cancel ] && continue
    if [ "$failure" = retire ] && [ "$host" = x86-2 ]; then
      [ -f "${case_dir}/${host}/${service_ref}-${host_index}" ] ||
        fail "${case_name}: fixture did not retain the failed retirement"
    else
      [ ! -f "${case_dir}/${host}/${service_ref}-${host_index}" ] ||
        fail "${case_name}: unselected replica still serves the current namespace"
    fi
  done
}

# These image refs select the same hosts as the existing Crates behavior lane.
run_case x86 pr-1 x86-1 2 none
run_case x86 pr-1 x86-1 2 none
run_case arm pr-2 arm-1 1 none
run_case recovered-binary pr-1 x86-1 2 none true
run_case failed-start pr-9 x86-2 3 readiness
run_case invalid-identity pr-9 x86-2 3 identity
run_case failed-retirement pr-1 x86-1 2 retire
run_case cancelled-start pr-9 x86-2 3 cancel
# A new staging image ref can select another host while service names stay fixed.
run_case staging staging-000000000000 arm-1 1 none
run_case staging staging-222222222222 x86-1 2 none

echo "reconcile-and-start-runner-groups-test: ok"
