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
# Ordinary provisioning must reach ingress validation without an enable flag.
if ansible-playbook -i 'localhost,' -c local --tags runner_caddy \
  "$playbook" >"$tmp/invalid" 2>&1; then
  echo 'non-public inventory hostname unexpectedly enabled WSS ingress' >&2
  exit 1
fi
if ! grep -Fq 'Caddy requires the exact public Runner inventory hostname' "$tmp/invalid"; then
  cat "$tmp/invalid" >&2
  exit 1
fi

readarray -t release < <(python3 - "$repo_root" "$tmp/caddy-tasks.json" <<'PY'
from pathlib import Path
import json
import platform
import sys

import yaml

tasks = Path(sys.argv[1]) / 'ansible/tasks/provision-runner-caddy.yml'
definition = yaml.safe_load(tasks.read_text())[0]
Path(sys.argv[2]).write_text(json.dumps(definition))
variables = definition['vars']
archive = variables['runner_caddy_archives'][platform.machine()]
print(variables['runner_caddy_version'])
print(archive['arch'])
print(archive['sha256'])
PY
)
if [[ "${#release[@]}" -ne 3 ]]; then
  echo 'failed to resolve pinned Caddy release' >&2
  exit 1
fi
version="${release[0]}"
caddy_archive="${RUNNER_CADDY_ARCHIVE:-$tmp/caddy.tar.gz}"
if [[ -z "${RUNNER_CADDY_ARCHIVE:-}" ]]; then
  bash "$repo_root/.github/scripts/download-verified.sh" \
    "https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_linux_${release[1]}.tar.gz" \
    "${release[2]}" "$caddy_archive"
else
  printf '%s  %s\n' "${release[2]}" "$caddy_archive" | sha256sum --check --status
fi
caddy_bin="${RUNNER_CADDY_BIN:-$tmp/caddy}"
if [[ -z "${RUNNER_CADDY_BIN:-}" ]]; then
  tar -xzf "$caddy_archive" -C "$tmp" caddy
fi
if [[ "$("$caddy_bin" version)" != "v${version} "* ]]; then
  echo 'integration test requires the pinned Caddy version' >&2
  exit 1
fi

python3 -B "$script_dir/fixtures/runner-caddy-install-test.py" \
  "$repo_root" "$caddy_archive" "$tmp/install"

printf 'runner-wss.example.org ansible_connection=local\n' >"$tmp/inventory"
for template in runner-caddy.Caddyfile okou-runner-caddy.service; do
  ansible -i "$tmp/inventory" all -m ansible.builtin.template \
    -a "src=$repo_root/ansible/templates/$template.j2 dest=$tmp/$template" \
    -e "runner_caddy_version=$version" >/dev/null
done
"$caddy_bin" validate --config "$tmp/runner-caddy.Caddyfile" --adapter caddyfile

# Run only owned loopback/Unix fixtures under an unprivileged synthetic consumer.
# Root is needed for realistic root-owned filesystem permissions, not deployment.
sudo -n -- "$(command -v python3)" -B \
  "$script_dir/fixtures/runner-caddy-test.py" \
  "$repo_root" "$tmp/runner-caddy.Caddyfile" "$caddy_bin"
sudo -n --preserve-env=PYTHONPATH -- "$(command -v python3)" -B \
  "$script_dir/fixtures/runner-caddy-activation-test.py" \
  "$repo_root" "$caddy_bin" "$(command -v ansible-playbook)" "$tmp/caddy-tasks.json"
echo 'provision-runner-caddy-test: ok'
