"""Run real host preparation against private mount-namespace fixtures."""

import grp
import os
import shlex
import shutil
import socket
import stat
import struct
import subprocess
import sys
from pathlib import Path

REPO = Path(sys.argv[1])
ANSIBLE = sys.argv[2]
WORK = Path(sys.argv[3])
HELPER = Path("/usr/local/libexec/okou-runner-wss-host-prepare.py")
POLICY = Path("/etc/systemd/system/vm0-runner-.service.d/10-wss-host.conf")
NAMESPACE = Path("/run/okou-ws")


def command(arguments, **kwargs):
    return subprocess.run(
        arguments, text=True, capture_output=True, check=False, **kwargs
    )


def mount(source, target):
    subprocess.run(["mount", "--bind", str(source), target], check=True)


def snapshot(path):
    metadata = path.lstat()
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        stat.S_IMODE(metadata.st_mode),
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def require_success(result):
    if result.returncode:
        raise AssertionError(f"{result.args}: {result.stdout}\n{result.stderr}")


def helper(success=True):
    result = command(["/usr/bin/python3", str(HELPER)])
    if success:
        require_success(result)
    else:
        assert result.returncode != 0, result.stdout
    return result


def ansible(playbook="provision-runner.yml", success=True, tagged=True):
    arguments = [
        ANSIBLE,
        "-i",
        "localhost,",
        "--connection=local",
        "-e",
        "ansible_user=tester",
        "-e",
        "ansible_become=false",
        "-e",
        "ansible_python_interpreter=/usr/bin/python3",
        "-e",
        "runner_version=999.0.0",
        "-e",
        "rollback_mode=emergency",
        str(REPO / "ansible/playbooks" / playbook),
    ]
    if tagged:
        arguments.extend(["--tags", "runner_wss_host"])
    result = command(arguments, env=ENV)
    if success:
        require_success(result)
    else:
        assert result.returncode != 0, result.stdout
    return result


def require_namespace():
    metadata = NAMESPACE.lstat()
    assert stat.S_ISDIR(metadata.st_mode)
    assert metadata.st_uid == 0 and metadata.st_gid == GROUP_ID
    assert stat.S_IMODE(metadata.st_mode) == 0o710


# Account records are synthetic, not copied from the real host.
etc = WORK / "etc"
(etc / "systemd/system").mkdir(parents=True)
(etc / "passwd").write_text(
    "root:x:0:0:root:/root:/bin/bash\ntester:x:1000:1000:test:/home/tester:/bin/bash\n"
)
(etc / "group").write_text("root:x:0:\ntester:x:1000:\n")
(etc / "gshadow").write_text("root:::\ntester:::\n")
(etc / "gshadow").chmod(0o600)
(etc / "nsswitch.conf").write_text(
    "passwd: files\ngroup: files\nshadow: files\nhosts: files dns\n"
)
(etc / "login.defs").write_text(
    "SYS_GID_MIN 600\nSYS_GID_MAX 999\nGID_MIN 1000\nGID_MAX 60000\n"
)
(etc / "hosts").write_text("127.0.0.1 localhost vm0-guest\n")
shutil.copyfile("/usr/lib/os-release", etc / "os-release")
runtime = WORK / "run"
local = WORK / "local"
runtime.mkdir()
local.mkdir()
mount(etc, "/etc")
mount(runtime, "/run")
# Hosted runners may install Ansible/Python under /usr/local. Preserve those
# tools read-only while keeping the managed libexec namespace isolated.
for name in ("bin", "lib"):
    original = Path("/usr/local") / name
    if original.is_dir():
        preserved = local / name
        preserved.mkdir()
        mount(original, str(preserved))
        subprocess.run(["mount", "-o", "remount,bind,ro", str(preserved)], check=True)
subprocess.run(["mount", "--rbind", str(local), "/usr/local"], check=True)
assert Path(ANSIBLE).is_file(), (
    "private fixtures must preserve the provided Ansible tool"
)

