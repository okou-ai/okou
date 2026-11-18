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
import tempfile
import threading
import time
from pathlib import Path

WORK_SECONDS = 570  # Reserve reconciliation/termination inside the existing 600s call.
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
def gate(namespace, while_waiting=None):
    fd = os.open(namespace / "gate", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("image ownership gate deadline exceeded") from None
                if while_waiting:
                    while_waiting()
                time.sleep(0.1)
        yield fd
    finally:
        os.close(fd)


def system(*arguments):
    result = subprocess.run(
        ["sudo", *arguments], capture_output=True, text=True, timeout=15, check=False
    )
    if result.returncode:
        raise RuntimeError("image service command failed: " + arguments[0])
    return result.stdout


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
    return "vm0-ci-image-" + operation.name + ".service"


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


def owner_matches(actual, expected):
    return actual is not None and all(
        actual.get(key) == expected[key] for key in ("identity", "generation")
    )


def retire(operation):
    unit = unit_for(operation)
    if not stopped(unit_state(unit)):
        system("systemctl", "stop", "--no-block", unit)
    deadline = time.monotonic() + 15
    while not stopped(unit_state(unit)):
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


def remote(request):
    os.umask(0o077)
    inputs = request["inputs"]
    validate_inputs(inputs)
    if hashlib.sha256(request["source"].encode()).hexdigest() != inputs["workerSha256"]:
        raise ValueError("image worker source mismatch")
    root = Path(tempfile.gettempdir()) / ("vm0-runner-image-" + str(os.getuid()))
    private_dir(root)
    namespace = root / inputs["jobRef"]
    private_dir(namespace)
    owner = {"identity": digest(inputs), "generation": [inputs["runId"], inputs["runAttempt"]]}
    owner_path = namespace / "owner.json"
    entry_owner = json.loads(owner_path.read_text()) if owner_path.exists() else None
    if request["action"] == "claim":
        if (
            entry_owner
            and not owner_matches(entry_owner, owner)
            and entry_owner["generation"] >= owner["generation"]
        ):
            raise RuntimeError("image owner superseded or input identity conflicts")
    elif request["action"] in ("run", "guard") and not owner_matches(entry_owner, owner):
        raise RuntimeError("image owner superseded or not claimed")
    if request["action"] in ("run", "guard"):
        if request["phase"] not in ("warm", "build", "guard"):
            raise ValueError("invalid image phase")
        identity = operation_identity(request)
        operation = namespace / identity
        # Reattachment is read-only and must not wait on the worker's mutation
        # gate. In particular, stream loss cannot block observation for 570s.
        if (operation / "intent.json").exists():
            if not owner_matches(json.loads(owner_path.read_text()), owner):
                raise RuntimeError("image owner superseded")
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
    if request["action"] == "cancel" and not owner_matches(entry_owner, owner):
        emit({"cancelled": "not-current-owner"})
        return
    with gate(namespace, retire_matching if retiring else None):
        previous = json.loads(owner_path.read_text()) if owner_path.exists() else None
        if request["action"] == "claim":
            if not owner_matches(previous, owner):
                if previous and previous["generation"] >= owner["generation"]:
                    raise RuntimeError("image owner superseded or input identity conflicts")
                for operation in operation_paths(namespace):
                    retire(operation)
                    shutil.rmtree(operation)
                atomic_json(owner_path, dict(owner, operations=[]))
            emit({"claimed": owner["identity"]})
            return
        if not owner_matches(previous, owner):
            if request["action"] == "cancel":
                emit({"cancelled": "not-current-owner"})
                return
            raise RuntimeError("image owner superseded or not claimed")
        if request["action"] == "cancel":
            for operation in operation_paths(namespace):
                retire(operation)
            emit({"cancelled": owner["identity"]})
            return
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
            # Establish expiration before materializing credentials or starting work.
            system(
                "systemd-run",
                "--quiet",
                "--collect",
                "--unit=" + unit.removesuffix(".service") + "-expire",
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
                "--uid=" + str(os.getuid()),
                "--gid=" + str(os.getgid()),
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
    result_path = operation / "result.json"
    offset = request.get("offset", 0)
    deadline = intent["deadline"]
    while time.monotonic() < deadline:
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
            emit({"result": json.loads(result_path.read_text())})
            return
        if stopped(unit_state(unit_for(operation))):
            # Publication can race the first read while systemd is collecting.
            if result_path.exists():
                continue
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
        if owner["identity"] != digest(inputs):
            raise RuntimeError("image operation owner superseded")
        if intent["phase"] == "guard":
            execute(operation, intent, intent["command"], intent["stdin"].encode(), {})
            return
        credentials_path = operation / "credentials.json"
        credentials = json.loads(credentials_path.read_text())
        credentials_path.unlink()
        runner = "/var/lib/vm0-runner/bin/" + inputs["jobRef"] + "/runner"
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
    remote_host = user + "@" + host
    if action not in ("run", "guard"):
        reconnect(request, remote_host, 30)
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
