#!/usr/bin/env python3
"""Fetch and verify the pinned PWA model before an offline-capable iOS build.

Run from any directory, before opening Xcode. CI test/archive preparation calls
this too. Requires Python 3 and curl. --manifest selects a resource manifest;
the model is written beside it. A verified existing model needs no network.
Failure leaves no new model. Downloads use HTTPS (or a loopback HTTP fixture).
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import urllib.parse


def main():
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "Okou/Resources/VoiceActivity/model.json",
    )
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    name = manifest["filename"]
    if Path(name).name != name or not name.endswith(".onnx"):
        raise ValueError("The model filename must be a single .onnx filename")
    output = args.manifest.parent / name

    def verified(data):
        return (
            len(data) == manifest["size"]
            and hashlib.sha256(data).hexdigest() == manifest["sha256"]
        )

    if output.exists():
        if not verified(output.read_bytes()):
            raise ValueError(f"Model checksum mismatch: remove {output} and prepare again")
        output.chmod(0o644)
        print(output)
        return

    # Bound the download, verify before publishing, and keep the final source
    # file atomic. Xcode explicitly requires this resource during its build.
    source = urllib.parse.urlsplit(manifest["url"])
    if source.scheme != "https" and not (
        source.scheme == "http" and source.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise ValueError("Model downloads require HTTPS or loopback HTTP")
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as staged:
        staged_path = Path(staged.name)
        try:
            subprocess.run(
                ["curl", "--fail", "--location", "--silent", "--show-error",
                 "--proto", "=https,http", "--proto-redir", "=https",
                 "--max-time", "60", "--max-filesize", str(manifest["size"]),
                 "--user-agent", "Okou-iOS-model-preparation/1",
                 "--url", manifest["url"]],
                stdout=staged,
                timeout=65,
                check=True,
            )
            staged.seek(0)
            if not verified(staged.read(manifest["size"] + 1)):
                raise ValueError("Downloaded voice activity model failed size/SHA-256 verification")
            staged.close()
            staged_path.chmod(0o644)
            os.replace(staged_path, output)
        finally:
            staged_path.unlink(missing_ok=True)
    print(output)


if __name__ == "__main__":
    main()
