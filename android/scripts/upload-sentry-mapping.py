"""Upload the R8 mapping under the debug UUID embedded in the release APK."""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
from uuid import UUID
import zipfile

from release_mapping import read_release_mapping


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("mapping", type=Path)
    parser.add_argument("--cli", default="sentry-cli")
    args = parser.parse_args()
    for name in ("SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"):
        if not os.environ.get(name):
            parser.error(f"{name} is required for Android mapping upload")

    mapping, _, _ = read_release_mapping(args.apk, args.mapping)
    with zipfile.ZipFile(args.apk) as archive:
        properties = archive.read("assets/sentry-debug-meta.properties").decode("ascii")
    prefix = "io.sentry.ProguardUuids="
    identifiers = [
        line.removeprefix(prefix) for line in properties.splitlines() if line.startswith(prefix)
    ]
    if len(identifiers) != 1:
        parser.error("The APK must contain exactly one Sentry mapping UUID")
    identifier = UUID(identifiers[0])
    with tempfile.TemporaryDirectory(prefix="okou-sentry-mapping-") as directory:
        mapping_path = Path(directory) / "mapping.txt"
        mapping_path.write_bytes(mapping)
        subprocess.run(
            [args.cli, "upload-proguard", "--require-one", "--uuid", str(identifier), str(mapping_path)],
            check=True,
            timeout=180,
        )
    print(f"Uploaded Android R8 mapping {identifier} to Sentry")


if __name__ == "__main__":
    main()
