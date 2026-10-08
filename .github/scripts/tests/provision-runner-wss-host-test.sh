#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for tool in ansible-playbook python3 sudo unshare systemd-analyze; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

work_dir="$(mktemp -d)"
cleanup() {
  sudo -n rm -rf -- "$work_dir"
}
trap cleanup EXIT

# No real host namespace, account, boot policy, or service is changed.
sudo -n unshare --mount --propagation private \
  /usr/bin/python3 "$repo_root/.github/scripts/tests/fixtures/provision-runner-wss-host.py" \
  "$repo_root" "$(command -v ansible-playbook)" "$work_dir"

echo "provision-runner-wss-host-test: ok"
