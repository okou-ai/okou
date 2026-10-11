"""Check real install-task recovery and idempotency in owned paths."""

import copy
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import yaml


def main():
    repo, archive, root = map(Path, sys.argv[1:])
    definition = yaml.safe_load(
        (repo / "ansible/tasks/provision-runner-wss-caddy.yml").read_text()
    )[0]
    tasks = copy.deepcopy(
        [
            task
            for task in definition["block"]
            if "ansible.builtin.unarchive" in task
            or task.get("register") == "runner_wss_caddy_binary"
        ]
    )
    staged, installed = root / "staged", root / "installed"
    for directory in [staged, installed]:
        directory.mkdir(parents=True)
        (directory / "caddy").write_bytes(b"unfinished binary\n")
        (directory / "caddy").chmod(0o755)
    for task in tasks:
        if "ansible.builtin.unarchive" in task:
            parameters = task["ansible.builtin.unarchive"]
            previous = parameters["dest"]
            destination = (
                installed
                if task.get("register") == "runner_wss_caddy_binary"
                else staged
            )
            parameters.update(src=str(archive), dest=str(destination))
            if "creates" in parameters:
                parameters["creates"] = parameters["creates"].replace(
                    previous, str(destination)
                )
        else:
            parameters = task["ansible.builtin.copy"]
            parameters.update(src=str(staged / "caddy"), dest=str(installed / "caddy"))
        # Isolate paths and identity; retain the actual install/registration policy.
        parameters.update(owner=str(os.getuid()), group=str(os.getgid()))
    playbook = root / "install.yml"
    playbook.write_text(
        yaml.safe_dump(
            [
                {
                    "name": "Recover interrupted Caddy installation",
                    "hosts": "all",
                    "gather_facts": False,
                    "vars": definition["vars"],
                    "tasks": tasks,
                }
            ]
        )
    )
    command = [
        shutil.which("ansible-playbook"),
        "-i",
        "localhost,",
        "-c",
        "local",
        str(playbook),
    ]
    subprocess.run(command, check=True, timeout=30)
    with tarfile.open(archive) as packed:
        with packed.extractfile("caddy") as member:
            expected = hashlib.file_digest(member, "sha256").hexdigest()
    binary = installed / "caddy"
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == expected
    subprocess.run([str(binary), "version"], check=True, timeout=5)
    unchanged = subprocess.run(
        command, check=True, capture_output=True, text=True, timeout=30
    )
    assert re.search(r"\bchanged=0\b", unchanged.stdout), unchanged.stdout

    # Repairing the cache alone must leave the healthy executable untouched.
    before = binary.stat()
    (staged / "caddy").write_bytes(b"unfinished cached binary\n")
    subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
    after = binary.stat()
    assert (after.st_ino, after.st_mtime_ns) == (before.st_ino, before.st_mtime_ns)

    # A still-executable but altered binary can be in use when reprovisioned.
    # Append before starting: overwriting a running Linux executable is forbidden.
    with binary.open("ab") as altered:
        altered.write(b"interrupted installation fixture\n")
    old_inode = binary.stat().st_ino
    config = root / "caddy.json"
    config.write_text('{"admin":{"disabled":true}}')
    environment = {
        **os.environ,
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_CONFIG_HOME": str(root / "config"),
    }
    environment.pop("NOTIFY_SOCKET", None)
    with (root / "caddy.log").open("w") as log:
        process = subprocess.Popen(
            [str(binary), "run", "--config", str(config)],
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            assert process.poll() is None
            subprocess.run(
                command, check=True, capture_output=True, text=True, timeout=30
            )
            assert hashlib.sha256(binary.read_bytes()).hexdigest() == expected
            assert binary.stat().st_ino != old_inode
            assert process.poll() is None, (root / "caddy.log").read_text()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    print(
        "Caddy install recovery, cache repair, idempotency and active replacement: ok"
    )


if __name__ == "__main__":
    main()
