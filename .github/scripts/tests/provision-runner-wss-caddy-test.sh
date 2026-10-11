#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
playbook="$repo_root/ansible/playbooks/provision-runner.yml"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export ANSIBLE_CONFIG="$repo_root/ansible/ansible.cfg"
export ANSIBLE_NOCOLOR=1
export XDG_DATA_HOME="$tmp/caddy-data"
export XDG_CONFIG_HOME="$tmp/caddy-config"

ansible-playbook -i 'localhost,' -c local --syntax-check "$playbook" >/dev/null
# The optional ingress tasks must be safe to omit on ordinary/local hosts.
ansible-playbook -i 'localhost,' -c local --tags runner_wss_caddy \
  "$playbook" >"$tmp/disabled" 2>&1
if ansible-playbook -i 'localhost,' -c local --tags runner_wss_caddy \
  -e 'runner_wss_caddy_enabled=true' "$playbook" >"$tmp/invalid" 2>&1; then
  echo 'non-public inventory hostname unexpectedly enabled WSS ingress' >&2
  exit 1
fi
if ! grep -Fq 'Caddy requires the exact public Runner inventory hostname' "$tmp/invalid"; then
  cat "$tmp/invalid" >&2
  exit 1
fi

readarray -t release < <(python3 - "$repo_root" <<'PY'
from pathlib import Path
import platform
import sys

import yaml

tasks = Path(sys.argv[1]) / 'ansible/tasks/provision-runner-wss-caddy.yml'
variables = yaml.safe_load(tasks.read_text())[0]['vars']
archive = variables['runner_wss_caddy_archives'][platform.machine()]
print(variables['runner_wss_caddy_version'])
print(archive['arch'])
print(archive['sha256'])
PY
)
if [[ "${#release[@]}" -ne 3 ]]; then
  echo 'failed to resolve pinned Caddy release' >&2
  exit 1
fi
version="${release[0]}"
caddy_archive="${RUNNER_WSS_CADDY_ARCHIVE:-$tmp/caddy.tar.gz}"
if [[ -z "${RUNNER_WSS_CADDY_ARCHIVE:-}" ]]; then
  bash "$repo_root/.github/scripts/download-verified.sh" \
    "https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_linux_${release[1]}.tar.gz" \
    "${release[2]}" "$caddy_archive"
else
  printf '%s  %s\n' "${release[2]}" "$caddy_archive" | sha256sum --check --status
fi
caddy_bin="${RUNNER_WSS_CADDY_BIN:-$tmp/caddy}"
if [[ -z "${RUNNER_WSS_CADDY_BIN:-}" ]]; then
  tar -xzf "$caddy_archive" -C "$tmp" caddy
fi
if [[ "$("$caddy_bin" version)" != "v${version} "* ]]; then
  echo 'integration test requires the pinned Caddy version' >&2
  exit 1
fi

python3 -B "$script_dir/fixtures/runner-wss-caddy-install-test.py" \
  "$repo_root" "$caddy_archive" "$tmp/install"

printf 'runner-wss.example.org ansible_connection=local\n' >"$tmp/inventory"
for template in runner-wss.Caddyfile okou-wss-caddy.service; do
  ansible -i "$tmp/inventory" all -m ansible.builtin.template \
    -a "src=$repo_root/ansible/templates/$template.j2 dest=$tmp/$template" \
    -e "runner_wss_caddy_version=$version" >/dev/null
done
"$caddy_bin" validate --config "$tmp/runner-wss.Caddyfile" --adapter caddyfile

# Run only owned loopback/Unix fixtures under an unprivileged synthetic consumer.
# Root is needed for realistic root-owned filesystem permissions, not deployment.
sudo -n -- "$(command -v python3)" -B \
  "$script_dir/fixtures/runner-wss-caddy-test.py" \
  "$repo_root" "$tmp/runner-wss.Caddyfile" "$caddy_bin"
echo 'provision-runner-wss-caddy-test: ok'
