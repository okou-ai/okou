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


def verify_runtime(runtime, multiarch, full_qemu, source_pinned_full=False):
    # The producer must obtain these records from verified signed archives, not
    # hash an arbitrary installed tree. Rechecking bytes does not attest loader
    # resolution, transitive closure, host MIT or a historical runtime result.
    manifest = runtime / "provider.json"
    if not manifest.is_file() or manifest.is_symlink():
        raise ValueError("independent fixture provider manifest required")
    baseline = json.loads(manifest.read_text())
    architecture = {"x86_64-linux-gnu": "amd64", "aarch64-linux-gnu": "arm64"}[multiarch]
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
        if not full_qemu or baseline.get("fullQemuProvider") != "source-pinned-private-noble-v1":
            raise ValueError("explicit full-private source provider required")
        pins = json.loads((REPO / "crates/rfb-client/tests/fixtures/qemu_gssapi_full_pins.json").read_text())
        native = {"amd64": "x86_64", "arm64": "aarch64"}[architecture]
        expected = pins["architectures"].get(native)
        # Only independently reviewed actual compiler outputs can fill these
        # pins. A freshly rehashed arbitrary runtime cannot approve itself.
        if expected is None:
            raise ValueError("source-built QEMU lacks reviewed native producer pins")
        build = baseline["qemuBuild"]
        binary = runtime / "usr/bin/qemu-system-x86_64"
        recipe = REPO / ".github/scripts/prepare-qemu-gssapi-fixture.py"
        package_lock = hashlib.sha256(json.dumps(baseline["packages"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if (build["version"] != "9.2.0" or build["target"] != "x86_64-softmmu" or build["nativeArchitecture"] != native
            or build["sourceArchiveSha256"] != "f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894"
            or build["vncSourceSha256"] != "3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d"
            or baseline["snapshot"] != "20260521T000000Z" or package_lock != expected["packageLockSha256"]
            or package_lock != baseline["packageLockSha256"] or build["recipeSha256"] != expected["recipeSha256"]
            or hashlib.sha256(recipe.read_bytes()).hexdigest() != expected["recipeSha256"]
            or build["binarySha256"] != expected["binarySha256"] or build["secondBuildSha256"] != expected["binarySha256"]
            or hashlib.sha256(binary.read_bytes()).hexdigest() != expected["binarySha256"]):
            raise ValueError("source-built QEMU producer identity refused")
        for name, target in baseline["aliases"].items():
            relative = pathlib.PurePosixPath(name)
            alias = runtime / relative
            if relative.is_absolute() or ".." in relative.parts or not alias.is_symlink() or os.readlink(alias) != target or not alias.resolve(strict=not name.startswith(("usr/share/doc/", "usr/share/man/", "usr/share/locale/"))).is_relative_to(runtime):
                raise ValueError("full-private input alias refused")


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
    # Own Cargo AND its test/native descendants. Cancelling only subprocess.run's
    # Cargo child is not proof the test executable stopped or released resources.
    process = subprocess.Popen(argv, env=env, cwd=REPO, start_new_session=True)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise RuntimeError("independent Rust fixture refused")
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            # ESRCH means the owned group already exited; wait/reap and the
            # explicit group-disappearance check below still must complete.
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        # A reaped Cargo process may leave its separately running test descendant.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            # The preceding TERM may already have removed this group. This
            # expected race does not bypass adopted-child/group verification.
            pass
        until = time.monotonic() + 5
        while True:
            try:
                child, _ = os.waitpid(-process.pid, os.WNOHANG)
                if child:
                    continue
            except ChildProcessError:
                # No waitable adopted group child remains right now; that alone
                # does not prove termination, so killpg(0) below still gates exit.
                pass
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            if time.monotonic() >= until:
                raise RuntimeError("owned test process-group termination unconfirmed")
            time.sleep(0.01)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", type=pathlib.Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--qemu", type=pathlib.Path)
    mode.add_argument("--controlled-peer-only", action="store_true")
    mode.add_argument("--source-built-full-private", action="store_true")
    parser.add_argument("--test-executable", type=pathlib.Path)
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve(strict=True)
    multiarch = {"x86_64": "x86_64-linux-gnu", "aarch64": "aarch64-linux-gnu"}[platform.machine()]
    # Validate the actual private inputs in BOTH modes, before compiling,
    # creating secret trees or starting any KDC/QEMU. Host dpkg metadata is not
    # evidence for the private KDC/Cyrus/GnuTLS files used by the full fixture.
    verify_runtime(runtime, multiarch, not args.controlled_peer_only, args.source_built_full_private)
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
        assert executable.parent == REPO / "crates/target/local/deps" and executable.name.startswith("qemu_gssapi-")
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
