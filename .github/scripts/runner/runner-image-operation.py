#!/usr/bin/env python3
"""Own one image warm/build across SSH response loss; see README.md for the protocol."""

import contextlib
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

WORK_SECONDS = 570  # Reserve reconciliation/termination inside the existing 600s call.
# Cover the deployment holder's default 150s lease, with 30s for admission
# and its reply inside the existing image job budget.
PR_CLAIM_SECONDS = 180
CLAIM_WORK_SECONDS = 25
LOG_BYTES = 1024 * 1024
R2_NAMES = (
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_USER_STORAGES_BUCKET_NAME",
)
BOOTSTRAP = (
    "import json,sys; r=json.load(sys.stdin); n={'__name__':'remote'}; "
    "exec(compile(r['source'],'<runner-image-operation>','exec'),n); n['remote'](r)"
)
LOCK_BOOTSTRAP = (
    "import os,stat,sys\np=sys.argv[2]\n"
    "fd=os.open(p,os.O_CREAT|os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,0o644)\n"
    "s=os.fstat(fd)\n"
    "if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1:\n"
    " raise RuntimeError('invalid lifecycle lock')\n"
    "os.fchmod(fd,0o644)\nprint(os.path.realpath(p))\n"
)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, separators=(",", ":"))
    temporary.replace(path)


def private_dir(path, create=True):
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("image operation directory is not private and owned")


