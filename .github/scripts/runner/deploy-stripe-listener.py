#!/usr/bin/env python3
"""Deploy a PR's Stripe listener and observe the original host operation.

CI invokes this without arguments, with METAL_HOSTS (one host), METAL_USER,
JOB_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, STRIPE_WORKFLOW_CREATED_AT,
API_PREVIEW_URL, STRIPE_SECRET_KEY, and optional VERCEL_AUTOMATION_BYPASS_SECRET.
Use the guarded Cloudflare SSH setup. The selected host needs sudo, Python,
systemd and the Stripe installer's download tools. The host worker is internal.
"""

import fcntl
import hashlib
import json
import math
import os
import re
import runpy
import shlex
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

SOURCE = ".github/scripts/runner/deploy-stripe-listener.py"
RESOURCES = ".github/scripts/runner/cleanup-metal-resources.py"
INSTALLER = "e2e/scripts/ensure-stripe-cli.sh"
BUNDLE = (SOURCE, RESOURCES, INSTALLER, ".github/scripts/download-verified.sh")
EVENTS = "checkout.session.completed,invoice.paid,customer.subscription.updated,customer.subscription.deleted"
LOCK_SECONDS = 480
DEPLOY_SECONDS = 300
OBSERVE_SECONDS = 825
UNCONFIRMED_SSH_STATUSES = (124, 137, 141, 255)

SUBMIT = (
    "import json,sys,types; r=json.load(sys.stdin); m={'__name__':'stripe_submit'}; "
    "h={'__name__':'metal_resources'}; "
    f"exec(compile(r['files'][{RESOURCES!r}], '<metal resources>', 'exec'), h); "
    f"exec(compile(r['files'][{SOURCE!r}], '<stripe deployment>', 'exec'), m); "
    "m['submit'](r, sys.argv[1], types.SimpleNamespace(**h))"
)

OBSERVE = """
import json,sys,time
from pathlib import Path
def read(path):
    try:
        return (Path(sys.argv[1]) / path.lstrip('/')).read_text()
    except FileNotFoundError:
        return None
record = json.loads(read(sys.argv[2]) or 'null')
marker = None
if record:
    if record['status'] == 'pending' and time.monotonic() >= record['deadline']:
        record['status'] = 'result unavailable before the host deadline'
    elif record['status'] == 'ready':
        cutoff = read(sys.argv[4])
        if cutoff and record['generation'][0] + '\\n' <= cutoff:
            record = None
        else:
            marker = read(sys.argv[3])
print(json.dumps({'record': record, 'marker': marker}))
"""


def operation_id(request):
    return hashlib.sha256(
        json.dumps(request, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def atomic_write(path, text, mode=0o600):
    # Every writer holds its namespace or the submission lock.
    temporary = path.with_name("." + path.name + ".tmp")
    try:
        temporary.write_text(text)
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def read_record(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def validate_request(request):
    if not re.fullmatch(r"pr-[1-9][0-9]*", request["ref"]):
        raise ValueError("invalid Stripe PR namespace")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?", request["host"]):
        raise ValueError("Stripe deployment requires one Runner host")
    created, run_id, attempt = request["generation"]
    if (
        datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ").strftime("%Y-%m-%dT%H:%M:%SZ")
        != created
    ):
        raise ValueError("invalid workflow creation time")
    if any(type(value) is not int or value < 1 for value in (run_id, attempt)):
        raise ValueError("invalid workflow run or attempt")
    if set(request["files"]) != set(BUNDLE):
        raise ValueError("invalid Stripe deployment bundle")
    settings = request["settings"]
    if not re.fullmatch(r"[A-Za-z0-9_]+", settings["apiKey"]):
        raise ValueError("invalid Stripe API key format")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]+)?", settings["preview"]):
        raise ValueError("invalid Stripe preview origin")


def require_after_closure(fd, created):
    cutoff = os.pread(fd, 22, 0).decode("ascii")
    if cutoff and datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ") <= datetime.strptime(
        cutoff, "%Y-%m-%dT%H:%M:%SZ\n"
    ):
        raise RuntimeError("Stripe workflow predates PR closure")


