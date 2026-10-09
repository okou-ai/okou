#!/usr/bin/env python3
"""Bounded local-only independent QEMU/Cyrus/KDC fixture; never a production client.

Requires the source-pinned QEMU9.2.0 binary and privately extracted Ubuntu native
fixture packages described in QEMU_GSSAPI.md. No global package/config changes.
All generated credential content is supplied over private stdin/files, not argv.
"""
import argparse
import ctypes
import hashlib
import os
import pathlib
import platform
import json
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time

REPO = pathlib.Path(__file__).resolve().parents[4]
QEMU_SHA256 = "cef1a9a4a18daad78f74b4997fafdb3c18aeaead1596732bf6c5bc5bb32eabc8"


def port():
    with socket.socket() as stream:
        stream.bind(("127.0.0.1", 0))
        return stream.getsockname()[1]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    else:
        process.wait(timeout=5)


def wait_port(process, value):
    until = time.monotonic() + 5
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError("independent fixture exited before readiness")
        try:
            with socket.create_connection(("127.0.0.1", value), 0.1):
                return
        except OSError:
            time.sleep(0.025)
    raise RuntimeError("independent fixture readiness exhausted")


def run(argv, env, data=None):
    result = subprocess.run([str(arg) for arg in argv], env=env, input=data, capture_output=True, timeout=25)
    if result.returncode:
        # The private outputs may contain fixture credentials. Never echo causes.
        raise RuntimeError("independent fixture command refused: " + pathlib.Path(argv[0]).name)
    return result.stdout


def verify_full_private_programs(runtime, baseline):
    # A mode hashed in reviewed metadata is not an observation of the actual
    # file. Recheck each executable role before credentials/native execution.
    roles = baseline["requiredBuildInputs"]
    if not isinstance(roles, dict) or not roles:
        raise ValueError("full-private executable roles required")
    machine = {"amd64": 62, "arm64": 183}[baseline["architecture"]]
    for name, record in roles.items():
        relative, declared = pathlib.PurePosixPath(name), pathlib.PurePosixPath(record["file"])
        if (relative.is_absolute() or declared.is_absolute() or ".." in relative.parts
                or ".." in declared.parts or not relative.parts or not declared.parts):
            raise ValueError("full-private executable role path refused")
        try:
            actual = (runtime / relative).resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ValueError("full-private executable role missing") from error
        if (not actual.is_relative_to(runtime) or not actual.is_file()
                or str(actual.relative_to(runtime)) != str(declared)
                or baseline["files"].get(str(declared)) != record["sha256"]):
            raise ValueError("full-private executable role target refused")
        with actual.open("rb") as stream:
            mode = stat.S_IMODE(os.fstat(stream.fileno()).st_mode)
            if (type(record["mode"]) is not int or mode != record["mode"]
                    or not mode & 0o111 or not os.access(actual, os.X_OK)):
                raise ValueError("full-private executable role mode refused")
            header = stream.read(64)
            if (len(header) != 64 or header[:6] != b"\x7fELF\x02\x01"
                    or int.from_bytes(header[18:20], "little") != machine):
                raise ValueError("full-private executable role native identity refused")
            digest = hashlib.sha256(header)
            for data in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(data)
            if digest.hexdigest() != record["sha256"]:
                raise ValueError("full-private executable role digest refused")


IMMUTABLE_NODE_LIMIT = 20000
# Count all initial/rescan entry-name bytes, before list/sort/hex allocation.
IMMUTABLE_NAME_BYTE_LIMIT = 8 * 1024 * 1024


