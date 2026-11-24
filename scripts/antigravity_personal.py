"""Trusted worker operations for the pinned Google Antigravity CLI."""

import asyncio
import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path

# Keep the native keyring, terminal and browser session. Provider and Okou
# credentials inherited by the parent process never belong in the CLI child.
SESSION_ENV = (
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SSH_TTY",
    "SSH_CONNECTION",
)
NATIVE_LOGIN_FILE = Path(".gemini/antigravity-cli/antigravity-oauth-token")


def personal_environment():
    """Select the provisioned file profile or the existing native OS session."""
    profile = os.environ.get("OKOU_ANTIGRAVITY_FILE_HOME")
    if profile is None:
        env = {key: os.environ[key] for key in SESSION_ENV if key in os.environ}
    else:
        home = Path(profile)
        if not home.is_absolute() or home.resolve() != home:
            raise ValueError("Configure a private absolute Antigravity file home.")
        metadata = home.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
        ):
            raise ValueError("The Antigravity file home must be private to its owner.")
        # Only the trusted launcher chooses this mount. A clean headless session
        # keeps auth in agy's private home instead of another user's desktop bus.
        env = {
            "HOME": str(home),
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "TERM": os.environ.get("TERM", "dumb"),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_STATE_HOME": str(home / ".local/state"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_RUNTIME_DIR": str(home / ".run"),
        }
        runtime = home / ".run"
        runtime.mkdir(mode=0o700, exist_ok=True)
        runtime_stat = runtime.lstat()
        if (
            not stat.S_ISDIR(runtime_stat.st_mode)
            or runtime_stat.st_uid != os.geteuid()
            or runtime_stat.st_mode & 0o077
            or os.path.lexists(runtime / "bus")
        ):
            raise ValueError(
                "The Antigravity file profile must not share a session bus."
            )
        check_native_login_file(home, required=False)
    env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true"
    return env


async def _call(process, seq, method, params):
    request = {"jsonrpc": "2.0", "id": seq, "method": method, "params": params}
    process.stdin.write((json.dumps(request) + "\n").encode())
    await process.stdin.drain()
    while True:
        line = await process.stdout.readline()
        if not line:
            raise ValueError("The Antigravity protocol ended early.")
        message = json.loads(line)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            raise ValueError("Invalid Antigravity protocol response.")
        if "method" in message:
            if "id" in message:
                # This probe has no editor, filesystem, terminal or approval capabilities.
                raise ValueError(
                    "Antigravity requested an unexpected client operation."
                )
            continue
        if type(message.get("id")) is not int or message["id"] != seq:
            raise ValueError("Unexpected Antigravity response ID.")
        return message


async def _probe(binary, env, directory, logout):
    process = await asyncio.create_subprocess_exec(
        binary,
        "acp",
        "--stdio",
        "--disable-telemetry",
        "--include-default-customizations=false",
        "--log-file",
        os.devnull,
        cwd=directory,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=512 * 1024,
    )
    try:
        async with asyncio.timeout(20):
            initialized = await _call(
                process,
                1,
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                },
            )
            info = initialized.get("result") or {}
            if info.get("protocolVersion") != 1 or not any(
                method.get("id") == "oauth-personal"
                for method in info.get("authMethods", [])
            ):
                raise ValueError(
                    "This agy version does not advertise personal Google sign-in."
                )
            if logout:
                auth = info.get("agentCapabilities", {}).get("auth", {})
                if "logout" not in auth:
                    raise ValueError("This agy version does not support native logout.")
                response = await _call(process, 2, "logout", {})
                if "result" not in response or "error" in response:
                    raise ValueError("Native Antigravity logout did not complete.")
            response = await _call(
                process, 3, "session/new", {"cwd": directory, "mcpServers": []}
            )
            error = response.get("error") or {}
            if (
                error.get("code") == -32000
                and error.get("message") == "Authentication required"
            ):
                return False
            result = response.get("result") or {}
            if not isinstance(result.get("sessionId"), str) or not result["sessionId"]:
                raise ValueError("Antigravity could not verify the signed-in profile.")
            session = info.get("agentCapabilities", {}).get("sessionCapabilities", {})
            if "close" in session:
                closed = await _call(
                    process, 4, "session/close", {"sessionId": result["sessionId"]}
                )
                if "result" not in closed or "error" in closed:
                    raise ValueError(
                        "Antigravity could not close the verification session."
                    )
            return True
    finally:
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except TimeoutError:
            process.kill()
            await process.wait()


def check_native_login_file(home, *, required):
    """Check metadata only; agy is the only component that handles the contents."""
    profile = home / NATIVE_LOGIN_FILE
    if profile.resolve() != profile:
        raise ValueError("The native Antigravity login file must stay in its profile.")
    try:
        metadata = profile.lstat()
    except FileNotFoundError:
        if required:
            raise
        return
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_mode & 0o077
        or metadata.st_nlink != 1
        or not metadata.st_size
    ):
        raise ValueError(
            "The native Antigravity login file must be private and nonempty."
        )


