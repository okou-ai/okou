"""Real storage helper operations on synthetic data in the disposable Guest."""

import gzip
import io
import json
import tarfile


def probe(fixture, root, env, as_role, record):
    payload = b"owned native retained data\n"
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as output:
        entry = tarfile.TarInfo("retained.txt")
        entry.size, entry.mode, entry.uid, entry.gid = len(payload), 0o644, 1000, 1000
        output.addfile(entry, io.BytesIO(payload))
    (fixture / "native-storage.tar.gz").write_bytes(
        gzip.compress(archive.getvalue(), mtime=0)
    )
    sentinel = root / "retained-before-storage.txt"
    sentinel.write_bytes(payload)
    for mode in ("file", "http"):
        target = root / ("storage-" + mode)
        url = (
            "file:///fixture/native-storage.tar.gz"
            if mode == "file"
            else "http://127.0.0.1:18081/native-storage.tar.gz"
        )
        manifest = json.dumps(
            {
                "storageMounts": [
                    {"mountPath": str(target), "archiveUrl": url, "writeback": False}
                ]
            }
        )
        prelude = """import errno,json,os,socket
from pathlib import Path
with socket.socket() as peer:
 assert peer.connect_ex(('127.0.0.1',18080)) in (errno.EACCES,errno.EPERM)
print(json.dumps({'uid':os.getuid(),'context':Path('/proc/self/attr/current').read_text().rstrip('\\0'),'cgroup':Path('/proc/self/cgroup').read_text().strip()}),flush=True)
os.execv('/fixture/guest-storage-apply',['guest-storage-apply','--manifest-stdin'])
"""
        run = as_role(
            "root",
            ["/usr/bin/python3", "-c", prelude],
            env=env,
            stdin=manifest,
            group="tools",
        )
        output = target / "retained.txt"
        observed = json.loads(run.stdout.splitlines()[0]) if run.stdout else {}
        passed = (
            run.returncode == 0
            and observed.get("uid") == 0
            and observed.get("context") == "system_u:system_r:workload_t"
            and output.is_file()
            and output.read_bytes() == payload
            and sentinel.read_bytes() == payload
            and (mode != "http" or (root / "storage-http-observed").exists())
        )
        record(
            "storage_" + mode + "_archive",
            passed,
            exit=run.returncode,
            launchIdentity=observed,
            retainedSentinelUnchanged=sentinel.read_bytes() == payload,
            stdout=run.stdout[-1500:],
            stderr=run.stderr[-2500:],
        )
