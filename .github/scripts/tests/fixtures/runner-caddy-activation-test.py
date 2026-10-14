"""Exercise interrupted native Caddy activation through the real provision tasks."""

import copy
import grp
import http.client
import json
import os
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from pathlib import Path


def run(command, **kwargs):
    result = subprocess.run(
        command, check=False, capture_output=True, text=True, timeout=30, **kwargs
    )
    if result.returncode:
        sys.stderr.write(result.stdout + result.stderr)
        result.check_returncode()
    return result.stdout


def main():
    repo, caddy, ansible, task_definition = map(Path, sys.argv[1:])
    assert os.getuid() == 0, "native activation fixture requires root"
    run(["systemctl", "show", "--property=Version", "--value"])
    account = f"caddyreview-{uuid.uuid4().hex[:12]}"
    unit = f"{account}.service"
    unit_path = Path("/run/systemd/system") / unit
    assert not unit_path.exists()
    for lookup in [pwd.getpwnam, grp.getgrnam]:
        try:
            lookup(account)
        except KeyError:
            pass
        else:
            raise AssertionError("test identity already exists")
    created_group = created_user = False
    cases = []
    with tempfile.TemporaryDirectory(prefix=f"{account}-", dir="/var/lib") as name:
        root = Path(name)
        root.chmod(0o755)
        print(json.dumps({"nativeUnit": unit, "ownedRoot": str(root)}), flush=True)
        try:
            run(["groupadd", "--system", account])
            created_group = True
            run(
                [
                    "useradd",
                    "--system",
                    "--gid",
                    account,
                    "--no-create-home",
                    "--home-dir",
                    str(root / "state"),
                    "--shell",
                    "/usr/sbin/nologin",
                    account,
                ]
            )
            created_user = True
            identity = pwd.getpwnam(account)
            state = root / "state"
            state.mkdir(mode=0o700)
            os.chown(state, identity.pw_uid, identity.pw_gid)
            managed = root / "managed"
            managed.mkdir(mode=0o710)
            os.chown(managed, 0, identity.pw_gid)
            binary, config, applied = (
                root / "caddy",
                managed / "Caddyfile",
                managed / "applied-state.json",
            )
            shutil.copy2(caddy, binary)
            binary.chmod(0o755)
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            config_template = root / "Caddyfile.j2"
            config_template.write_text(
                "{\n\tadmin off\n}\nhttp://127.0.0.1:{{ fixture_port }} {\n"
                "\tbind 127.0.0.1\n\trespond {{ fixture_status }}\n}\n"
            )
            unit_template = root / "unit.service.j2"
            source = (
                repo / "ansible/templates/okou-runner-caddy.service.j2"
            ).read_text()
            source = (
                source.replace(
                    "[Service]\n",
                    "[Service]\nEnvironment=OKOU_CADDY_FIXTURE={{ fixture_marker }}\n",
                )
                .replace("User=okou-runner-caddy", f"User={account}")
                .replace("Group=okou-runner-caddy", f"Group={account}")
                .replace("/var/lib/okou-runner-caddy", str(state))
                .replace(
                    "/usr/local/lib/okou-runner-caddy/{{ runner_caddy_version }}/caddy",
                    str(binary),
                )
                .replace("/etc/okou-runner-caddy/Caddyfile", str(config))
            )
            unit_template.write_text(source)
            definition = json.loads(task_definition.read_text())
            tasks = copy.deepcopy(
                [
                    task
                    for task in definition["block"]
                    if "ansible.builtin.user" in task
                    or task.get("register")
                    in ["runner_caddy_unit", "runner_caddy_config"]
                    or task["name"] == "Recover and apply Runner Caddy deployment"
                ]
            )

            def isolate(task):
                if "block" in task:
                    for child in task["block"]:
                        isolate(child)
                if "ansible.builtin.user" in task:
                    task["ansible.builtin.user"].update(
                        name=account, group=account, home=str(state)
                    )
                if task.get("register") == "runner_caddy_unit":
                    task["ansible.builtin.template"].update(
                        src=str(unit_template), dest=str(unit_path)
                    )
                if task.get("register") == "runner_caddy_config":
                    task["ansible.builtin.template"].update(
                        src=str(config_template),
                        dest=str(config),
                        group=account,
                        validate=f"{binary} validate --config %s --adapter caddyfile",
                    )
                if "ansible.builtin.stat" in task:
                    task["loop"] = list(map(str, [binary, config, unit_path]))
                if "ansible.builtin.command" in task:
                    argv = task["ansible.builtin.command"]["argv"]
                    argv[argv.index("okou-runner-caddy.service")] = unit
                if "ansible.builtin.copy" in task:
                    parameters = task["ansible.builtin.copy"]
                    assert (
                        parameters["dest"]
                        == "/etc/okou-runner-caddy/applied-state.json"
                    )
                    parameters["dest"] = str(applied)
                if "ansible.builtin.systemd_service" in task:
                    task["ansible.builtin.systemd_service"].update(
                        name=unit, enabled=False
                    )

            for task in tasks:
                isolate(task)
            playbook = root / "provision.yml"
            environment = {
                **os.environ,
                "ANSIBLE_CONFIG": str(repo / "ansible/ansible.cfg"),
                "ANSIBLE_NOCOLOR": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
                "XDG_CONFIG_HOME": str(root / "validation"),
                "XDG_DATA_HOME": str(root / "validation"),
            }
            command = [str(ansible), "-i", "localhost,", "-c", "local", str(playbook)]

            def provision(selected=tasks, marker="before", status=404, listen=port):
                playbook.write_text(
                    json.dumps(
                        [
                            {
                                "name": "Native Caddy activation recovery",
                                "hosts": "all",
                                "gather_facts": False,
                                "vars": {
                                    **definition["vars"],
                                    "runner_caddy_binary": {"changed": False},
                                    "fixture_marker": marker,
                                    "fixture_status": status,
                                    "fixture_port": listen,
                                },
                                "tasks": selected,
                            }
                        ]
                    )
                )
                return run(command, env=environment)

            def process_state():
                pid = run(
                    ["systemctl", "show", unit, "--property=MainPID", "--value"]
                ).strip()
                entries = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                marker = next(
                    value.decode()
                    for value in entries
                    if value.startswith(b"OKOU_CADDY_FIXTURE=")
                )
                return pid, marker

            def http_status():
                with closing(
                    http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                ) as peer:
                    peer.request("GET", "/")
                    response = peer.getresponse()
                    response.read()
                    return response.status

            def unchanged(marker, status):
                before = process_state()
                output = provision(marker=marker, status=status)
                assert re.search(r"\bchanged=0\b", output), output
                assert process_state() == before and http_status() == status

            provision()
            listeners = run(["ss", "-ltnH", f"sport = :{port}"])
            assert listeners and all(
                line.split()[3] == f"127.0.0.1:{port}"
                for line in listeners.splitlines()
            ), listeners
            unchanged("before", 404)
            initial = process_state()
            unit_publication = [
                task for task in tasks if task.get("register") == "runner_caddy_unit"
            ]
            provision(unit_publication, marker="after")
            assert process_state() == initial
            provision(marker="after")
            assert process_state()[0] != initial[0]
            assert process_state()[1] == "OKOU_CADDY_FIXTURE=after"
            cases.append("interrupted unit publication")

            config_publication = [
                task for task in tasks if task.get("register") == "runner_caddy_config"
            ]
            before = process_state()
            provision(config_publication, marker="after", status=410)
            assert process_state() == before and http_status() == 404
            provision(marker="after", status=410)
            assert process_state()[0] != before[0] and http_status() == 410
            cases.append("interrupted config publication")

            committed_state = applied.read_bytes()
            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", 0))
                occupied.listen()
                try:
                    provision(
                        marker="after", status=410, listen=occupied.getsockname()[1]
                    )
                except subprocess.CalledProcessError:
                    assert applied.read_bytes() == committed_state
                else:
                    raise AssertionError(
                        "Caddy unexpectedly activated on an occupied port"
                    )
            provision(config_publication, marker="after", status=410)
            provision(marker="after", status=410)
            assert http_status() == 410
            cases.append("failed activation retains prior receipt and recovers")

            run(["systemctl", "restart", unit])
            restarted = process_state()
            provision(marker="after", status=410)
            assert process_state()[0] != restarted[0]
            unchanged("after", 410)
            cases.append("new service invocation is reapplied once")
            metadata = applied.stat()
            assert (
                stat.S_IMODE(metadata.st_mode) == 0o600
                and metadata.st_uid == metadata.st_gid == 0
            )
            assert (
                subprocess.run(
                    ["test", "-r", str(applied)],
                    check=False,
                    user=identity.pw_uid,
                    group=identity.pw_gid,
                    extra_groups=[],
                ).returncode
                == 1
            )
        except BaseException:
            sys.stderr.write(
                subprocess.run(
                    ["journalctl", "-u", unit, "--no-pager", "-n", "30"],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                ).stdout
            )
            raise
        finally:
            if unit_path.exists():
                run(["systemctl", "stop", unit])
                unit_path.unlink()
                run(["systemctl", "daemon-reload"])
            if created_user:
                run(["userdel", account])
            if created_group:
                try:
                    grp.getgrnam(account)
                except KeyError:
                    pass
                else:
                    run(["groupdel", account])
    assert not root.exists() and not unit_path.exists()
    print(json.dumps({"cases": cases, "ownedNativeStateRemoved": True}))


if __name__ == "__main__":
    main()