def signed_in(binary, env, *, logout=False):
    """Open and close an empty native session without sending an inference prompt."""
    with tempfile.TemporaryDirectory(prefix="agy-personal-session-") as directory:
        try:
            active = asyncio.run(_probe(binary, env, directory, logout))
            if os.environ.get("OKOU_ANTIGRAVITY_FILE_HOME") is not None:
                home = Path(env["HOME"])
                if active:
                    check_native_login_file(home, required=True)
                elif logout and os.path.lexists(home / NATIVE_LOGIN_FILE):
                    raise ValueError("Native logout left a login file on the worker.")
            return active
        except (
            TimeoutError,
            OSError,
            ValueError,
            KeyError,
            TypeError,
            AttributeError,
        ) as exc:
            # Never print raw CLI replies, source files or provider error bodies.
            raise RuntimeError(
                "Could not verify the personal Google session with agy ACP."
            ) from exc


MODELS = ("gemini-4-neon-medium", "gemini-4-carbon-medium", "gemini-4-hydrogen-medium")
SETTINGS = {
    "modelProvider": "",
    "useG1Credits": False,
    "allowNonWorkspaceAccess": False,
    "toolPermission": "strict",
    "permissions": {
        "deny": [
            "command(*)",
            "read_file(*)",
            "write_file(*)",
            "read_url(*)",
            "execute_url(*)",
            "mcp(*)",
        ]
    },
}


def verify_model(agy, model, environment, directory):
    # The acceptance prompt can run on the member's trusted login worker.
    # Deny every native and MCP tool, including tools added by future releases.
    hooks = Path(directory) / ".agents"
    hooks.mkdir(mode=0o700)
    deny = """echo '{"decision":"deny","reason":"This sign-in check does not run tools."}'"""
    policy = {
        "okou-sign-in-check": {
            "PreToolUse": [
                {"matcher": ".*", "hooks": [{"type": "command", "command": deny}]}
            ]
        }
    }
    (hooks / "hooks.json").write_text(json.dumps(policy), encoding="utf-8")
    result = subprocess.run(
        [
            agy,
            "--model",
            model,
            "--settings",
            json.dumps(SETTINGS),
            "--disable-slash-commands",
            "--log-file",
            os.devnull,
            "--print-timeout",
            "45s",
            "--output-format",
            "stream-json",
            "-p",
            "Reply with OK only. Use no tools.",
        ],
        cwd=directory,
        env=environment,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    # Only print fixed diagnostics. Raw CLI output may identify the account.
    if result.returncode != 0:
        diagnostic = (result.stdout + result.stderr).casefold()
        if any(
            term in diagnostic
            for term in (
                "unauthenticated",
                "authentication required",
                "not authenticated",
                "not logged in",
            )
        ):
            raise ValueError("Sign in with interactive agy on this machine first.")
        if any(
            term in diagnostic
            for term in ("resource_exhausted", "quota exhausted", "rate limit")
        ):
            raise ValueError("The CLI reported a quota or rate limit.")
        raise ValueError(f"agy exited with status {result.returncode}.")
    events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    if not events or any(not isinstance(event, dict) for event in events):
        raise ValueError("No valid CLI event stream.")
    if any(
        event.get("event") == "step_update"
        and isinstance(event.get("step_update"), dict)
        and event["step_update"].get("step_type") == "tool"
        for event in events
    ):
        raise ValueError("The CLI attempted to use a tool during the sign-in check.")
    starts = [event for event in events if event.get("event") == "init"]
    ends = [event for event in events if event.get("event") == "result"]
    if len(starts) != 1 or len(ends) != 1 or events[-1] is not ends[0]:
        raise ValueError("Expected one initialization and one final result.")
    init = starts[0].get("init") or {}
    final = ends[0].get("result") or {}
    if not isinstance(init, dict) or init.get("model") != model:
        raise ValueError("The CLI selected a different model.")
    if not isinstance(final, dict) or final.get("status") != "SUCCESS":
        raise ValueError("The CLI did not complete the turn.")
    if not starts[0].get("conversation_id") or starts[0][
        "conversation_id"
    ] != final.get("conversation_id"):
        raise ValueError("The CLI result belongs to a different conversation.")
    if str(final.get("response", "")).strip() != "OK":
        raise ValueError("The CLI did not return the requested response.")


def verify_models(agy, environment, *, before_model=None):
    """Check each pilot model once. Recheck the binding immediately before each prompt."""
    failures = []
    for model in MODELS:
        if before_model is not None:
            before_model()
        with tempfile.TemporaryDirectory(prefix="agy-subscription-check-") as directory:
            try:
                verify_model(agy, model, environment, directory)
            except subprocess.TimeoutExpired:
                problem = "The CLI timed out."
            except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
                problem = "Could not complete the CLI check."
            except ValueError as error:
                problem = str(error)
            else:
                print(f"{model}: OK", flush=True)
                continue
            failures.append(model)
            print(f"{model}: {problem}", flush=True)
    if failures:
        raise ValueError("Model verification failed for " + ", ".join(failures) + ".")
    print("Check the plan and quota for this account in Google Antigravity.")
