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

# Exercise the host group tasks against real NSS records and owned Unix sockets.
sudo -n --preserve-env=PYTHONPATH -- "$(command -v python3)" - \
  "$playbook" "$(command -v ansible-playbook)" <<'PY'
import grp
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import yaml

playbook, ansible = sys.argv[1:]
production = yaml.safe_load(Path(playbook).read_text())[0]
tasks = [t for t in production['tasks'] if t.get('tags') == 'runner_wss_host']

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30)

for case in ['fresh', 'legacy', 'partial', 'canonical', 'root']:
    suffix = uuid.uuid4().hex[:12]
    previous, current = f'caddyold-{suffix}', f'caddynew-{suffix}'
    if case == 'root':
        previous = 'root'
    for name in ([current] if case == 'root' else [previous, current]):
        try:
            grp.getgrnam(name)
        except KeyError:
            pass
        else:
            raise AssertionError('fixture group already exists')
    groups = []
    with tempfile.TemporaryDirectory(prefix='caddy-group-', dir='/run') as value:
        root = Path(value)
        root.chmod(0o751)
        try:
            if case not in ['fresh', 'canonical', 'root']:
                run('groupadd', '--system', previous)
                groups.append(previous)
            if case in ['partial', 'canonical']:
                run('groupadd', '--system', current)
                groups.append(current)
                if case == 'partial':
                    assert grp.getgrnam(current).gr_gid != grp.getgrnam(previous).gr_gid
            fixture = json.loads(json.dumps(tasks).replace('okou-wss-caddy', previous)
                                 .replace('okou-runner-caddy', current))
            path = root / 'provision.yml'
            path.write_text(json.dumps([{'hosts': 'all', 'gather_facts': False,
                                         'tasks': fixture}]))
            command = [ansible, '-i', 'localhost,', '-c', 'local', str(path)]
            # Claim the unique, initially absent name before Ansible can create it.
            if current not in groups:
                groups.append(current)
            if case != 'root' and previous not in groups:
                groups.append(previous)
            if case == 'root':
                rejected = subprocess.run(command, capture_output=True, text=True,
                                          timeout=30)
                assert rejected.returncode != 0 and 'must not use the root group' in rejected.stdout
                try:
                    grp.getgrnam(current)
                except KeyError:
                    pass
                else:
                    raise AssertionError('root GID created a socket access group')
                continue

            namespace = root / 'wss'
            namespace.mkdir(mode=0o710)
            endpoint = namespace / 'runner.sock'
            owner = namespace / 'runner.owner'
            owner.write_bytes(b'private owner record')
            owner.chmod(0o600)
            lock = namespace / 'runner.lock'
            lock.write_bytes(b'')
            lock.chmod(0o600)
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(endpoint))
                endpoint.chmod(0o660)
                listener.listen()
                listener.settimeout(5)
                if case != 'fresh':
                    gid = grp.getgrnam(current if case == 'canonical' else previous).gr_gid
                    os.chown(namespace, 0, gid)
                    os.chown(endpoint, 0, gid)
                def metadata():
                    return [(p.stat().st_dev, p.stat().st_ino, p.stat().st_uid,
                             p.stat().st_gid, p.stat().st_mode)
                            for p in [namespace, endpoint, owner, lock]]
                before = metadata()
                run(*command)
                gid = grp.getgrnam(current).gr_gid
                assert gid > 0 and not grp.getgrnam(current).gr_mem
                assert gid == grp.getgrnam(previous).gr_gid
                if case != 'fresh':
                    assert metadata() == before
                else:
                    os.chown(namespace, 0, gid)
                    os.chown(endpoint, 0, gid)
                unchanged = run(*command)
                assert re.search(r'\bchanged=0\b', unchanged.stdout), unchanged.stdout
                peer = subprocess.Popen(
                    [sys.executable, '-c',
                     'import socket,sys; s=socket.socket(socket.AF_UNIX); '
                     's.settimeout(5); s.connect(sys.argv[1]); s.sendall(b"ping"); '
                     'assert s.recv(4)==b"ping"; s.close()', str(endpoint)],
                    user=65534, group=gid, extra_groups=[],
                )
                try:
                    with listener.accept()[0] as client:
                        client.settimeout(5)
                        client.sendall(client.recv(4))
                    assert peer.wait(timeout=10) == 0
                finally:
                    if peer.poll() is None:
                        peer.kill()
                        peer.wait(timeout=5)
                if case != 'fresh':
                    assert metadata() == before
        finally:
            # Include a group created before a failed Ansible invocation returned.
            for name in reversed(groups):
                try:
                    grp.getgrnam(name)
                except KeyError:
                    pass
                else:
                    run('groupdel', name)
            assert all(not any(g.gr_name == name for g in grp.getgrall())
                       for name in groups)
print('Caddy group cutover: fresh/legacy/partial/canonical/root cases and socket access: ok')
PY

echo "provision-runner-kvm-test: ok"
