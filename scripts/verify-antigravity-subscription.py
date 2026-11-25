#!/usr/bin/env python3
"""Run one fixed, quota-consuming agy prompt per pilot model on the member's own signed-in machine."""

import argparse
import os
import shutil

from antigravity_personal import personal_environment, signed_in, verify_models


def main():
    os.umask(0o077)
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
    try:
        environment = personal_environment()
    except (OSError, ValueError):
        parser.exit(
            1, "The configured native Google profile is unavailable or unsafe.\n"
        )
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
    try:
        verify_models(agy, environment)
    except ValueError as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
