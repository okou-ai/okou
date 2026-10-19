"""Unlabelled ext4 home qualification through the unchanged fixed helper."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

RETAINED = {
    ".bashrc": b"# retained user customization\n",
    ".bash_history": b"echo retained history\n",
    "workspace/retained.txt": b"synthetic retained workspace bytes\n",
}


def create_image(output, layout):
    """Create only a new fixture-owned drive, with no SELinux xattrs."""
    seed = output / "home-seed"
    seed.mkdir()
    if layout == "retained":
        for name, content in RETAINED.items():
            path = seed / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    image = output / "home.ext4"
    with image.open("xb") as stream:
        stream.truncate(96 * 1024**2)
    subprocess.run(
        ["mke2fs", "-q", "-t", "ext4", "-F", "-d", str(seed), str(image)],
        check=True,
        timeout=30,
    )
    if layout == "retained":
        for name in ("/workspace", *RETAINED):
            for field in ("uid", "gid"):
                subprocess.run(
                    [
                        "debugfs",
                        "-w",
                        "-R",
                        f"set_inode_field {name} {field} 1000",
                        str(image),
                    ],
                    check=True,
                    capture_output=True,
                    timeout=10,
                )
    for name in ["/", *(["/workspace", *RETAINED] if layout == "retained" else [])]:
        result = subprocess.run(
            ["debugfs", "-R", "ea_list " + name, str(image)],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if "security.selinux" in result.stdout:
            raise ValueError("home seed unexpectedly carries SELinux labels")
    return {
        "layout": layout,
        "unlabelledSeed": True,
        "files": {
            name: hashlib.sha256(content).hexdigest()
            for name, content in (RETAINED.items() if layout == "retained" else [])
        },
    }


def probe(record, *, repeated=False):
    manifest = json.loads(Path("/fixture/home-manifest.json").read_text())
    result = subprocess.run(
        ["/fixture/guest-home-mount"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    home = Path("/home/user")
    device = os.stat("/dev/vdb").st_rdev
    expected = f"{os.major(device)}:{os.minor(device)}"
    mounts = [
        line
        for line in Path("/proc/self/mountinfo").read_text().splitlines()
        if line.split()[4] == "/home/user"
    ]
    files = {
        name: hashlib.sha256((home / name).read_bytes()).hexdigest()
        for name in manifest["files"]
    }
    first_fresh = manifest["layout"] == "fresh" and not repeated
    defaults = all(
        (home / name).is_file() for name in (".bashrc", ".profile", ".bash_logout")
    )
    context = os.getxattr(home / "workspace", "security.selinux").decode().rstrip("\0")
    passed = (
        result.returncode == 0
        and len(mounts) == 1
        and mounts[0].split()[2:5] == [expected, "/", "/home/user"]
        and "defcontext=system_u:object_r:workload_data_t" in mounts[0]
        and home.stat().st_dev == device
        and (home / "workspace").stat().st_uid == 1000
        and files == manifest["files"]
        and (not first_fresh or defaults)
        and (manifest["layout"] != "retained" or not (home / ".profile").exists())
        and (repeated or context == "system_u:object_r:workload_data_t")
        and Path("/sys/fs/selinux/enforce").read_text().strip() == "1"
    )
    record(
        "home_helper_repeated" if repeated else "home_helper_initialization",
        passed,
        layout=manifest["layout"],
        unlabelledSeed=manifest["unlabelledSeed"],
        mount=mounts,
        context=context,
        retainedSha256=files,
        helperExit=result.returncode,
        stderr=result.stderr[-1500:],
    )


def workload_probe(env, as_role, record):
    retained = (
        json.loads(Path("/fixture/home-manifest.json").read_text())["layout"]
        == "retained"
    )
    script = """import hashlib,json,os,pathlib
path=pathlib.Path('/home/user/workspace/retained.txt' if RETAINED else '/home/user/workspace/native-home-data')
existed=path.exists(); original=path.read_bytes() if existed else b''
try:
 with path.open('ab') as stream: stream.write(b'synthetic workload append\\n')
 assert path.read_bytes()==original+b'synthetic workload append\\n'
 if existed: path.write_bytes(original)
 else: path.unlink()
 assert not existed or path.read_bytes()==original
finally:
 if existed and path.exists() and path.read_bytes()!=original: path.write_bytes(original)
print(json.dumps({'uid':os.getuid(),'context':pathlib.Path('/proc/self/attr/current').read_text().rstrip('\\0'),'retained':existed,'originalSha256':hashlib.sha256(original).hexdigest()}))
""".replace("RETAINED", repr(retained))
    observations = []
    for role in ("workload", "root"):
        result = as_role(
            role, ["/usr/bin/python3", "-c", script], env=env, group="tools"
        )
        identity = json.loads(result.stdout) if result.returncode == 0 else {}
        observations.append(
            {
                "role": role,
                "exit": result.returncode,
                "identity": identity,
                "stderr": result.stderr[-1500:],
            }
        )
    record(
        "home_workload_retained_data",
        all(
            item["exit"] == 0
            and item["identity"].get("uid") == (0 if item["role"] == "root" else 1000)
            and item["identity"].get("context") == "system_u:system_r:workload_t"
            and item["identity"].get("retained") is retained
            for item in observations
        ),
        layout="retained" if retained else "fresh",
        observations=observations,
    )
