#!/usr/bin/env python3
"""Fetch and verify the pinned PWA model before an offline-capable iOS build.

Run from any directory, before opening Xcode. CI test/archive preparation calls
this too. --manifest selects a resource manifest; the model is written beside
it. A verified existing model needs no network. Failure leaves no new model.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request


def main():
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
    request = urllib.request.Request(
        manifest["url"],
        headers={"User-Agent": "Okou-iOS-model-preparation/1", "Accept": "application/octet-stream"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(manifest["size"] + 1)
    if not verified(data):
        raise ValueError("Downloaded voice activity model failed size/SHA-256 verification")
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as staged:
        staged_path = Path(staged.name)
        try:
            staged.write(data)
            staged.close()
            staged_path.chmod(0o644)
            os.replace(staged_path, output)
        finally:
            staged_path.unlink(missing_ok=True)
    print(output)


if __name__ == "__main__":
    main()