def lifecycle_path(host, ref):
    return host.path("/var/lock") / f"vm0-runner-lifecycle-{ref}.lock"


def submit(request, root, resources):
    os.umask(0o077)
    validate_request(request)
    operation = operation_id(request)
    host = resources.Host(root)
    ref = request["ref"]
    namespace = host.path(resources.STRIPE_OPERATIONS) / ref
    record = namespace / "current.json"
    stage = namespace / operation
    generation = request["generation"]

    with host.stripe_submission_lock():
        # Read the cutoff without waiting for the namespace lock here. The
        # worker checks it again under that lock before it can mutate anything.
        lock_path = lifecycle_path(host, ref)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with resources.lifecycle_descriptor(lock_path) as fd:
            require_after_closure(fd, generation[0])
        previous = read_record(record)
        if previous and previous["generation"] >= generation:
            if previous["operation"] != operation:
                raise RuntimeError(
                    "Stripe operation superseded or has conflicting inputs"
                )
            # An earlier submission may have reached systemd. Observe it.
            print(json.dumps({"operation": operation}), flush=True)
            return
        host.remove(stage)
        stage.mkdir(parents=True)
        (stage / "settings.json").write_text(json.dumps(request["settings"]))
        for name, source in request["files"].items():
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source)
        # The launch decision precedes the first possibly ambiguous RPC.
        atomic_write(
            record,
            json.dumps(
                {
                    "operation": operation,
                    "generation": generation,
                    "status": "pending",
                    "deadline": time.monotonic() + LOCK_SECONDS + DEPLOY_SECONDS,
                }
            ),
        )
        # An unstarted predecessor can no longer be admitted. Drop its inputs
        # now. A worker that has taken them may still need its installer files.
        for path in namespace.iterdir():
            if (
                path != stage
                and path.is_dir()
                and ((path / "settings.json").exists() or not (path / SOURCE).exists())
            ):
                host.remove(path)

    try:
        subprocess.run(
            [
                "systemd-run",
                "--quiet",
                "--no-block",
                "--collect",
                "--service-type=exec",
                f"--unit=vm0-ci-stripe-{ref}-{operation}",
                f"--property=RuntimeMaxSec={LOCK_SECONDS + DEPLOY_SECONDS}s",
                "--property=TimeoutStopSec=10s",
                "--property=KillMode=control-group",
                "/usr/bin/python3",
                "-I",
                str(stage / SOURCE),
                "worker",
                str(host.root),
                ref,
                operation,
            ],
            stdin=subprocess.DEVNULL,
            check=True,
            timeout=15,
        )
    except subprocess.TimeoutExpired:
        print(
            "Stripe service submission timed out. Observing the original operation.",
            file=sys.stderr,
        )
    print(json.dumps({"operation": operation}), flush=True)


def require_current(record, operation):
    state = read_record(record)
    if not state or state["operation"] != operation or state["status"] != "pending":
        raise RuntimeError("Stripe operation is no longer current")
    return state