def immutable_tree_digest(tree):
    # Version/domain separation prevents reuse of a files/aliases-only digest.
    return hashlib.sha256(b"qemu-full-private-tree-v2\x00" + json.dumps(
        tree, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def measure_immutable_tree(root):
    """Measure a quiescent public staging tree; NEVER mint a mount/source seal.

    No prefix exclusions, mounted-root pruning, native execution or secret
    inputs. Descriptor/metadata checks detect observed drift, not an outside
    writer's change-and-restore attack. A trusted controller remains required.
    """
    root = pathlib.Path(root).absolute()
    if root == pathlib.Path("/") or root.is_symlink() or root.resolve(strict=True) != root:
        raise ValueError("immutable staging root refused; mounted controller unavailable")
    nodes, links, link_counts = {}, {}, {}
    total = 0
    name_bytes = 0
    discovered_nodes = 1  # root plus every initially enumerated (even pending) child
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)

    def attributes(target, *, follow_symlinks=True):
        names = os.listxattr(target, follow_symlinks=follow_symlinks) if isinstance(target, str) else os.listxattr(target)
        if len(names) > 64:
            raise ValueError("immutable attribute budget refused")
        records, size = {}, 0
        for name in sorted(names, key=os.fsencode):
            data = (os.getxattr(target, name, follow_symlinks=follow_symlinks)
                    if isinstance(target, str) else os.getxattr(target, name))
            size += len(data)
            if size > 65536:
                raise ValueError("immutable attribute byte budget refused")
            records[os.fsencode(name).hex()] = {"sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        return records

    def list_children(fd, maximum, *, initial):
        nonlocal name_bytes, discovered_nodes
        names, seen = [], set()
        # scandir(fd) advances the held directory incrementally. Refuse BEFORE
        # collecting/sorting/hex-projecting its first excess entry, including
        # on rescan; a timeout or later per-node guard cannot bound listdir.
        with os.scandir(fd) as entries:
            for entry in entries:
                name = entry.name
                width = len(os.fsencode(name))
                if len(names) >= maximum:
                    raise ValueError("immutable directory entry budget refused")
                if name_bytes + width > IMMUTABLE_NAME_BYTE_LIMIT:
                    raise ValueError("immutable directory name byte budget refused")
                if name in seen:
                    raise ValueError("immutable duplicate directory entry refused")
                name_bytes += width
                seen.add(name)
                names.append(name)
                if initial:
                    discovered_nodes += 1
        return sorted(names, key=os.fsencode)

    def walk(parent, name, relative, depth):
        nonlocal total
        if depth > 128 or len(nodes) >= IMMUTABLE_NODE_LIMIT or len(os.fsencode(relative)) > 4096:
            raise ValueError("immutable node/path budget refused")
        before = os.fstat(parent) if name is None else os.stat(name, dir_fd=parent, follow_symlinks=False)
        row = {"pathHex": os.fsencode(relative).hex(), "mode": stat.S_IMODE(before.st_mode),
               "uid": before.st_uid, "gid": before.st_gid}
        nodes[relative] = row
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(name, dir_fd=parent)
            if target.startswith("/") or len(os.fsencode(target)) > 4096:
                raise ValueError("immutable absolute/overlong alias refused")
            if len(os.fsencode(target)) != before.st_size:
                raise ValueError("immutable alias size changed")
            # proc resolves only the held parent descriptor; the final alias is
            # explicitly NOT followed. Missing/unreadable xattrs refuse.
            attrs = attributes(f"/proc/self/fd/{parent}/{name}", follow_symlinks=False)
            row.update(kind="alias", sizeBytes=before.st_size, target=target, targetHex=os.fsencode(target).hex(), xattrs=attrs)
        elif stat.S_ISDIR(before.st_mode):
            fd = os.dup(parent) if name is None else os.open(name, directory_flags, dir_fd=parent)
            try:
                if identity(os.fstat(fd)) != identity(before):
                    raise ValueError("immutable directory identity changed")
                children = list_children(fd, IMMUTABLE_NODE_LIMIT - discovered_nodes, initial=True)
                row.update(kind="directory", children=[os.fsencode(child).hex() for child in children], xattrs=attributes(fd))
                for child in children:
                    walk(fd, child, child if relative == "." else relative + "/" + child, depth + 1)
                if (children != list_children(fd, len(children), initial=False)
                        or identity(os.fstat(fd)) != identity(before)):
                    raise ValueError("immutable directory changed while measured")
            finally:
                os.close(fd)
        elif stat.S_ISREG(before.st_mode):
            total += before.st_size
            if before.st_size > 128 * 1024 * 1024 or total > 2 * 1024 * 1024 * 1024:
                raise ValueError("immutable regular byte budget refused")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
            try:
                if identity(os.fstat(fd)) != identity(before):
                    raise ValueError("immutable regular identity changed")
                digest, size = hashlib.sha256(), 0
                while data := os.read(fd, 1024 * 1024):
                    size += len(data)
                    if size > before.st_size:
                        raise ValueError("immutable regular grew while measured")
                    digest.update(data)
                attrs = attributes(fd)
                if size != before.st_size or identity(os.fstat(fd)) != identity(before):
                    raise ValueError("immutable regular changed while measured")
                row.update(kind="regular", sizeBytes=size, sha256=digest.hexdigest(), xattrs=attrs)
            finally:
                os.close(fd)
        else:
            raise ValueError("immutable special input refused")
        # POSIX also permits hardlinked symlinks; their equivalence and outside
        # links must not disappear just because target bytes happen to match.
        if row["kind"] in ("regular", "alias"):
            key = (before.st_dev, before.st_ino)
            links.setdefault(key, []).append(relative)
            link_counts[key] = before.st_nlink
        after = os.fstat(parent) if name is None else os.stat(name, dir_fd=parent, follow_symlinks=False)
        if identity(after) != identity(before):
            raise ValueError("immutable dentry changed while measured")

    fd = os.open(root, directory_flags)
    try:
        if identity(os.fstat(fd)) != identity(root.lstat()):
            raise ValueError("immutable root identity changed")
        walk(fd, None, ".", 0)
        if identity(os.fstat(fd)) != identity(root.lstat()):
            raise ValueError("immutable root replaced while measured")
    finally:
        os.close(fd)
    hardlinks = []
    for key, paths in links.items():
        if len(paths) != link_counts[key]:
            raise ValueError("immutable external hardlink refused")
        if len(paths) > 1:
            hardlinks.append(sorted(paths, key=os.fsencode))

    def resolve_alias(name):
        pending, resolved, count = name.split("/"), [], 0
        while pending:
            part = pending.pop(0)
            if part in ("", "."):
                continue
            if part == "..":
                if not resolved:
                    raise ValueError("immutable alias escaped")
                resolved.pop()
                continue
            path = "/".join(resolved + [part])
            node = nodes.get(path)
            if node is None:
                # Even a dangling suffix must not lexically escape the root.
                # Missing inputs remain exact DATA, never executable admission.
                suffix = resolved + [part]
                for word in pending:
                    if word in ("", "."):
                        continue
                    if word == "..":
                        if not suffix:
                            raise ValueError("immutable dangling alias escaped")
                        suffix.pop()
                    else:
                        suffix.append(word)
                return {"pathHex": os.fsencode("/".join(suffix) or ".").hex(),
                        "missingPrefixHex": os.fsencode(path).hex(), "kind": "missing"}
            if node["kind"] == "alias":
                count += 1
                if count > 40:
                    raise ValueError("immutable alias loop/depth refused")
                pending = node["target"].split("/") + pending
            else:
                if pending and node["kind"] != "directory":
                    raise ValueError("immutable alias traverses nondirectory")
                resolved.append(part)
        path = "/".join(resolved) if resolved else "."
        return {"pathHex": os.fsencode(path).hex(), "kind": nodes[path]["kind"]}

    for name, row in nodes.items():
        if row["kind"] == "alias":
            row["resolution"] = resolve_alias(name)
    return {"schemaVersion": 2, "nodes": nodes, "hardlinkGroups": sorted(hardlinks)}


def full_private_inventory(runtime, baseline):
    verify_full_private_programs(runtime, baseline)
    actual = measure_immutable_tree(runtime)
    if actual != baseline["immutableTree"]:
        raise ValueError("full-private complete input inventory refused")
    files = {name: row["sha256"] for name, row in actual["nodes"].items() if row["kind"] == "regular"}
    aliases = {name: row["target"] for name, row in actual["nodes"].items() if row["kind"] == "alias"}
    if files != baseline["files"] or aliases != baseline["aliases"]:
        raise ValueError("full-private complete input projection refused")
    return immutable_tree_digest(actual)


def verify_runtime(runtime, multiarch, full_qemu, source_pinned_full=False, contract_root=None):
    # The producer must obtain these records from verified signed archives, not
    # hash an arbitrary installed tree. Rechecking bytes does not attest loader
    # resolution, transitive closure, host MIT or a historical runtime result.
    architecture = {"x86_64-linux-gnu": "amd64", "aarch64-linux-gnu": "arm64"}[multiarch]
    if source_pinned_full:
        pins = json.loads((REPO / "crates/rfb-client/tests/fixtures/qemu_gssapi_full_pins.json").read_text())
        native = {"amd64": "x86_64", "arm64": "aarch64"}[architecture]
        expected = pins["architectures"].get(native)
        if expected is None:
            raise ValueError("source-built QEMU lacks reviewed native producer pins")
        if pins.get("schemaVersion") != 2 or pins.get("provider") != "source-pinned-private-noble-v2":
            raise ValueError("source-built reviewed pin profile version refused")
        # Complete quiescent measurements cannot authorize mounted execution.
        # Never scan live / without an independently implemented controller.
        if runtime == pathlib.Path("/"):
            raise ValueError("source-built mounted-input controller unavailable")
        if (contract_root is None or not contract_root.is_absolute() or contract_root.is_symlink()
                or contract_root.resolve(strict=True) != contract_root.absolute()
                or contract_root.is_relative_to(runtime)):
            raise ValueError("detached source-built contract required")
        manifest = contract_root / "provider.json"
    else:
        if contract_root is not None:
            raise ValueError("detached source-built contract cannot override other profiles")
        manifest = runtime / "provider.json"
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("independent fixture provider manifest required")
    baseline = json.loads(manifest.read_text())
    if baseline.get("architecture") != architecture:
        raise ValueError("independent fixture package architecture refused")
    if baseline["multiarch"] != multiarch or baseline["mitVersion"] != "1.20.1-6ubuntu2":
        raise ValueError("independent fixture MIT identity refused")
    required = {name: "1.20.1-6ubuntu2" for name in (
        "libgssapi-krb5-2", "libkrb5-3", "libk5crypto3", "libkrb5support0",
        "krb5-user", "krb5-kdc", "krb5-admin-server")}
    if full_qemu:
        required.update({name: "2.1.28+dfsg1-5ubuntu3" for name in (
            "libsasl2-2", "libsasl2-modules-gssapi-mit")})
        required["libgnutls30t64"] = "3.8.3-1.1ubuntu3.6"
    if any(name not in baseline["packages"] or baseline["packages"][name]["version"] != version
           or baseline["packages"][name].get("architecture") != architecture
           for name, version in required.items()):
        raise ValueError("independent fixture package identity refused")
    for name, digest in baseline["files"].items():
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("independent fixture file path refused")
        path = runtime / relative
        if path.is_symlink() or not path.is_file() or not path.resolve(strict=True).is_relative_to(runtime):
            raise ValueError("independent fixture file escaped its runtime")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("independent fixture file digest refused")
    libraries = ("libgssapi_krb5.so.2", "libkrb5.so.3", "libk5crypto.so.3", "libkrb5support.so.0")
    if full_qemu:
        libraries += ("libsasl2.so.2", "sasl2/libgssapiv2.so.2", "libgnutls.so.30")
    used = [f"usr/lib/{multiarch}/{name}" for name in libraries]
    used += ["usr/sbin/kdb5_util", "usr/sbin/kadmin.local", "usr/sbin/krb5kdc",
             "usr/bin/kinit.mit", "usr/bin/kvno", "usr/bin/klist.mit"]
    if full_qemu:
        used += ["usr/share/seabios/bios.bin", "usr/share/seabios/vgabios-stdvga.bin"]
    for name in used:
        path = (runtime / name).resolve(strict=True)
        if not path.is_relative_to(runtime) or str(path.relative_to(runtime)) not in baseline["files"]:
            raise ValueError("independent fixture used input has no verified file record")
    if source_pinned_full:
        if not full_qemu or baseline.get("fullQemuProvider") != "source-pinned-private-noble-v2":
            raise ValueError("explicit version2 full-private source provider required")
        build = baseline["qemuBuild"]
        binary = runtime / "usr/bin/qemu-system-x86_64"
        recipe = REPO / ".github/scripts/prepare-qemu-gssapi-fixture.py"
        package_lock = hashlib.sha256(json.dumps(baseline["packages"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        inventory_digest = full_private_inventory(runtime, baseline)
        closure_digest = hashlib.sha256(json.dumps({name: baseline[name] for name in
                    ("signedIndexFiles", "bootstrapInputs", "transformations", "signingRootSha256", "requiredBuildInputs", "inputMeasurementSourceSha256")},
                    sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        contract_digest = immutable_tree_digest(measure_immutable_tree(contract_root))
        if (inventory_digest != expected.get("runtimeInventorySha256")
            or contract_digest != expected.get("contractInventorySha256")
            or hashlib.sha256(manifest.read_bytes()).hexdigest() != expected.get("providerSha256")
            or baseline["inputMeasurementSourceSha256"] != hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
            or closure_digest != expected.get("inputClosureSha256")
            or build["sourceAdmission"] != expected.get("sourceAdmission")
            or build["firmware"] != expected.get("firmware")
            or build["configure"] != expected.get("configure")
            or build["version"] != "9.2.0" or build["target"] != "x86_64-softmmu" or build["nativeArchitecture"] != native
            or build["sourceArchiveSha256"] != "f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894"
            or build["vncSourceSha256"] != "3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d"
            or baseline["snapshot"] != "20260521T000000Z" or package_lock != expected["packageLockSha256"]
            or package_lock != baseline["packageLockSha256"] or build["recipeSha256"] != expected["recipeSha256"]
            or hashlib.sha256(recipe.read_bytes()).hexdigest() != expected["recipeSha256"]
            or build["binarySha256"] != expected["binarySha256"] or build["secondBuildSha256"] != expected["binarySha256"]
            or hashlib.sha256(binary.read_bytes()).hexdigest() != expected["binarySha256"]):
            raise ValueError("source-built QEMU producer identity refused")
        # These are complete DATA checks, not an authenticated mount epoch or
        # loader/open witness. Keep execution unavailable even with data pins.
        raise ValueError("source-built mounted-input controller unavailable")


def fixture(parent, index, runtime, qemu, ports, children, files, multiarch="x86_64-linux-gnu", source_pinned_full=False):
    work = parent / str(index)
    work.mkdir(mode=0o700)
    realm = f"ISSUE37612{index}.INVALID"
    host = socket.gethostname()
    assert all(char.isalnum() or char in "-." for char in host)
    kdcp, vncp = port(), port()
    assert vncp >= 5900 and kdcp != vncp
    ports.extend([kdcp, vncp])
    for name, value in (("realm", realm), ("hostname", host), ("kdc-port", str(kdcp)), ("vnc-port", str(vncp))):
        (work / name).write_text(value)
    (work / "peer-provider").write_text("source-built-full-private" if source_pinned_full else ("signed-private" if qemu is None else "pinned-host"))
    password = " fixture-37612-" + secrets.token_hex(24) + " "
    (work / "password").write_text(password)
    env = {"PATH": os.environ["PATH"], "LANG": "C.UTF-8", "HOME": str(work),
           "LD_LIBRARY_PATH": f"{runtime}/usr/lib/{multiarch}:{runtime}/lib/{multiarch}",
           "KRB5_CONFIG": str(work / "krb5.conf"), "KRB5_KDC_PROFILE": str(work / "kdc.conf"),
           "KRB5_KTNAME": "FILE:" + str(work / "server.keytab"), "KRB5RCACHEDIR": str(work),
           "KRB5_CLIENT_KTNAME": "FILE:" + str(work / "absent.keytab"),
           "SASL_PATH": str(runtime / f"usr/lib/{multiarch}/sasl2"), "SASL_CONF_PATH": str(work / "sasl"),
           "QEMU_MODULE_DIR": str(runtime / f"usr/lib/{multiarch}/qemu")}
    (work / "krb5.conf").write_text(f"""[libdefaults]
 default_realm = {realm}
 dns_lookup_kdc = false
 dns_lookup_realm = false
 dns_canonicalize_hostname = false
 rdns = false
 canonicalize = false
 udp_preference_limit = 1
[realms]
 {realm} = {{
  kdc = 127.0.0.1:{kdcp}
 }}
""")
    (work / "kdc.conf").write_text(f"""[kdcdefaults]
 kdc_listen = 127.0.0.1:{kdcp}
 kdc_tcp_listen = 127.0.0.1:{kdcp}
[realms]
 {realm} = {{
  database_name = {work}/principal
  key_stash_file = {work}/stash
  acl_file = {work}/kadm.acl
  max_life = 10m
  max_renewable_life = 1h
  supported_enctypes = aes256-cts-hmac-sha1-96:normal aes128-cts-hmac-sha1-96:normal
 }}
[dbmodules]
 db_module_dir = {runtime}/usr/lib/{multiarch}/krb5/plugins/kdb
""")
    master = secrets.token_hex(32).encode()
    run([runtime / "usr/sbin/kdb5_util", "create", "-s"], env, master + b"\n" + master + b"\n")
    admin = [runtime / "usr/sbin/kadmin.local", "-r", realm]
    commands = [f"addprinc -randkey alice@{realm}", f"addprinc -randkey vnc/{host}@{realm}",
                f'addprinc -pw "{password}" passworduser@{realm}',
                f"ktadd -k {work}/alice-wrong.keytab alice@{realm}",
                f"ktadd -k {work}/alice.keytab alice@{realm}", f"ktadd -k {work}/server.keytab vnc/{host}@{realm}", "quit"]
    run(admin, env, ("\n".join(commands) + "\n").encode())
    klog = (work / "kdc.private.log").open("wb");files.append(klog)
    kdc = subprocess.Popen([str(runtime / "usr/sbin/krb5kdc"), "-n", "-r", realm], env=env,
                           stdin=subprocess.DEVNULL, stdout=klog, stderr=klog)
    children.append(kdc);wait_port(kdc, kdcp)
    run([runtime / "usr/bin/kinit.mit", "-k", "-t", work / "alice.keytab", "-c", "FILE:" + str(work / "alice.ccache"), "-l", "5m", f"alice@{realm}"], env)
    run([runtime / "usr/bin/kvno", "-c", "FILE:" + str(work / "alice.ccache"), "--out-cache", "FILE:" + str(work / "service.ccache"), f"vnc/{host}@{realm}"], env)
    listing = run([runtime / "usr/bin/klist.mit", "-c", "FILE:" + str(work / "service.ccache")], env)
    assert b"krbtgt/" not in listing
    (work / "sasl").mkdir(mode=0o700);(work / "tls").mkdir(mode=0o700);(work / "private").mkdir(mode=0o700)
    if qemu is None or source_pinned_full:
        (work / "peer-libdir").write_text(str(runtime / f"usr/lib/{multiarch}"))
    if qemu is None:
        # Explicit independent-acceptor mode, never a substituted QEMU server.
        for path in work.rglob("*"):
            if path.is_file(): path.chmod(0o600)
        inventory = subprocess.check_output(["ss", "-ltn"], text=True)
        assert f"127.0.0.1:{kdcp}" in inventory and f"0.0.0.0:{kdcp}" not in inventory and f"[::]:{kdcp}" not in inventory
        return kdc
    (work / "sasl/qemu.conf").write_text(f"mech_list: GSSAPI\nkeytab: {work}/server.keytab\n")
    run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1", "-subj", "/CN=Issue37612Fixture", "-keyout", work / "ca.key", "-out", work / "tls/ca-cert.pem"], env)
    run(["openssl", "req", "-newkey", "rsa:2048", "-noenc", "-subj", "/CN=localhost", "-keyout", work / "tls/server-key.pem", "-out", work / "server.csr"], env)
    (work / "server.ext").write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n")
    run(["openssl", "x509", "-req", "-in", work / "server.csr", "-CA", work / "tls/ca-cert.pem", "-CAkey", work / "ca.key", "-CAcreateserial", "-days", "1", "-extfile", work / "server.ext", "-out", work / "tls/server-cert.pem"], env)
    for path in work.rglob("*"):
        if path.is_file(): path.chmod(0o600)
    qlog = (work / "qemu.private.log").open("wb");files.append(qlog)
    args = [str(qemu), "-L", str(runtime / "usr/share/qemu"), "-bios", str(runtime / "usr/share/seabios/bios.bin"),
            "-machine", "pc,accel=tcg", "-m", "64", "-nodefaults", "-device", f"VGA,romfile={runtime}/usr/share/seabios/vgabios-stdvga.bin",
            "-display", "none", "-vnc", f"127.0.0.1:{vncp-5900},sasl=on,tls-creds=tls0", "-object",
            f"tls-creds-x509,id=tls0,endpoint=server,dir={work}/tls,verify-peer=off", "-S", "-monitor", "none", "-serial", "none"]
    server = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=qlog, stderr=qlog)
    children.append(server);wait_port(server, vncp)
    inventory = subprocess.check_output(["ss", "-ltn"], text=True)
    for value in (kdcp, vncp):
        assert f"127.0.0.1:{value}" in inventory and f"0.0.0.0:{value}" not in inventory and f"[::]:{value}" not in inventory
    return kdc


def own_test_descendants():
    # This disposable fixture process, not its host, adopts orphaned descendants
    # so kill(group)+wait includes tests/helpers even after Cargo exits first.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise RuntimeError("fixture cannot own orphaned test descendants")


def run_tests(argv, *, env=None, timeout):
    # Own Cargo AND its test/native descendants. One local owner/default SIGCHLD
    # must retain the leader until its last destructive process-group signal.
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise RuntimeError("independent fixture child ownership refused")
    process = subprocess.Popen(argv, env=env, cwd=REPO, start_new_session=True)

    def finish_owned_group():
        # Both executable interruption handlers raise; defer them until the
        # retained leader and its owned group have completed bounded cleanup.
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            # WNOWAIT has not released the leader PID. Even an exited Cargo
            # leader remains reserved while its same-group descendants are killed.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # No signalable group was found; still reap the retained
                # leader and check adopted children/group termination below.
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("owned test leader cleanup unconfirmed") from error
            # No further destructive signal may use the now-reaped leader ID.
            until = time.monotonic() + 5
            while True:
                try:
                    child, _ = os.waitpid(-process.pid, os.WNOHANG)
                    if child:
                        continue
                except ChildProcessError:
                    # Adopted-child absence alone does not prove group removal.
                    pass
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() >= until:
                    raise RuntimeError("owned test process-group termination unconfirmed")
                time.sleep(0.01)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)

    try:
        deadline = time.monotonic() + timeout
        while True:
            event = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if event is not None:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            time.sleep(min(0.01, remaining))
    except ChildProcessError as error:
        # Lost ownership never authorizes a signal against a numeric reused PGID.
        raise RuntimeError("independent fixture child ownership unavailable") from error
    except BaseException:
        finish_owned_group()
        raise
    else:
        # Reaping/interrupts inside cleanup cannot re-enter a signalling handler.
        finish_owned_group()
        if event.si_code != os.CLD_EXITED or event.si_status:
            raise RuntimeError("independent Rust fixture refused")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", type=pathlib.Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--qemu", type=pathlib.Path)
    mode.add_argument("--controlled-peer-only", action="store_true")
    mode.add_argument("--source-built-full-private", action="store_true")
    mode.add_argument("--inventory-only", action="store_true",
                      help="bounded public staging-tree measurement; not admission or native execution")
    parser.add_argument("--contract-root", type=pathlib.Path)
    parser.add_argument("--test-executable", type=pathlib.Path)
    parser.add_argument("--optimized-manifest", type=pathlib.Path,
                        help="original checked ci/release integration compiler manifest, never a helper override")
    args = parser.parse_args()
    if args.inventory_only:
        if any(value is not None for value in (args.contract_root, args.test_executable, args.optimized_manifest)):
            parser.error("inventory-only does not accept runtime/program overrides")
        tree = measure_immutable_tree(args.runtime_dir)
        print(json.dumps({"tree": tree, "treeSha256": immutable_tree_digest(tree),
                          "measurementOnly": True, "runtimeVerified": False, "attributionVerified": False},
                         sort_keys=True, ensure_ascii=True))
        return
    if args.optimized_manifest is not None:
        assert args.controlled_peer_only and args.test_executable is not None

    runtime = args.runtime_dir.resolve(strict=True)
    multiarch = {"x86_64": "x86_64-linux-gnu", "aarch64": "aarch64-linux-gnu"}[platform.machine()]
    # Validate the actual private inputs in BOTH modes, before compiling,
    # creating secret trees or starting any KDC/QEMU. Host dpkg metadata is not
    # evidence for the private KDC/Cyrus/GnuTLS files used by the full fixture.
    verify_runtime(runtime, multiarch, not args.controlled_peer_only, args.source_built_full_private, args.contract_root)
    qemu = None
    if args.source_built_full_private:
        # This mode only runs inside the separately selected private-root
        # harness. It never searches for host QEMU/MIT/compiler/interpreter.
        assert runtime == pathlib.Path("/") and os.geteuid() == 0
        qemu = runtime / "usr/bin/qemu-system-x86_64"
    elif not args.controlled_peer_only:
        qemu = args.qemu.resolve(strict=True)
        assert multiarch == "x86_64-linux-gnu" and hashlib.sha256(qemu.read_bytes()).hexdigest() == QEMU_SHA256
        versions = subprocess.check_output(["dpkg-query", "-W", "-f=${Package} ${Version}\\n", "libgssapi-krb5-2", "libkrb5-3", "libk5crypto3"], text=True)
        assert set(versions.splitlines()) == {name + " 1.20.1-6ubuntu2" for name in ("libgssapi-krb5-2", "libkrb5-3", "libk5crypto3")}
    work_root = REPO / "codex-work/tmp/issue-37612-native-fixture"
    if "KERBEROS_NATIVE_TEST_ROOT" in os.environ:
        assert (args.controlled_peer_only or args.source_built_full_private) and os.geteuid() == 0
        work_root = pathlib.Path(os.environ["KERBEROS_NATIVE_TEST_ROOT"])
        assert work_root == pathlib.Path("/run/kerberos-native-fixture") and work_root.is_dir() and not work_root.is_symlink()
    else:
        assert not (REPO / "codex-work").is_symlink()
        work_root.mkdir(parents=True, exist_ok=True)
        assert work_root.resolve().is_relative_to(REPO / "codex-work") and not work_root.is_symlink()
    own_test_descendants()
    cargo = ["cargo", "test", "--manifest-path", str(REPO / "crates/Cargo.toml"), "--profile", "local", "--locked", "-j", "1", "-p", "rfb-client", "--test", "qemu_gssapi"]
    separator = ["--"]
    if args.test_executable:
        assert (args.controlled_peer_only or args.source_built_full_private) and not args.test_executable.is_symlink()
        executable = args.test_executable.resolve(strict=True)
        if args.optimized_manifest is None:
            assert executable.parent == REPO / "crates/target/local/deps" and executable.name.startswith("qemu_gssapi-")
        else:
            manifest = json.loads(args.optimized_manifest.read_bytes())
            profile, target = manifest["profile"], manifest["target"]
            assert profile in ("ci", "release") and target == platform.machine() + "-unknown-linux-musl"
            assert executable.parent == REPO / "crates/target" / target / profile / "deps"
            item = manifest["executables"]["qemu_gssapi"]
            assert executable.name == item["file"] and executable.name.startswith("qemu_gssapi-")
            payload = executable.read_bytes()
            assert len(payload) == item["sizeBytes"] and hashlib.sha256(payload).hexdigest() == item["sha256"]
            # Admission only: caller already checked original compiler/native/package
            # identities; this flag never changes the sealed helper in that executable.
        cargo, separator = [str(executable)], []
    else:
        run_tests(cargo + ["--no-run"], timeout=500)
    parent = pathlib.Path(tempfile.mkdtemp(prefix="native-", dir=work_root));parent.chmod(0o700)
    children, ports, files = [], [], []
    try:
        kdcs = [fixture(parent, index, runtime, qemu, ports, children, files, multiarch, args.source_built_full_private) for index in range(2)]
        env = os.environ.copy();env["QEMU_GSSAPI_FIXTURE"] = str(parent)
        # Only public fixture paths are environment inputs to tests, never secrets.
        targets = ("pinned_native_acquisition", "pinned_native_renew", "pinned_completed_gss", "pinned_rfb_finality") if args.controlled_peer_only else ("pinned_online_password", "pinned_tls_authority", "pinned_native_acquisition", "pinned_native_renew", "pinned_completed_gss", "pinned_rfb_finality")
        for name in targets:
            run_tests(cargo + [name] + separator + ["--ignored", "--nocapture", "--test-threads=1"], env=env, timeout=90)
        for process in kdcs: stop(process)
        if not args.controlled_peer_only:
            env["QEMU_GSSAPI_KDC_STOPPED"] = "1"
            run_tests(cargo + ["pinned_offline_import"] + separator + ["--ignored", "--nocapture", "--test-threads=1"], env=env, timeout=30)
    finally:
        for process in reversed(children): stop(process)
        for stream in files: stream.close()
        for value in ports:
            with socket.socket() as stream:
                stream.settimeout(0.2)
                assert stream.connect_ex(("127.0.0.1", value)) != 0, "owned fixture listener remained"
        until = time.monotonic() + 2
        while any((work / "private").exists() and any((work / "private").iterdir()) for work in parent.iterdir()) and time.monotonic() < until:
            time.sleep(0.025)
        assert all(not (work / "private").exists() or not any((work / "private").iterdir()) for work in parent.iterdir()), "native cleanup unconfirmed; retain evidence"
        assert parent.parent == work_root and parent.name.startswith("native-") and not parent.is_symlink()
        shutil.rmtree(parent);assert not parent.exists()
        print("cleanup verified: exact local KDC/QEMU processes waited, listeners closed, private fixture/native material removed", flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(TimeoutError("bounded independent fixture interrupted")))
    main()
