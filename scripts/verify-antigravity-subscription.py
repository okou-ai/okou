#!/usr/bin/env python3
"""Run one fixed, quota-consuming agy prompt per pilot model on the member's own signed-in machine."""

import argparse
import json
import shutil
import subprocess
import tempfile

from antigravity_personal import MODELS, personal_environment, signed_in, verify_model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check-login",
        action="store_true",
        help="Check the native login without sending a model prompt",
    )
    options = parser.parse_args()
    agy = shutil.which("agy")
    if not agy:
        parser.exit(
            1, "Install the official agy CLI and sign in interactively first.\n"
        )
    environment = personal_environment()
    if options.check_login:
        try:
            active = signed_in(agy, environment)
        except RuntimeError as error:
            parser.exit(1, f"{error}\n")
        if not active:
            parser.exit(
                1, "Sign-in required. Use the official Google login on this profile.\n"
            )
        print(
            "Native Google login verified. Model access and subscription quota still need a model test."
        )
        return
    for model in MODELS:
        with tempfile.TemporaryDirectory(prefix="agy-member-test-") as directory:
            try:
                verify_model(agy, model, environment, directory)
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