def install_listener(resources, host, stage, ref, settings, lock_fd):
    directory = host.path(resources.STRIPE_ROOT) / ref
    unit = f"vm0-stripe-listener-{ref}.service"
    unit_path = host.path("/etc/systemd/system") / unit
    binary = directory / "bin/stripe"
    log = directory / "stripe-listen.log"
    env_file = directory / "env"

    def manager(*args, allow_failure=False):
        return resources.command(
            "systemctl", *args, allow_failure=allow_failure, pass_fds=(lock_fd,)
        )

    manager("disable", "--no-reload", unit, allow_failure=True)
    host.remove(directory)
    directory.mkdir(parents=True)
    subprocess.run(
        ["bash", str(stage / INSTALLER)],
        env={**os.environ, "STRIPE_CLI_INSTALL_DIR": str(binary.parent)},
        check=True,
        capture_output=True,
        timeout=120,
        pass_fds=(lock_fd,),
    )
    forward_url = settings["preview"] + "/api/webhooks/stripe"
    if settings["bypass"]:
        forward_url += "?x-vercel-protection-bypass=" + quote(
            settings["bypass"], safe=""
        )
    atomic_write(
        env_file,
        f"STRIPE_API_KEY={settings['apiKey']}\nSTRIPE_FORWARD_URL={forward_url}\n",
    )
    log.touch(mode=0o600)
    atomic_write(
        unit_path,
        f"""[Unit]
Description=Okou Stripe CLI listener for {ref}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile={env_file}
WorkingDirectory={directory}
ExecStart={binary} listen --events {EVENTS} --forward-to ${{STRIPE_FORWARD_URL}}
Restart=always
RestartSec=3
StandardOutput=append:{log}
StandardError=append:{log}

[Install]
WantedBy=multi-user.target
""",
        0o644,
    )
    with host.reload_lock():
        manager("daemon-reload")
    manager("reset-failed", unit, allow_failure=True)
    try:
        manager("start", "--no-block", unit)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            # Stripe CLI also prints "Getting ready..." before authentication.
            if (
                b"Ready!" in log.read_bytes()
                and manager("is-active", "--quiet", unit, allow_failure=True).returncode
                == 0
            ):
                return directory / ".deployment"
            time.sleep(1)
        raise TimeoutError("Stripe listener did not become ready")
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        # The manager may have accepted a start even if its caller failed.
        host.stop_stripe_listener(int(ref[3:]), lock_fd)
        raise


def finish(host, stage, record, operation, status, marker=None):
    with host.stripe_submission_lock():
        host.remove(stage)
        state = read_record(record)
        if state and state["operation"] == operation and state["status"] == "pending":
            if marker is not None:
                atomic_write(marker, operation)
            atomic_write(record, json.dumps({**state, "status": status}))


