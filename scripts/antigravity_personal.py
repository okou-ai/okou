"""Trusted worker operations for the pinned Google Antigravity CLI."""

import asyncio
import json
import os
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


def personal_environment():
    env = {key: os.environ[key] for key in SESSION_ENV if key in os.environ}
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


def signed_in(binary, env, *, logout=False):
    """Open and close an empty native session without sending an inference prompt."""
    with tempfile.TemporaryDirectory(prefix="agy-personal-session-") as directory:
        try:
            return asyncio.run(_probe(binary, env, directory, logout))
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
