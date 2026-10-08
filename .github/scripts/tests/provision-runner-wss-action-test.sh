#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

python3 - "$repo_root/.github/actions/provision/action.yml" "$work_dir/action.sh" <<'PY'
from pathlib import Path
import sys
import yaml

action = yaml.safe_load(Path(sys.argv[1]).read_text())
step = next(step for step in action['runs']['steps'] if step['name'] == 'Provision metal hosts')
Path(sys.argv[2]).write_text(step['run'])
PY

cat > "$work_dir/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = 'rev-parse HEAD:ansible' ]
printf '%s\n' "$MOCK_HASH"
SH
cat > "$work_dir/bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = ci@host-1 ]
printf 'ssh %s\n' "$2" >> "$MOCK_TRACE"
case "$2" in
  'cat ~/.vm0-provision-hash 2>/dev/null') cat "$MOCK_STATE/hash" ;;
  "echo ${MOCK_HASH} > ~/.vm0-provision-hash") printf '%s\n' "$MOCK_HASH" > "$MOCK_STATE/hash" ;;
  *) exit 2 ;;
esac
SH
cat > "$work_dir/bin/ansible-playbook" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "$1" = -i ] && [ "$2" = host-1, ]
printf 'ansible %s\n' "$*" >> "$MOCK_TRACE"
if [[ "$*" == *'--tags runner_wss_host'* ]]; then
  [ "$3" = ansible/playbooks/provision-runner.yml ]
  [ "$MOCK_PREPARE" = valid ] || exit 17
  printf 'prepared\n' > "$MOCK_STATE/prerequisites"
else
  [ -f "$MOCK_STATE/prerequisites" ]
fi
SH
chmod +x "$work_dir/bin/"*

run_case() {
  local name=$1 old_hash=$2 preparation=$3 expected_status=$4 expected_calls=$5
  local state="$work_dir/$name"
  mkdir -p "$state"
  printf '%s\n' "$old_hash" > "$state/hash"
  printf 'live-service\n' > "$state/service"
  local status=0
  env PATH="$work_dir/bin:$PATH" \
    HOSTS=host-1 METAL_USER=ci \
    GRAFANA_CLOUD_API_KEY=synthetic-key GRAFANA_CLOUD_PROMETHEUS_URL=https://example.test \
    GRAFANA_CLOUD_PROMETHEUS_USER=test ENV_LABEL=dev \
    MOCK_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    MOCK_STATE="$state" MOCK_TRACE="$state/trace" MOCK_PREPARE="$preparation" \
    bash -e "$work_dir/action.sh" > "$state/output" 2>&1 || status=$?
  if [ "$status" -ne "$expected_status" ]; then
    cat "$state/output" >&2
    echo "$name: unexpected action status $status" >&2
    exit 1
  fi
  [ "$(grep -c '^ansible ' "$state/trace")" -eq "$expected_calls" ]
  [ "$(cat "$state/service")" = live-service ]
  if [ "$preparation" = valid ]; then
    [ "$(cat "$state/prerequisites")" = prepared ]
    [ "$(cat "$state/hash")" = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]
  else
    [ ! -e "$state/prerequisites" ]
    [ "$(cat "$state/hash")" = "$old_hash" ]
    [ "$(wc -l < "$state/trace")" -eq 1 ]
  fi
}

run_case cached aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa valid 0 1
run_case stale bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb valid 0 3
run_case failed aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa unsafe 17 1

echo "provision-runner-wss-action-test: ok"