fake_bin = WORK / "bin"
fake_bin.mkdir()
reload_log = WORK / "systemctl.log"
reload_failure = WORK / "fail-reload"
(fake_bin / "systemctl").write_text(
    "#!/bin/sh\n"
    f"printf '%s\\n' \"$*\" >> '{reload_log}'\n"
    '[ "$*" = daemon-reload ] && '
    f"[ ! -e '{reload_failure}' ]\n"
)
(fake_bin / "systemctl").chmod(0o755)
ENV = {
    **os.environ,
    "PATH": f"{fake_bin}:{os.environ['PATH']}",
    "ANSIBLE_CONFIG": str(REPO / "ansible/ansible.cfg"),
    "ANSIBLE_NOCOLOR": "1",
    "ANSIBLE_GATHERING": "explicit",
}

# A failed manager reload must not be hidden by unchanged files on retry.
# The real tagged production playbook creates group, helper, policy, namespace.
reload_failure.touch()
ansible(success=False)
reload_failure.unlink()
retry = ansible()
assert "changed=0" in retry.stdout, retry.stdout
GROUP_ID = grp.getgrnam("okou-wss-caddy").gr_gid
assert GROUP_ID != os.getegid()
assert grp.getgrnam("okou-wss-caddy").gr_mem == []
require_namespace()
assert HELPER.stat().st_uid == POLICY.stat().st_uid == 0
assert reload_log.read_text() == "daemon-reload\ndaemon-reload\n"
assert not (Path("/etc/systemd/system") / "okou-wss-caddy.service").exists()
assert shutil.which("caddy", path=ENV["PATH"]) is None

# Preserve a real listening endpoint and an already-established connection.
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
endpoint = NAMESPACE / "live.sock"
listener.bind(str(endpoint))
listener.listen(1)
os.chown(endpoint, 0, GROUP_ID)
endpoint.chmod(0o660)
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(str(endpoint))
peer, _ = listener.accept()
namespace_before = snapshot(NAMESPACE)
endpoint_before = snapshot(endpoint)
repeat = ansible()
assert "changed=0" in repeat.stdout, repeat.stdout
assert snapshot(NAMESPACE) == namespace_before
assert snapshot(endpoint) == endpoint_before
assert reload_log.read_text() == "daemon-reload\ndaemon-reload\ndaemon-reload\n"
client.sendall(b"still connected")
assert peer.recv(64) == b"still connected"
peer.close()
client.close()
listener.close()

# Reject existing directory conflicts without repairing it or its child socket.
for mode, owner, group in [
    (0o755, 0, GROUP_ID),
    (0o777, 0, GROUP_ID),
    (0o2710, 0, GROUP_ID),
    (0o710, 1000, GROUP_ID),
    (0o710, 0, 0),
]:
    NAMESPACE.chmod(mode)
    os.chown(NAMESPACE, owner, group)
    before = snapshot(NAMESPACE)
    helper(success=False)
    assert snapshot(NAMESPACE) == before
    assert snapshot(endpoint) == endpoint_before
    if mode == 0o755:
        # Also exercise Ansible's read-only preflight and the full promotion
        # boundary: neither may reach cutover or touch an existing endpoint.
        failed = ansible(success=False)
        assert "refusing repair" in failed.stdout
        for playbook in ("promote-runner.yml", "rollback-runner.yml"):
            failed = ansible(playbook, success=False, tagged=False)
            assert "refusing repair" in failed.stdout
        assert snapshot(NAMESPACE) == before
        assert snapshot(endpoint) == endpoint_before
    os.chown(NAMESPACE, 0, GROUP_ID)
    NAMESPACE.chmod(0o710)

# ACL masks can look like exact 0710 while admitting a named ordinary user.
acl = struct.pack("<I", 2) + b"".join(
    struct.pack("<HHI", tag, permission, identifier)
    for tag, permission, identifier in [
        (1, 7, 0xFFFFFFFF),
        (2, 1, 1000),
        (4, 1, 0xFFFFFFFF),
        (16, 1, 0xFFFFFFFF),
        (32, 0, 0xFFFFFFFF),
    ]
)
for attribute in ("system.posix_acl_access", "system.posix_acl_default"):
    os.setxattr(NAMESPACE, attribute, acl)
    require_namespace()
    before = snapshot(NAMESPACE)
    helper(success=False)
    assert snapshot(NAMESPACE) == before
    assert os.getxattr(NAMESPACE, attribute) == acl
    assert snapshot(endpoint) == endpoint_before
    os.removexattr(NAMESPACE, attribute)