@contextlib.contextmanager
def gate(namespace, while_waiting=None, observe_intent=None):
    fd = os.open(namespace / "gate", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if observe_intent is not None and observe_intent.exists():
                    # Reattachment is read-only once the original launch
                    # publishes intent; it must not wait behind its worker.
                    yield False
                    return
                if time.monotonic() >= deadline:
                    raise RuntimeError("image ownership gate deadline exceeded") from None
                if while_waiting:
                    while_waiting()
                time.sleep(0.1)
        yield True
    finally:
        os.close(fd)


def system(*arguments, deadline=None):
    timeout = 15
    if deadline is not None:
        timeout = min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            raise TimeoutError("image claim work deadline exceeded")
    result = subprocess.run(
        ["sudo", *arguments], capture_output=True, text=True, timeout=timeout, check=False
    )
    if result.returncode:
        raise RuntimeError("image service command failed: " + arguments[0])
    return result.stdout


@contextlib.contextmanager
def lifecycle(path, deadline, *, wait=True):
    # Linux flock permits LOCK_EX on a read-only FD. The existing root-owned
    # lock stays on the same inode; workers do not need to run Python as root.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        while True:
            if time.monotonic() >= deadline:
                raise RuntimeError("image lifecycle lock deadline exceeded")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not wait:
                    yield None
                    return
                time.sleep(0.1)
        yield fd
    finally:
        os.close(fd)


def marker_for(owner):
    return Path(owner["resourceRoot"]) / (".image-owner-" + owner["identity"])


def require_resource(owner):
    marker = marker_for(owner)
    if marker.is_symlink() or not marker.is_file():
        raise RuntimeError("image namespace retired; a new workflow attempt is required")


def check_closure(namespace, lock_fd, run_created_at):
    if namespace.name.startswith("pr-"):
        created = datetime.strptime(run_created_at, "%Y-%m-%dT%H:%M:%SZ")
        cutoff = os.read(lock_fd, 22)
        if cutoff and created <= datetime.strptime(cutoff.decode("ascii"), "%Y-%m-%dT%H:%M:%SZ\n"):
            raise RuntimeError("image workflow predates PR closure; a fresh run is required")


def claim_resource(namespace, owner, deadline):
    directory = "/var/lib/vm0-runner/bin/" + namespace.name
    if namespace.name.startswith("pr-"):
        directory += f"-image-{owner['generation'][0]}"
    system("install", "-d", "-m", "755", directory, deadline=deadline)
    owner["resourceRoot"] = system("realpath", "-e", directory, deadline=deadline).strip()
    system("install", "-m", "600", "/dev/null", str(marker_for(owner)), deadline=deadline)
    require_resource(owner)
    owner["state"] = "ready"
    atomic_json(namespace / "owner.json", owner)


def unit_state(unit):
    result = subprocess.run(
        [
            "sudo",
            "systemctl",
            "show",
            unit,
            "--property=LoadState,ActiveState,MainPID,ControlGroup,Job",
        ],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if values.get("LoadState") == "not-found":
        return values
    if (
        result.returncode
        or values.get("LoadState") != "loaded"
        or not {"ActiveState", "MainPID", "ControlGroup", "Job"}.issubset(values)
    ):
        raise RuntimeError("image unit state unavailable")
    return values


def stopped(values):
    if values.get("LoadState") == "not-found":
        return True
    if (
        values.get("ActiveState") not in ("inactive", "failed")
        or values.get("MainPID") != "0"
        or values.get("Job") not in ("", "0")
    ):
        return False
    cgroup = values.get("ControlGroup")
    if cgroup:
        directory = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
        events = directory / "cgroup.events"
        try:
            if "populated 0" not in events.read_text().splitlines():
                return False
        except FileNotFoundError:
            if directory.exists():
                raise RuntimeError("image cgroup population unavailable") from None
            # A collected cgroup has no processes.
    return True


def unit_for(operation):
    return f"vm0-ci-image-{operation.parent.name}-{operation.name}.service"


def operation_paths(namespace):
    for operation in namespace.iterdir():
        if re.fullmatch(r"[a-f0-9]{64}", operation.name):
            try:
                private_dir(operation, create=False)
            except FileNotFoundError:
                continue
            yield operation


def operations(namespace):
    for operation in operation_paths(namespace):
        try:
            intent = json.loads((operation / "intent.json").read_text())
        except FileNotFoundError:
            continue  # Missing intent cannot prove ownership for pre-retirement.
        yield operation, intent


def operation_identity(request):
    value = {"inputs": request["inputs"], "phase": request["phase"]}
    if request["phase"] == "guard":
        if not re.fullmatch(r"[a-f0-9]{32}", request["nonce"]):
            raise ValueError("invalid image preparation identity")
        value.update(
            nonce=request["nonce"],
            commandDigest=digest({"command": request["command"], "stdin": request["stdin"]}),
        )
    return digest(value)


def owner_for(inputs):
    return {"identity": digest(inputs), "generation": [inputs["runId"], inputs["runAttempt"]]}


def owner_matches(actual, expected):
    return actual is not None and all(
        actual.get(key) == expected[key] for key in ("identity", "generation")
    )


def owner_admitted(actual, expected):
    return owner_matches(actual, expected) and actual["state"] == "ready"


def admission_floor(owner):
    return max(owner["generation"], owner.get("cancelledThrough", owner["generation"]))


def require_observation_owner(namespace, expected):
    owner = json.loads((namespace / "owner.json").read_text())
    if not owner_admitted(owner, expected):
        raise RuntimeError("image owner superseded or cancelled")
    require_resource(owner)


def retire(operation):
    # Earlier PR revisions used these two exact names. Check both even if
    # intent is missing so a successor cannot reuse paths before retirement.
    units = (
        unit_for(operation),
        f"vm0-runner-{operation.parent.name}-image-{operation.name}.service",
        f"vm0-ci-image-{operation.name}.service",
    )
    for unit in units:
        if not stopped(unit_state(unit)):
            system("systemctl", "stop", "--no-block", unit)
    deadline = time.monotonic() + 15
    while any(not stopped(unit_state(unit)) for unit in units):
        if time.monotonic() >= deadline:
            raise RuntimeError("image worker retirement unconfirmed; retaining files")
        time.sleep(0.1)
    (operation / "credentials.json").unlink(missing_ok=True)


def expire(operation):
    operation = Path(operation)
    if not re.fullmatch(r"[a-f0-9]{64}", operation.name):
        raise ValueError("invalid image expiration identity")
    if not operation.exists():
        return
    retire(operation)
    with gate(operation.parent):
        if operation.exists():
            retire(operation)
            shutil.rmtree(operation)


def stopped_without_result(operation, owner):
    # An intent is visible before systemd accepts the launch. A missing unit
    # is not terminal while that submission (or its worker) still owns the gate.
    # A successor may own the same gate, but must not delay the old observer.
    require_observation_owner(operation.parent, owner)
    fd = os.open(operation.parent / "gate", os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return not (operation / "result.json").exists() and stopped(unit_state(unit_for(operation)))
    finally:
        os.close(fd)


def validate_inputs(inputs):
    if not re.fullmatch(r"(?:pr-[1-9][0-9]*|staging-[a-f0-9]{12})", inputs["jobRef"]):
        raise ValueError("invalid image job reference")
    for name in ("headSha", "runnerSha256", "binaryInputDigest", "workerSha256"):
        size = 40 if name == "headSha" else 64
        if not re.fullmatch(r"[a-f0-9]{" + str(size) + "}", inputs[name]):
            raise ValueError("invalid image input digest: " + name)
    if inputs["target"] not in ("aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"):
        raise ValueError("invalid image target")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9/_.-]*", inputs["profile"]):
        raise ValueError("invalid image profile")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?", inputs["host"]):
        raise ValueError("invalid image host")
    if any(type(inputs[n]) is not int or inputs[n] < 1 for n in ("runId", "runAttempt")):
        raise ValueError("invalid image workflow identity")


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def claim(request, namespace, owner, retire_matching, deadline):
    owner_path = namespace / "owner.json"
    lock = "/var/lock/vm0-runner-lifecycle-" + namespace.name + ".lock"
    lock_path = system(
        "python3", "-c", LOCK_BOOTSTRAP, "image-lifecycle-lock", lock, deadline=deadline
    ).strip()
    while True:
        with gate(namespace, while_waiting=retire_matching):
            previous = json.loads(owner_path.read_text()) if owner_path.exists() else None
            existing = owner_matches(previous, owner)
            if existing:
                if not owner_admitted(previous, owner):
                    raise RuntimeError(
                        "image workflow claim incomplete or cancelled; a new attempt is required"
                    )
            elif previous and admission_floor(previous) >= owner["generation"]:
                raise RuntimeError("image owner superseded, cancelled or input identity conflicts")

            retired = [] if existing else list(operation_paths(namespace))
            for operation in retired:
                retire(operation)
            with lifecycle(lock_path, deadline, wait=False) as lock_fd:
                if lock_fd is not None:
                    if existing:
                        require_resource(previous)
                    else:
                        check_closure(namespace, lock_fd, request.get("runCreatedAt"))
                        for operation in retired:
                            shutil.rmtree(operation)
                        claimed = dict(
                            owner, operations=[], state="claiming", lifecycleLock=lock_path
                        )
                        atomic_json(owner_path, claimed)
                        work_deadline = min(deadline, time.monotonic() + CLAIM_WORK_SECONDS)
                        claim_resource(namespace, claimed, work_deadline)
                    emit({"claimed": owner["identity"]})
                    return
        # This acquisition only observes availability. Release it before
        # entering the private gate and recheck the owner on the next pass.
        with lifecycle(lock_path, deadline):
            pass


def remote(request):
    if request["action"] == "claim":
        budget = request["claimBudget"]
        if type(budget) is not int or not 5 < budget <= PR_CLAIM_SECONDS:
            raise ValueError("invalid remaining image claim budget")
        claim_deadline = time.monotonic() + budget - 5
    os.umask(0o077)
    inputs = request["inputs"]
    validate_inputs(inputs)
    if hashlib.sha256(request["source"].encode()).hexdigest() != inputs["workerSha256"]:
        raise ValueError("image worker source mismatch")
    # The caller explicitly selects remote tmpfs. tempfile.gettempdir() would
    # silently use disk if that mount is absent or unavailable.
    state_root = Path(os.environ["TMPDIR"])
    if not state_root.is_absolute():
        raise ValueError("image state root must be absolute")
    root = state_root / ("vm0-runner-image-" + str(os.getuid()))
    private_dir(root)
    namespace = root / inputs["jobRef"]
    private_dir(namespace)
    owner = owner_for(inputs)
    owner_path = namespace / "owner.json"
    entry_owner = json.loads(owner_path.read_text()) if owner_path.exists() else None
    if request["action"] == "claim":
        if owner_matches(entry_owner, owner) and entry_owner["state"] == "cancelled":
            raise RuntimeError("image workflow owner cancelled; a new attempt is required")
        if (
            entry_owner
            and not owner_matches(entry_owner, owner)
            and admission_floor(entry_owner) >= owner["generation"]
        ):
            raise RuntimeError("image owner superseded, cancelled or input identity conflicts")
    elif request["action"] in ("run", "guard") and not owner_admitted(entry_owner, owner):
        raise RuntimeError("image owner superseded, cancelled or not claimed")
    if request["action"] in ("run", "guard"):
        if request["phase"] not in ("warm", "build", "guard"):
            raise ValueError("invalid image phase")
        identity = operation_identity(request)
        operation = namespace / identity
        # Reattachment is read-only and must not wait on the worker's mutation
        # gate. In particular, stream loss cannot block observation for 570s.
        if (operation / "intent.json").exists():
            observe(request, operation)
            return

    # A preparation worker owns this gate while mutating. Retire only proven
    # older/exact-owner cgroups first, then take the gate and recheck below.
    # The operation identities cannot name a successor's service.
    def retire_matching():
        for operation, intent in operations(namespace):
            generation = [intent["inputs"]["runId"], intent["inputs"]["runAttempt"]]
            if (request["action"] == "claim" and generation < owner["generation"]) or (
                request["action"] == "cancel" and intent["inputs"] == inputs
            ):
                retire(operation)

    retiring = request["action"] in ("claim", "cancel")
    if retiring:
        retire_matching()
    if request["action"] == "claim":
        claim(request, namespace, owner, retire_matching, claim_deadline)
        return
    if (
        request["action"] == "cancel"
        and entry_owner
        and not owner_matches(entry_owner, owner)
        and admission_floor(entry_owner) >= owner["generation"]
    ):
        emit({"cancelled": "not-current-owner"})
        return
    with gate(
        namespace,
        while_waiting=retire_matching if retiring else None,
        observe_intent=operation / "intent.json" if request["action"] in ("run", "guard") else None,
    ) as acquired:
        if not acquired:
            observe(request, operation)
            return
        previous = json.loads(owner_path.read_text()) if owner_path.exists() else None
        if not owner_matches(previous, owner):
            if request["action"] == "cancel":
                # A cancellation may reach the host before its first claim.
                # Record it without retiring an older, still-admitted owner.
                if previous is None:
                    previous = dict(owner, operations=[], state="cancelled")
                elif admission_floor(previous) < owner["generation"]:
                    previous["cancelledThrough"] = owner["generation"]
                else:
                    emit({"cancelled": "not-current-owner"})
                    return
                atomic_json(owner_path, previous)
                emit({"cancelled": owner["identity"]})
                return
            raise RuntimeError("image owner superseded or not claimed")
        if request["action"] == "cancel":
            # Fence admission even if a previously submitted systemd request
            # becomes visible only after our final stopped-state observation.
            previous["state"] = "cancelled"
            atomic_json(owner_path, previous)
            for operation in operation_paths(namespace):
                retire(operation)
            emit({"cancelled": owner["identity"]})
            return
        if not owner_admitted(previous, owner):
            raise RuntimeError("image workflow owner cancelled")
        phase = request["phase"]
        intent = operation / "intent.json"
        if not intent.exists():
            if identity in previous["operations"]:
                raise RuntimeError(
                    "image result expired or launch intent unavailable; execution is not replayed"
                )
            if len(previous["operations"]) >= 32:
                raise RuntimeError("image workflow operation limit exceeded")
            # Retain a bounded tombstone after result expiration, too. A lost
            # intent or expired directory must never permit a second execution.
            previous["operations"].append(identity)
            atomic_json(owner_path, previous)
            private_dir(operation)
            # Commit the launch decision before submission. If submission becomes
            # ambiguous, absence of a result/unit is unknown, never permission to replay.
            intent_value = {
                "identity": identity,
                "inputs": inputs,
                "phase": phase,
                "deadline": time.monotonic() + WORK_SECONDS + 15,
            }
            if phase == "guard":
                intent_value.update(
                    nonce=request["nonce"], command=request["command"], stdin=request["stdin"]
                )
            atomic_json(intent, intent_value)
            (operation / "worker.py").write_text(request["source"])
            unit = unit_for(operation)
            service_owner = (f"--uid={os.getuid()}", f"--gid={os.getgid()}")
            # Establish expiration before materializing credentials or starting work.
            system(
                "systemd-run",
                "--quiet",
                "--collect",
                "--unit=vm0-ci-image-" + identity + "-expire",
                *service_owner,
                "--on-active=1h",
                "--timer-property=AccuracySec=1s",
                "--property=RuntimeMaxSec=60",
                "--property=TimeoutStopSec=10",
                "/bin/sh",
                "-c",
                'if [ -f "$1/worker.py" ]; then exec /usr/bin/python3 "$1/worker.py" expire "$1"; fi',
                "image-result-expiration",
                str(operation),
            )
            if phase != "guard":
                atomic_json(operation / "credentials.json", request["credentials"])
            system(
                "systemd-run",
                "--quiet",
                "--collect",
                "--service-type=exec",
                "--unit=" + unit,
                "--description=Runner image " + inputs["jobRef"] + " " + identity,
                *service_owner,
                "--property=RuntimeMaxSec=" + str(WORK_SECONDS),
                "--property=TimeoutStopSec=10",
                "--property=KillMode=control-group",
                "--property=SendSIGKILL=yes",
                "/usr/bin/python3",
                str(operation / "worker.py"),
                "worker",
                str(operation),
            )
    observe(request, operation)


def observe(request, operation):
    intent = json.loads((operation / "intent.json").read_text())
    if (
        intent["identity"] != operation_identity(request)
        or operation_identity(intent) != intent["identity"]
    ):
        raise RuntimeError("image launch identity mismatch")
    owner = owner_for(intent["inputs"])
    require_observation_owner(operation.parent, owner)
    result_path = operation / "result.json"
    offset = request.get("offset", 0)
    deadline = intent["deadline"]
    while time.monotonic() < deadline or result_path.exists():
        log = operation / "output.log"
        if log.exists():
            with log.open("rb") as stream:
                stream.seek(offset)
                chunk = stream.read(16384)
            if chunk:
                offset += len(chunk)
                emit({"log": chunk.decode("utf-8", errors="replace"), "offset": offset})
                continue
        if result_path.exists():
            result = json.loads(result_path.read_text())
            # Cancellation or cleanup can revoke admission while we stream.
            require_observation_owner(operation.parent, owner)
            emit({"result": result})
            return
        if stopped(unit_state(unit_for(operation))) and stopped_without_result(operation, owner):
            raise RuntimeError("image unit stopped without a result; execution outcome unknown")
        time.sleep(0.5)
    raise RuntimeError("image result deadline exceeded")


def worker(operation):
    os.umask(0o077)
    operation = Path(operation)
    intent = json.loads((operation / "intent.json").read_text())
    inputs = intent["inputs"]
    if operation_identity(intent) != intent["identity"]:
        raise RuntimeError("invalid image execution identity")
    with gate(operation.parent):
        owner = json.loads((operation.parent / "owner.json").read_text())
        if not owner_admitted(owner, owner_for(inputs)):
            raise RuntimeError("image operation owner superseded or cancelled")
        with lifecycle(owner["lifecycleLock"], intent["deadline"]):
            # Cleanup may have run while this service was queued. Admission
            # belongs to the managed namespace, not merely to a live unit.
            require_resource(owner)
            if intent["phase"] == "guard":
                execute(operation, intent, intent["command"], intent["stdin"].encode(), {})
                return
            credentials_path = operation / "credentials.json"
            credentials = json.loads(credentials_path.read_text())
            credentials_path.unlink()
            runner = str(Path(owner["resourceRoot"]) / "runner")
            checked = system("sha256sum", runner).split()[0]
            if checked != inputs["runnerSha256"]:
                raise RuntimeError("runner bytes changed before image execution")
            command = [
                "sudo",
                "--preserve-env=" + ",".join(R2_NAMES),
                runner,
                "build",
                "--profile",
                inputs["profile"],
            ]
            if intent["phase"] == "warm":
                command.append("--warm-rootfs-cache")
            execute(operation, intent, command, None, credentials)


def execute(operation, intent, command, stdin, credentials):
    environment = dict(os.environ)
    environment.update({key: credentials.get(key, "") for key in R2_NAMES})
    environment["RUNNER_IMAGE_OWNER_MARKER"] = ".image-owner-" + digest(intent["inputs"])
    hashes = {}
    retained = 0
    truncated = False
    pending = b""
    overlap = max((len(v.encode()) for v in credentials.values()), default=1)
    with (operation / "output.log").open("wb", buffering=0) as log:

        def retain(chunk):
            nonlocal retained, truncated
            truncated |= retained + len(chunk) > LOG_BYTES
            chunk = chunk[: max(0, LOG_BYTES - retained)]
            log.write(chunk)
            retained += len(chunk)

        with subprocess.Popen(
            command,
            env=environment,
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ) as process:
            if stdin is not None:
                with contextlib.suppress(BrokenPipeError):
                    process.stdin.write(stdin)
                    process.stdin.close()
            while line := process.stdout.readline(65536):
                match = re.fullmatch(rb"(rootfs|snapshot)_hash=([a-f0-9]{64})\r?\n?", line)
                if match:
                    hashes[match[1].decode() + "Hash"] = match[2].decode()
                pending += line
                for value in sorted(credentials.values(), key=len, reverse=True):
                    if value:
                        pending = pending.replace(value.encode(), b"[REDACTED]")
                if line.endswith(b"\n"):
                    retain(pending)
                    pending = b""
                elif len(pending) > overlap:
                    retain(pending[:-overlap])
                    pending = pending[-overlap:]
            retain(pending)
            status = process.wait()
    status = status if status >= 0 else 128 - status
    atomic_json(
        operation / "result.json",
        {
            "schemaVersion": 1,
            "identity": intent["identity"],
            "status": status,
            "logTruncated": truncated,
            **hashes,
        },
    )


def validate_result(result, identity, phase):
    if (
        result.get("schemaVersion") != 1
        or result.get("identity") != identity
        or type(result.get("status")) is not int
        or not 0 <= result["status"] <= 255
        or type(result.get("logTruncated")) is not bool
    ):
        raise RuntimeError("invalid or mismatched image result")
    if result["status"] == 0 and phase == "build":
        for name in ("rootfsHash", "snapshotHash"):
            if not re.fullmatch(r"[a-f0-9]{64}", result.get(name, "")):
                raise RuntimeError("invalid image result hash")


def exchange(request, remote_host, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("image operation deadline exceeded")
    if request["action"] == "claim":
        request = dict(request, claimBudget=int(remaining))
    environment = dict(
        os.environ, OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=str(max(1, int(remaining)))
    )
    # tmpfs also removes retained state after a host reboot, when transient
    # expiration timers no longer exist. Scripts are read by Python, not exec'd.
    process = subprocess.Popen(
        ["ssh", remote_host, "env", "TMPDIR=/dev/shm", "python3", "-c", shlex.quote(BOOTSTRAP)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=environment,
        start_new_session=True,
    )
    expired = threading.Event()

    def terminate():
        expired.set()
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)

    timer = threading.Timer(remaining, terminate)
    timer.daemon = True
    timer.start()
    reply = None
    partial_frame = False
    try:
        with contextlib.suppress(BrokenPipeError):
            process.stdin.write(json.dumps(request).encode())
            process.stdin.close()
        while line := process.stdout.readline(131072):
            if len(line) == 131072:
                raise RuntimeError("invalid image response frame")
            if not line.endswith(b"\n"):
                partial_frame = True
                break
            frame = json.loads(line)
            if "log" in frame:
                for entry in frame["log"].splitlines(keepends=True):
                    prefix = (
                        ""
                        if request["action"] == "guard"
                        else "[" + request["inputs"]["host"] + "] "
                    )
                    print(prefix + entry, end="", flush=True)
                request["offset"] = frame["offset"]
            else:
                reply = frame
        status = process.wait()
        if expired.is_set():
            status = 124
        if status == 0 and partial_frame:
            raise RuntimeError("incomplete image response frame")
        return status, reply
    finally:
        timer.cancel()
        if process.poll() is None:
            terminate()
        process.wait()
        process.stdout.close()
        with contextlib.suppress(BrokenPipeError):
            process.stdin.close()


def reconnect(request, remote_host, seconds):
    deadline = time.monotonic() + seconds
    for attempt in range(1, 4):
        status, reply = exchange(request, remote_host, deadline)
        if status == 0:
            if reply is None:
                raise RuntimeError("missing image response")
            return reply
        if status not in (124, 141, 255) or attempt == 3:
            raise RuntimeError("image SSH response unavailable: status=" + str(status))
        print(f"Image response lost; reconciling same operation ({attempt}/3)", file=sys.stderr)
        if time.monotonic() + attempt >= deadline:
            raise TimeoutError("image reconciliation deadline exceeded")
        time.sleep(attempt)
    raise AssertionError("unreachable")


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("validate", "claim", "run", "cancel", "guard"):
        raise ValueError(
            "usage: runner-image-operation.py validate|claim|cancel HOST | run HOST warm|build RESULT_PATH | guard HOST COMMAND ..."
        )
    action, host = sys.argv[1:3]
    source = Path(__file__).read_text()
    inputs = {
        "jobRef": os.environ["JOB_REF"],
        "headSha": os.environ["HEAD_SHA"],
        "target": os.environ["TARGET_TRIPLE"],
        "profile": os.environ["PROFILE"],
        "runnerSha256": os.environ["RUNNER_IMAGE_RUNNER_SHA256"],
        "binaryInputDigest": os.environ["EXPECTED_BINARY_INPUT_DIGEST"],
        "host": host,
        "runId": int(os.environ["GITHUB_RUN_ID"]),
        "runAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "workerSha256": hashlib.sha256(source.encode()).hexdigest(),
    }
    validate_inputs(inputs)
    user = os.environ["METAL_USER"]
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        raise ValueError("invalid image SSH user")
    if action == "validate":
        return 0
    request = {"action": action, "inputs": inputs, "source": source}
    if action == "claim" and inputs["jobRef"].startswith("pr-"):
        request["runCreatedAt"] = os.environ["RUNNER_IMAGE_RUN_CREATED_AT"]
    remote_host = user + "@" + host
    if action not in ("run", "guard"):
        budget = (
            PR_CLAIM_SECONDS if action == "claim" and inputs["jobRef"].startswith("pr-") else 30
        )
        reconnect(request, remote_host, budget)
        return 0
    if action == "guard":
        if len(sys.argv) < 4:
            raise ValueError("missing image preparation command")
        phase = "guard"
        request.update(
            phase=phase, command=sys.argv[3:], stdin=sys.stdin.read(), nonce=os.urandom(16).hex()
        )
    else:
        if len(sys.argv) != 5 or sys.argv[3] not in ("warm", "build"):
            raise ValueError("missing image phase/result path")
        phase = sys.argv[3]
        credentials = {key: os.environ.get(key, "") for key in R2_NAMES}
        if any(
            "\n" in value or "\r" in value or len(value) > 4096 for value in credentials.values()
        ):
            raise ValueError("invalid image credential format")
        request.update(phase=phase, credentials=credentials)
    identity = operation_identity(request)
    done = False
    try:
        result = reconnect(request, remote_host, 600)["result"]
        validate_result(result, identity, phase)
        if action == "run":
            atomic_json(Path(sys.argv[4]), result)
        done = True
        if result["logTruncated"]:
            print("Image log truncated at 1 MiB", file=sys.stderr)
        return result["status"]
    finally:
        if not done:
            request.pop("credentials", None)
            request["action"] = "cancel"
            try:
                reconnect(request, remote_host, 30)
            except Exception as error:
                print(
                    "Image retirement unconfirmed; service deadline remains active: " + str(error),
                    file=sys.stderr,
                )


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] in ("worker", "expire"):
            if sys.argv[1] == "worker":
                worker(sys.argv[2])
            else:
                expire(sys.argv[2])
        else:

            def interrupted(signum, _frame):
                raise KeyboardInterrupt("image operation signal " + str(signum))

            for handled in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(handled, interrupted)
            sys.exit(main())
    except (Exception, KeyboardInterrupt) as failure:
        print("runner image operation failed: " + str(failure), file=sys.stderr)
        sys.exit(1)