def arm_deadline(deadline):
    remaining = math.ceil(deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError("Stripe deployment admission expired")
    signal.alarm(remaining)


def worker(root, ref, operation):
    os.umask(0o077)
    stage = Path(__file__).resolve().parents[3]
    resources = SimpleNamespace(**runpy.run_path(str(stage / RESOURCES)))
    host = resources.Host(root)
    record = stage.parent / "current.json"
    credentials = stage / "settings.json"
    phase = "load inputs"

    def stop(_signum, _frame):
        raise TimeoutError("Stripe deployment worker stopped")

    signal.signal(signal.SIGALRM, stop)
    signal.signal(signal.SIGTERM, stop)
    signal.alarm(LOCK_SECONDS)
    try:
        with host.stripe_submission_lock():
            state = require_current(record, operation)
            # A delayed systemd start consumes the original lock-wait budget.
            arm_deadline(state["deadline"] - DEPLOY_SECONDS)
            settings = json.loads(credentials.read_text())
            credentials.unlink()
        phase = "acquire namespace lock"
        with resources.lifecycle_descriptor(lifecycle_path(host, ref)) as lock_fd:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            arm_deadline(min(state["deadline"], time.monotonic() + DEPLOY_SECONDS))
            phase = "check admission"
            require_after_closure(lock_fd, state["generation"][0])
            with host.stripe_submission_lock():
                require_current(record, operation)
                for path in stage.parent.iterdir():
                    if path != stage and path.is_dir():
                        host.remove(path)
            phase = "retire original listener"
            host.stop_stripe_listener(int(ref[3:]), lock_fd)
            phase = "install and verify listener readiness"
            marker = install_listener(resources, host, stage, ref, settings, lock_fd)
            phase = "publish readiness"
            finish(host, stage, record, operation, "ready", marker)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        # Do not print commands, log contents or exceptions with credentials.
        print(
            f"Stripe deployment failed to {phase} ({type(error).__name__})",
            file=sys.stderr,
        )
        finish(host, stage, record, operation, "failed to " + phase)
        return 1
    finally:
        signal.alarm(0)
    return 0


def exchange(target, script, args, deadline, payload=None):
    # Include the guard's master selection/probe in the per-call deadline.
    seconds = max(1, math.ceil(min(200, deadline - time.monotonic())))
    command = shlex.join(
        ["sudo", "-n", "/usr/bin/python3", "-I", "-c", script, "/", *args]
    )
    result = subprocess.run(
        ["timeout", "--kill-after=8s", f"{seconds}s", "ssh", "-T", target, command],
        input=payload or "",
        stdout=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode in UNCONFIRMED_SSH_STATUSES:
        return result.returncode, None
    if result.returncode != 0:
        raise RuntimeError(f"Stripe host command exited {result.returncode}")
    return 0, json.loads(result.stdout)


def deploy():
    repository = Path(__file__).resolve().parents[3]
    env = os.environ
    request = {
        "ref": env["JOB_REF"],
        "host": env["METAL_HOSTS"],
        "generation": [
            env["STRIPE_WORKFLOW_CREATED_AT"],
            int(env["GITHUB_RUN_ID"]),
            int(env["GITHUB_RUN_ATTEMPT"]),
        ],
        "settings": {
            "preview": env["API_PREVIEW_URL"].rstrip("/"),
            "apiKey": env["STRIPE_SECRET_KEY"],
            "bypass": env.get("VERCEL_AUTOMATION_BYPASS_SECRET", ""),
        },
        "files": {name: (repository / name).read_text() for name in BUNDLE},
    }
    validate_request(request)
    user = env["METAL_USER"]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", user):
        raise ValueError("invalid Runner SSH user")
    resources = SimpleNamespace(**runpy.run_path(str(repository / RESOURCES)))
    ref = request["ref"]
    target = f"{user}@{request['host']}"
    operation = operation_id(request)
    deadline = time.monotonic() + OBSERVE_SECONDS
    status, ack = exchange(target, SUBMIT, [], deadline, json.dumps(request))
    if status:
        print(
            f"Stripe submission response unavailable (SSH exit {status}). Observing the original operation.",
            flush=True,
        )
    elif ack != {"operation": operation}:
        raise RuntimeError("Stripe launch identity mismatch")
    seen = status == 0
    intent_deadline = time.monotonic() + 45
    paths = [
        f"{resources.STRIPE_OPERATIONS}/{ref}/current.json",
        f"{resources.STRIPE_ROOT}/{ref}/.deployment",
        f"/var/lock/vm0-runner-lifecycle-{ref}.lock",
    ]
    while time.monotonic() < deadline:
        status, reply = exchange(target, OBSERVE, paths, deadline)
        if status:
            print(
                f"Stripe observation unavailable (SSH exit {status}). Reconnecting.",
                flush=True,
            )
        elif reply["record"] and reply["record"]["operation"] == operation:
            seen = True
            state = reply["record"]["status"]
            if state == "ready":
                if reply["marker"] != operation:
                    raise RuntimeError(
                        "Stripe receipt no longer matches the installed listener"
                    )
                print(
                    f"Stripe CLI listener is ready on {request['host']} for {ref}",
                    flush=True,
                )
                return
            if state != "pending":
                raise RuntimeError("Stripe deployment " + state)
        elif seen or (
            reply["record"] and reply["record"]["generation"] >= request["generation"]
        ):
            raise RuntimeError("Stripe operation was superseded or retired")
        elif time.monotonic() >= intent_deadline:
            raise RuntimeError("Stripe launch intent unavailable after submission")
        time.sleep(4)
    raise RuntimeError("Stripe deployment result unavailable before the deadline")


if __name__ == "__main__":
    if sys.argv[1:2] == ["worker"]:
        sys.exit(worker(*sys.argv[2:]))
    try:
        deploy()
    except (
        KeyError,
        OSError,
        RuntimeError,
        ValueError,
        subprocess.SubprocessError,
    ) as error:
        print(f"Stripe deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