os.setxattr("/run", "system.posix_acl_default", acl)
before = snapshot(NAMESPACE)
helper(success=False)
assert snapshot(NAMESPACE) == before
os.removexattr("/run", "system.posix_acl_default")

# Parent trust is checked both by the native pre-start helper and Ansible.
Path("/run").chmod(0o777)
before = snapshot(NAMESPACE)
helper(success=False)
failed = ansible(success=False)
assert "Unsafe Runner WSS parent /run" in failed.stdout
assert snapshot(NAMESPACE) == before
Path("/run").chmod(0o755)
os.chown("/run", 1000, 0)
helper(success=False)
os.chown("/run", 0, 0)

# A managed helper symlink must not be followed or overwritten by provisioning.
saved_helper = HELPER.read_bytes()
HELPER.unlink()
foreign_helper = WORK / "foreign-helper"
foreign_helper.write_text("do not overwrite\n")
HELPER.symlink_to(foreign_helper)
before = snapshot(foreign_helper)
failed = ansible(success=False)
assert "Unsafe Runner WSS installation path" in failed.stdout
assert HELPER.is_symlink() and snapshot(foreign_helper) == before
HELPER.unlink()
HELPER.write_bytes(saved_helper)
HELPER.chmod(0o755)

# A missing persistent group or a non-root caller cannot prepare the namespace.
saved_groups = Path("/etc/group").read_text()
Path("/etc/group").write_text("root:x:0:\ntester:x:1000:\n")
before = snapshot(NAMESPACE)
helper(success=False)
assert snapshot(NAMESPACE) == before
Path("/etc/group").write_text(saved_groups)


def become_tester():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)


result = command(["/usr/bin/python3", str(HELPER)], preexec_fn=become_tester)
assert result.returncode != 0
assert snapshot(NAMESPACE) == before

# Fixtures are removed only by the test owner, never by production preparation.
endpoint.unlink()
NAMESPACE.rmdir()
foreign = Path("/run/foreign")
foreign.mkdir(mode=0o710)
os.chown(foreign, 0, GROUP_ID)
NAMESPACE.symlink_to(foreign, target_is_directory=True)
before = snapshot(foreign)
helper(success=False)
assert NAMESPACE.is_symlink() and snapshot(foreign) == before
NAMESPACE.unlink()
NAMESPACE.write_text("foreign file\n")
before = snapshot(NAMESPACE)
helper(success=False)
assert snapshot(NAMESPACE) == before
NAMESPACE.unlink()

# Configured ExecStartPre restores volatile state before the Runner command.
pre_start = next(
    line.removeprefix("ExecStartPre=")
    for line in POLICY.read_text().splitlines()
    if line.startswith("ExecStartPre=")
)
fresh_runtime = WORK / "boot-run"
fresh_runtime.mkdir()
mount(fresh_runtime, "/run")
assert not NAMESPACE.exists()
require_success(command(shlex.split(pre_start)))
require_namespace()

# systemd itself must resolve the prefix policy for release and preview names.
for name in ("vm0-runner-v999.0.0.service", "vm0-runner-pr-38073-1.service"):
    unit = Path("/etc/systemd/system") / name
    unit.write_text("[Service]\nType=simple\nExecStart=/usr/bin/true\n")
    result = command(
        ["systemd-analyze", "verify", "--man=no", "--generators=no", str(unit)],
        env={**ENV, "SYSTEMD_LOG_LEVEL": "debug"},
    )
    require_success(result)
    parsed = result.stdout + result.stderr
    assert "ExecStartPre:" in parsed and str(HELPER) in parsed, parsed

NAMESPACE.rmdir()
processes = [
    subprocess.Popen(
        ["/usr/bin/python3", str(HELPER)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for _ in range(2)
]
outputs = [process.communicate() for process in processes]
assert all(process.returncode == 0 for process in processes), outputs
assert sorted(output[0] for output in outputs) == ["", "created\n"]
require_namespace()
print(
    "native Runner WSS provisioning, endpoint preservation and pre-start restoration: ok"
)
