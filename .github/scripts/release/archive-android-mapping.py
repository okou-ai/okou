"""Archive the versioned gzip mapping before making its APK discoverable.

Usage: archive-android-mapping.py TAG MAPPING.txt.gz
Requires GH_TOKEN and GITHUB_REPOSITORY. Accept an existing asset only when
GitHub's stored SHA-256 matches. Read back an uncertain upload; never replay it.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def archive(tag, mapping):
    repository = os.environ["GITHUB_REPOSITORY"]
    expected = "sha256:" + hashlib.sha256(mapping.read_bytes()).hexdigest()

    def stored():
        release = json.loads(subprocess.check_output(
            ["gh", "api", f"repos/{repository}/releases/tags/{tag}"], text=True, timeout=60,
        ))
        return next((asset for asset in release["assets"] if asset["name"] == mapping.name), None)

    asset = stored()
    if asset is None:
        # A nonzero result can follow a committed upload. Its readback decides
        # whether publication may continue, without a second upload or clobber.
        try:
            subprocess.run(["gh", "release", "upload", tag, str(mapping), "--repo", repository],
                           check=False, timeout=120)
        except subprocess.TimeoutExpired:
            pass  # Resolve the uncertain result through the same stored-asset readback.
        asset = stored()
    if asset is None or asset.get("digest") != expected:
        raise RuntimeError("Android mapping archive could not be verified; update publication is blocked")
    print(f"Android mapping archived: {mapping.name}; {expected}")


if __name__ == "__main__":
    archive(sys.argv[1], Path(sys.argv[2]))
