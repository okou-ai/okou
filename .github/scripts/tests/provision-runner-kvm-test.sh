#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"
playbook="$repo_root/ansible/playbooks/provision-runner.yml"

if ! command -v ansible-playbook >/dev/null; then
  echo "ansible-playbook is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 1
fi

ANSIBLE_CONFIG="$ansible_config" \
  ANSIBLE_NOCOLOR=1 \
  ansible-playbook \
  -i "localhost," \
  --connection=local \
  --syntax-check \
  -e "ansible_user=test" \
  "$playbook" >/dev/null

python3 - "$playbook" <<'PY'
from pathlib import Path
import sys

import yaml

playbook_path = Path(sys.argv[1])
plays = yaml.safe_load(playbook_path.read_text(encoding="utf-8"))
kvm_file_tasks = [
    task["file"]
    for play in plays
    for task in play.get("tasks", [])
    if isinstance(task.get("file"), dict) and task["file"].get("path") == "/dev/kvm"
]

if len(kvm_file_tasks) != 1:
    raise SystemExit(f"expected exactly one /dev/kvm file task, got {len(kvm_file_tasks)}")

actual = kvm_file_tasks[0]
expected = {
    "path": "/dev/kvm",
    "owner": "root",
    "group": "kvm",
    "mode": "0660",
}
if actual != expected:
    raise SystemExit(f"unexpected /dev/kvm file task: {actual!r}")
PY

echo "provision-runner-kvm-test: ok"
