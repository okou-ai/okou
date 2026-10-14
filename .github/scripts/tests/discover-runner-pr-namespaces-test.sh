#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/runner/discover-runner-pr-namespaces.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

fake_bin="${test_root}/bin"
mkdir -p "$fake_bin"

cat >"${fake_bin}/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  tester@primary.example)
    cat <<'RESOURCES'
vm0-runner-pr-12-0.service
vm0-runner-pr-123-4.service
vm0-runner-pr-25722-vercel-2.service
vm0-runner-pr-31552-test-process-containment.service
vm0-runner-pr-99-version.1.service
pr-77
benchmark-pr-88-test
vm0-runner-staging-0.service
vm0-runner-pr-012-1.service
vm0-runner-pr-12x-1.service
RESOURCES
    ;;
  tester@empty.example)
    ;;
  tester@unreachable.example)
    exit 255
    ;;
  *)
    echo "unexpected host: $1" >&2
    exit 2
    ;;
esac
FAKE_SSH
chmod +x "${fake_bin}/ssh"

run_discovery() {
  local hosts=$1
  local output_file=$2
  PATH="${fake_bin}:$PATH" \
    GITHUB_OUTPUT="$output_file" \
    METAL_HOSTS="$hosts" \
    METAL_USER=tester \
    "$script"
}

partial_output="${test_root}/partial-output"
partial_log="${test_root}/partial-log"
partial_errors="${test_root}/partial-errors"
run_discovery \
  "primary.example, unreachable.example" \
  "$partial_output" >"$partial_log" 2>"$partial_errors"

if [ "$(cat "$partial_output")" != 'numbers=[12,77,88,99,123,25722,31552]' ]; then
  echo "unexpected discovered PR namespaces:" >&2
  cat "$partial_output" >&2
  exit 1
fi
grep -Fq 'Unable to inspect runner resources on unreachable.example' "$partial_errors"
grep -Fq 'Discovered runner resources for PRs: [12,77,88,99,123,25722,31552]' "$partial_log"

empty_output="${test_root}/empty-output"
run_discovery "empty.example" "$empty_output" >/dev/null
if [ "$(cat "$empty_output")" != 'numbers=[]' ]; then
  echo "a reachable host with no resources must produce an empty list" >&2
  exit 1
fi

failed_output="${test_root}/failed-output"
if run_discovery "unreachable.example" "$failed_output" >/dev/null 2>"${test_root}/failed-errors"; then
  echo "discovery must fail when every configured host is unreachable" >&2
  exit 1
fi
grep -Fq 'failed to inspect runner resources on any configured metal host' "${test_root}/failed-errors"

echo "discover-runner-pr-namespaces-test: ok"
