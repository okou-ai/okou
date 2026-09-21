#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/wait-production-deploy-queue.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_GH_LOG"

if [ -f "$MOCK_QUEUE_RELEASED" ]; then
  printf '[{"workflow_runs":[]}]\n'
  exit 0
fi

status=""
for argument in "$@"; do
  case "$argument" in
    status=*) status=${argument#status=} ;;
  esac
done

if [ "$status" = "in_progress" ] && [ "${MOCK_OLDER_RUN:-0}" = "1" ]; then
  cat <<JSON
[{"workflow_runs":[
  {"id":100,"name":"release-please","status":"in_progress","path":".github/workflows/release-please.yml","html_url":"https://example.test/100"},
  {"id":300,"name":"Rollback Production","status":"in_progress","path":".github/workflows/rollback-production.yml","html_url":"https://example.test/300"},
  {"id":50,"name":"Turbo","status":"in_progress","path":".github/workflows/turbo.yml","html_url":"https://example.test/50"}
]}]
JSON
else
  printf '[{"workflow_runs":[]}]\n'
fi
SH

cat >"${fake_bin}/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"$MOCK_SLEEP_LOG"
touch "$MOCK_QUEUE_RELEASED"
SH
chmod +x "${fake_bin}/gh" "${fake_bin}/sleep"

run_queue() {
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=okou-ai/okou \
    GITHUB_RUN_ID=200 \
    MOCK_GH_LOG="${tmp_dir}/gh.log" \
    MOCK_SLEEP_LOG="${tmp_dir}/sleep.log" \
    MOCK_QUEUE_RELEASED="${tmp_dir}/released" \
    PRODUCTION_DEPLOY_QUEUE_POLL_SECONDS=0 \
    PRODUCTION_DEPLOY_QUEUE_TIMEOUT_SECONDS=10 \
    "$@" \
    bash "$script"
}

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/sleep.log"
output=$(run_queue MOCK_OLDER_RUN=0)
grep -q "queue acquired by run 200" <<<"$output" || fail "expected immediate queue acquisition"
[ ! -s "${tmp_dir}/sleep.log" ] || fail "empty queue must not sleep"

: >"${tmp_dir}/gh.log"
: >"${tmp_dir}/sleep.log"
rm -f "${tmp_dir}/released"
output=$(run_queue MOCK_OLDER_RUN=1)
grep -q $'100\trelease-please\tin_progress\thttps://example.test/100' <<<"$output" || fail "expected older release to block"
if grep -q $'300\t' <<<"$output"; then
  fail "newer workflow must not block an older run"
fi
if grep -q $'50\tTurbo' <<<"$output"; then
  fail "unrelated workflow must not enter the production queue"
fi
[ "$(wc -l <"${tmp_dir}/sleep.log")" -eq 1 ] || fail "expected one poll before acquisition"
grep -q "status=in_progress" "${tmp_dir}/gh.log" || fail "expected active-run query"

echo "wait-production-deploy-queue tests passed"
