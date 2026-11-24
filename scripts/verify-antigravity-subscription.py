#!/usr/bin/env python3
"""Run one fixed, quota-consuming agy prompt per pilot model on the member's own signed-in machine."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile

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


def verify(agy, model, environment, directory):
    result = subprocess.run(
        [
            agy,
            "--model",
            model,
            "--settings",
            json.dumps(SETTINGS),
            "--disable-slash-commands",
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    agy = shutil.which("agy")
    if not agy:
        parser.exit(
            1, "Install the official agy CLI and sign in interactively first.\n"
        )
    environment = os.environ.copy()
    for name in (
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GEMINI_BASE_URL",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_GENAI_USE_VERTEXAI",
    ):
        environment.pop(name, None)
    environment["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true"
    for model in MODELS:
        with tempfile.TemporaryDirectory(prefix="agy-member-test-") as directory:
            try:
                verify(agy, model, environment, directory)
            except json.JSONDecodeError:
                parser.exit(1, f"{model}: agy returned malformed JSON.\n")
            except subprocess.TimeoutExpired:
                parser.exit(
                    1,
                    f"{model}: timed out; confirm that interactive agy is signed in before retrying.\n",
                )
            except OSError:
                parser.exit(1, f"{model}: could not start agy.\n")
            except ValueError as error:
                parser.exit(1, f"{model}: {error}\n")
        print(f"{model}: OK", flush=True)
    print("Verify the account's plan and quota separately in Google Antigravity.")


if __name__ == "__main__":
    main()
