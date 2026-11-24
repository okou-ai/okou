#!/usr/bin/env python3
"""Bind a dedicated trusted worker's native agy login to a member's Okou grant."""

import argparse
import fcntl
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from antigravity_personal import MODELS, personal_environment, signed_in, verify_model

AGY = "/usr/local/bin/agy"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def binding_status(binding, *, method="GET"):
    origin = os.environ.get("OKOU_ANTIGRAVITY_API_ORIGIN", "")
    url = urlsplit(origin)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
    ):
        raise ValueError("Configure an HTTPS Okou API origin on the worker.")
    token_path = os.environ.get("OKOU_ANTIGRAVITY_M2M_TOKEN_FILE")
    if not token_path:
        raise ValueError("Configure this worker's Clerk M2M token file.")
    token = Path(token_path).read_text().strip()
    if not token:
        raise ValueError("The worker's M2M token file is empty.")
    endpoint = f"{origin.rstrip('/')}/api/internal/antigravity/subscriptions/{binding}"
    req = Request(
        endpoint + ("/confirm" if method == "POST" else ""),
        method=method,
        data=b"{}" if method == "POST" else None,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with build_opener(NoRedirect).open(req, timeout=15) as response:
            result = json.loads(response.read(8192))
    except HTTPError as error:
        raise ValueError(f"Okou rejected this binding (HTTP {error.code}).") from None
    except (URLError, TimeoutError, json.JSONDecodeError):
        raise ValueError(
            "Could not confirm the state of this binding with Okou."
        ) from None
    if method == "DELETE" and result == {"status": "disconnected"}:
        return "disconnected"
    if not isinstance(result, dict) or result.get("bindingId") != str(binding):
        raise ValueError("Okou did not return the assigned binding.")
    if result.get("status") not in ("pending", "connected"):
        raise ValueError("This binding expired or was disconnected in Okou.")
    return result["status"]


def connect(binding, record, binary=AGY):
    status = binding_status(binding)
    previous = record.read().strip()
    env = personal_environment()
    if previous and previous != str(binding):
        if status != "pending":
            raise ValueError(
                "A different binding owns this keyring. Disconnect and start sign-in again."
            )
        if not sys.stdin.isatty():
            raise ValueError(
                "Open the assigned terminal to sign in for the new binding."
            )
        # The API has one binding per machine. A newer pending ID replaces the
        # old grant, but must never inherit the Google account in its keyring.
        if signed_in(binary, env, logout=True):
            raise ValueError("The previous native Google login could not be removed.")
        record.seek(0)
        record.truncate()
        previous = ""
    active = signed_in(binary, env)
    if not previous:
        if active:
            raise ValueError(
                "A fresh keyring is required. This profile was signed in outside this binding."
            )
        if status == "connected":
            raise ValueError(
                "This worker lost its binding record. Disconnect and pair a fresh profile."
            )
        record.write(str(binding) + "\n")
        record.flush()
        os.fsync(record.fileno())
    if not active:
        if status == "connected":
            raise ValueError(
                "Native login was lost. Disconnect in Okou and pair a fresh profile."
            )
        if not sys.stdin.isatty():
            raise ValueError(
                "Open the assigned worker terminal to complete Google's sign-in."
            )
        # Google's own terminal handles the browser URL and single-use code.
        # Do not capture its output or relay the authorization code via Okou.
        with tempfile.TemporaryDirectory(prefix="agy-personal-login-") as workspace:
            subprocess.run(
                [
                    binary,
                    "acp",
                    "--login",
                    "--disable-telemetry",
                    "--log-file",
                    os.devnull,
                ],
                cwd=workspace,
                env=env,
                check=True,
                timeout=15 * 60,
            )
        if not signed_in(binary, env):
            raise ValueError(
                "The native login did not create an authenticated session."
            )
    if binding_status(binding, method="POST") != "connected":
        raise ValueError("Okou did not confirm this profile.")
    print("Google sign-in is bound to this member in Okou.")


def test_models(binding, record):
    if record.read().strip() != str(binding):
        raise ValueError("This keyring belongs to a different binding.")
    env = personal_environment()
    failures = []
    for model in MODELS:
        if binding_status(binding) != "connected":
            raise ValueError("Complete Google sign-in first.")
        with tempfile.TemporaryDirectory(prefix="agy-subscription-check-") as directory:
            try:
                verify_model(AGY, model, env, directory)
            except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
                failures.append(model)
                print(f"{model}: could not complete the CLI check.", flush=True)
                continue
            except ValueError as error:
                failures.append(model)
                print(f"{model}: {error}", flush=True)
                continue
        print(f"{model}: OK", flush=True)
    if failures:
        raise ValueError("Model verification failed for " + ", ".join(failures) + ".")
    print("Check the plan and quota for this account in Google Antigravity.")


def logout(binding, record):
    if record.read().strip() != str(binding):
        raise ValueError("This keyring belongs to a different binding.")
    if binding_status(binding, method="DELETE") != "disconnected":
        raise ValueError("Okou could not disconnect this binding.")
    if signed_in(AGY, personal_environment(), logout=True):
        raise ValueError("The native Google session is still signed in.")
    record.seek(0)
    record.truncate()
    record.flush()
    os.fsync(record.fileno())
    print("Okou binding disconnected and native Google login removed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", nargs="?", default="connect", choices=["connect", "verify", "logout"]
    )
    parser.add_argument(
        "binding_id", type=UUID, help="Current ID from Okou subscription connect"
    )
    original_command = os.environ.get("SSH_ORIGINAL_COMMAND")
    args = parser.parse_args(
        original_command.split() if original_command is not None else None
    )
    # This directory belongs to the dedicated worker OS account. Never mount
    # its home, state directory or desktop bus in a job workspace.
    state = (
        Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
        / "okou/antigravity"
    )
    try:
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(
            state / "binding",
            "a+",
            encoding="ascii",
            opener=lambda p, f: os.open(p, f, 0o600),
        ) as record:
            fcntl.flock(record, fcntl.LOCK_EX | fcntl.LOCK_NB)
            record.seek(0)
            if args.action == "logout":
                logout(args.binding_id, record)
            elif args.action == "verify":
                test_models(args.binding_id, record)
            else:
                connect(args.binding_id, record)
    except BlockingIOError:
        parser.exit(1, "Another sign-in is active on this worker.\n")
    except (subprocess.SubprocessError, OSError):
        parser.exit(1, "The trusted worker could not finish native sign-in.\n")
    except (ValueError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
